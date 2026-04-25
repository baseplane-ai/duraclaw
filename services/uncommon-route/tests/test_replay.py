"""Tests for uncommon_route.replay (the decision-stream replay CLI).

The pipeline under test mirrors what an autoresearch loop does:

  decisions.ndjson  →  load  →  compute_summary  →  baseline
                              \
                               → apply_policy_overrides  →  compute_summary  →  candidate
                                                            diff_summaries(b, c)
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from uncommon_route.replay import (
    SummaryStats,
    apply_policy_overrides,
    compute_summary,
    diff_summaries,
    load_decisions,
    load_policy,
    render_text_report,
)


def _decision(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "request_id": "r-1",
        "tier": "MEDIUM",
        "model": "claude-sonnet-4-6",
        "estimated_cost": 0.01,
        "actual_cost": 0.012,
        "usage_input_tokens": 1000,
        "cache_read_input_tokens": 0,
        "cache_write_input_tokens": 0,
    }
    base.update(overrides)
    return base


class TestLoadDecisions:
    def test_streams_lines_as_dicts(self, tmp_path: Path) -> None:
        path = tmp_path / "d.ndjson"
        path.write_text(
            json.dumps(_decision(request_id="a")) + "\n"
            + json.dumps(_decision(request_id="b", tier="HARD")) + "\n",
        )
        out = list(load_decisions(path))
        assert [d["request_id"] for d in out] == ["a", "b"]

    def test_skips_blank_lines(self, tmp_path: Path) -> None:
        path = tmp_path / "d.ndjson"
        path.write_text(
            "\n"
            + json.dumps(_decision(request_id="a")) + "\n"
            + "\n\n"
            + json.dumps(_decision(request_id="b")) + "\n",
        )
        out = list(load_decisions(path))
        assert len(out) == 2

    def test_raises_on_corrupt_line(self, tmp_path: Path) -> None:
        path = tmp_path / "d.ndjson"
        path.write_text("{not json\n")
        with pytest.raises(json.JSONDecodeError):
            list(load_decisions(path))


class TestComputeSummary:
    def test_aggregates_record_count_cost_and_tier_distribution(self) -> None:
        decisions = [
            _decision(tier="EASY", actual_cost=0.001),
            _decision(tier="EASY", actual_cost=0.002),
            _decision(tier="HARD", actual_cost=0.05),
        ]
        s = compute_summary(decisions)
        assert s.record_count == 3
        assert s.total_cost_usd == pytest.approx(0.053)
        assert s.by_tier["EASY"].count == 2
        assert s.by_tier["EASY"].total_cost_usd == pytest.approx(0.003)
        assert s.by_tier["HARD"].count == 1

    def test_falls_back_to_estimated_cost_when_actual_is_zero(self) -> None:
        s = compute_summary([_decision(actual_cost=0, estimated_cost=0.04)])
        assert s.total_cost_usd == pytest.approx(0.04)

    def test_cache_hit_ratio(self) -> None:
        s = compute_summary(
            [
                _decision(usage_input_tokens=200, cache_read_input_tokens=800),
                _decision(usage_input_tokens=1000, cache_read_input_tokens=0),
            ]
        )
        # total = (200 + 800 + 0) + (1000 + 0 + 0) = 2000;  cached = 800
        assert s.total_input_tokens == 2000
        assert s.cache_hit_input_tokens == 800
        assert s.cache_hit_ratio == pytest.approx(800 / 2000)

    def test_unknown_tier_collapsed_to_unknown_bucket(self) -> None:
        s = compute_summary([_decision(tier="")])
        assert s.by_tier["UNKNOWN"].count == 1


class TestApplyPolicyOverrides:
    def test_no_overrides_yields_identical_records(self) -> None:
        baseline = [_decision(request_id="a"), _decision(request_id="b", tier="HARD")]
        candidate = list(apply_policy_overrides(baseline, {}))
        assert [c["tier"] for c in candidate] == ["MEDIUM", "HARD"]
        assert [c["model"] for c in candidate] == [
            "claude-sonnet-4-6",
            "claude-sonnet-4-6",
        ]

    def test_tier_remap_swaps_tiers_case_insensitively(self) -> None:
        baseline = [_decision(tier="HARD")]
        candidate = list(apply_policy_overrides(baseline, {"tier_remap": {"hard": "medium"}}))
        assert candidate[0]["tier"] == "MEDIUM"

    def test_model_overrides_apply_after_tier_remap(self) -> None:
        baseline = [_decision(tier="HARD")]
        policy = {
            "tier_remap": {"HARD": "MEDIUM"},
            "model_overrides": {"MEDIUM": "claude-sonnet-4-6-cheap"},
        }
        candidate = list(apply_policy_overrides(baseline, policy))
        assert candidate[0]["model"] == "claude-sonnet-4-6-cheap"

    def test_cost_overrides_scale_actual_and_estimated_cost(self) -> None:
        baseline = [_decision(tier="HARD", actual_cost=0.10, estimated_cost=0.08)]
        candidate = list(
            apply_policy_overrides(baseline, {"cost_overrides": {"HARD": 0.5}}),
        )
        assert candidate[0]["actual_cost"] == pytest.approx(0.05)
        assert candidate[0]["estimated_cost"] == pytest.approx(0.04)

    def test_does_not_mutate_input_records(self) -> None:
        baseline = [_decision(tier="HARD")]
        list(apply_policy_overrides(baseline, {"tier_remap": {"HARD": "MEDIUM"}}))
        assert baseline[0]["tier"] == "HARD"


class TestDiffSummaries:
    def test_delta_cost_pct_and_per_tier_breakdown(self) -> None:
        decisions = [
            _decision(tier="HARD", actual_cost=0.10),
            _decision(tier="HARD", actual_cost=0.10),
        ]
        baseline = compute_summary(decisions)
        candidate = compute_summary(
            list(
                apply_policy_overrides(
                    decisions,
                    {"tier_remap": {"HARD": "MEDIUM"}, "cost_overrides": {"MEDIUM": 0.5}},
                )
            )
        )
        diff = diff_summaries(baseline, candidate)
        assert diff.delta_cost_usd == pytest.approx(-0.10)
        assert diff.delta_cost_pct == pytest.approx(-50.0)
        assert diff.by_tier["HARD"].delta_count == -2
        assert diff.by_tier["MEDIUM"].delta_count == 2

    def test_zero_baseline_cost_yields_zero_pct(self) -> None:
        baseline = SummaryStats()
        candidate = SummaryStats()
        candidate.total_cost_usd = 0.0
        diff = diff_summaries(baseline, candidate)
        assert diff.delta_cost_pct == 0.0


class TestRenderTextReport:
    def test_emits_summary_lines(self) -> None:
        decisions = [_decision(tier="HARD", actual_cost=0.10)]
        baseline = compute_summary(decisions)
        candidate = compute_summary(
            list(apply_policy_overrides(decisions, {"cost_overrides": {"HARD": 0.5}}))
        )
        report = render_text_report(diff_summaries(baseline, candidate), baseline, candidate)
        assert "records:" in report
        assert "baseline cost:" in report
        assert "candidate cost:" in report
        assert "tier distribution" in report


class TestLoadPolicy:
    def test_parses_toml(self, tmp_path: Path) -> None:
        path = tmp_path / "policy.toml"
        path.write_text(
            """
[tier_remap]
HARD = "MEDIUM"

[cost_overrides]
MEDIUM = 0.5
""".strip()
        )
        policy = load_policy(path)
        assert policy["tier_remap"] == {"HARD": "MEDIUM"}
        assert policy["cost_overrides"] == {"MEDIUM": 0.5}
