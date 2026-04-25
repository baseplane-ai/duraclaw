"""Decision-log replay — score a candidate routing policy against
historical traffic without paying live tokens.

Pipeline:

  decisions.ndjson   →   load_decisions()       →   list[dict]
                                                        │
                          (one tick of the agent loop)  │
                                                        ▼
                         apply_policy_overrides()    list[dict]   (candidate)
                                                        │
                                                        ▼
                         compute_summary()      → SummaryStats   (baseline)
                                                  SummaryStats   (candidate)
                                                        │
                                                        ▼
                         diff_summaries()       → SummaryDiff
                                                        │
                                                        ▼
                         render_text_report()   → str

The policy schema (TOML, see `tests/test_replay.py` for a fixture):

  [tier_remap]
  # If the baseline tier was X, treat the candidate as having routed Y.
  HARD   = "MEDIUM"

  [model_overrides]
  # If the candidate tier resolves to X, charge as if model Y had served
  # the request (used to model "what if we routed all MEDIUM to a
  # cheaper sonnet variant?").
  MEDIUM = "claude-sonnet-4-6-cheap"

`apply_policy_overrides` is intentionally cheap and does NOT re-run the
classifier — that's a follow-up. The point of this module is to score
SHAPE-of-routing policies (tier swaps, model swaps), not to replay
classification.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator


@dataclass
class TierBreakdown:
    count: int = 0
    total_cost_usd: float = 0.0


@dataclass
class SummaryStats:
    record_count: int = 0
    total_cost_usd: float = 0.0
    by_tier: dict[str, TierBreakdown] = field(default_factory=dict)
    by_model: dict[str, int] = field(default_factory=dict)
    cache_hit_input_tokens: int = 0
    total_input_tokens: int = 0

    @property
    def cache_hit_ratio(self) -> float:
        return (
            self.cache_hit_input_tokens / self.total_input_tokens
            if self.total_input_tokens > 0
            else 0.0
        )


@dataclass
class TierDelta:
    baseline_count: int
    candidate_count: int
    delta_count: int
    delta_cost_usd: float


@dataclass
class SummaryDiff:
    baseline_cost_usd: float
    candidate_cost_usd: float
    delta_cost_usd: float
    delta_cost_pct: float
    by_tier: dict[str, TierDelta]


def load_decisions(path: str | os.PathLike[str]) -> Iterator[dict[str, Any]]:
    """Stream a decisions NDJSON file as parsed dicts.

    Tolerates blank lines (so a file written by `NDJSONDecisionSink` and
    accidentally `cat`-ed with a trailing newline still parses). Lines
    that don't parse as JSON raise — corrupt input shouldn't be papered
    over silently.
    """
    p = Path(path)
    with p.open("r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            yield json.loads(line)


def _coerce_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _coerce_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def compute_summary(decisions: Iterable[dict[str, Any]]) -> SummaryStats:
    out = SummaryStats()
    for d in decisions:
        out.record_count += 1
        cost = _coerce_float(d.get("actual_cost"))
        if cost == 0.0:
            cost = _coerce_float(d.get("estimated_cost"))
        out.total_cost_usd += cost

        tier = str(d.get("tier") or "").strip().upper() or "UNKNOWN"
        bucket = out.by_tier.setdefault(tier, TierBreakdown())
        bucket.count += 1
        bucket.total_cost_usd += cost

        model = str(d.get("model") or "").strip() or "unknown"
        out.by_model[model] = out.by_model.get(model, 0) + 1

        cached = _coerce_int(d.get("cache_read_input_tokens"))
        total_in = (
            _coerce_int(d.get("usage_input_tokens"))
            + cached
            + _coerce_int(d.get("cache_write_input_tokens"))
        )
        out.cache_hit_input_tokens += cached
        out.total_input_tokens += total_in
    return out


def apply_policy_overrides(
    decisions: Iterable[dict[str, Any]],
    policy: dict[str, Any],
) -> Iterator[dict[str, Any]]:
    """Yield candidate-shaped decisions after applying `policy`.

    Supported keys:
      - `tier_remap`     : {old_tier: new_tier}
      - `model_overrides`: {tier: replacement_model_name}

    Costs are NOT recomputed — the candidate inherits the baseline cost
    by default. A future version will plug in the router's pricing
    table; for now this scores the *shape* of the routing change. Use
    `cost_overrides` to override per tier when you have a price map:
      - `cost_overrides` : {tier: scalar_multiplier}   # e.g. 0.5 = 50% off
    """
    tier_remap = policy.get("tier_remap") or {}
    model_overrides = policy.get("model_overrides") or {}
    cost_overrides = policy.get("cost_overrides") or {}

    # Normalise tier-keyed maps to upper-case for case-insensitive matches.
    tier_remap = {str(k).upper(): str(v).upper() for k, v in tier_remap.items()}
    model_overrides = {str(k).upper(): str(v) for k, v in model_overrides.items()}
    cost_overrides = {str(k).upper(): float(v) for k, v in cost_overrides.items()}

    for d in decisions:
        new = dict(d)
        original_tier = str(new.get("tier") or "").strip().upper()
        candidate_tier = tier_remap.get(original_tier, original_tier)
        new["tier"] = candidate_tier

        if candidate_tier in model_overrides:
            new["model"] = model_overrides[candidate_tier]

        multiplier = cost_overrides.get(candidate_tier)
        if multiplier is not None:
            for cost_field in ("actual_cost", "estimated_cost"):
                value = new.get(cost_field)
                if value is None:
                    continue
                new[cost_field] = _coerce_float(value) * multiplier

        yield new


def diff_summaries(baseline: SummaryStats, candidate: SummaryStats) -> SummaryDiff:
    delta_cost = candidate.total_cost_usd - baseline.total_cost_usd
    pct = (delta_cost / baseline.total_cost_usd * 100.0) if baseline.total_cost_usd > 0 else 0.0

    tiers = sorted(set(baseline.by_tier.keys()) | set(candidate.by_tier.keys()))
    by_tier: dict[str, TierDelta] = {}
    for t in tiers:
        b = baseline.by_tier.get(t, TierBreakdown())
        c = candidate.by_tier.get(t, TierBreakdown())
        by_tier[t] = TierDelta(
            baseline_count=b.count,
            candidate_count=c.count,
            delta_count=c.count - b.count,
            delta_cost_usd=c.total_cost_usd - b.total_cost_usd,
        )

    return SummaryDiff(
        baseline_cost_usd=baseline.total_cost_usd,
        candidate_cost_usd=candidate.total_cost_usd,
        delta_cost_usd=delta_cost,
        delta_cost_pct=pct,
        by_tier=by_tier,
    )


def render_text_report(diff: SummaryDiff, baseline: SummaryStats, candidate: SummaryStats) -> str:
    lines: list[str] = []
    lines.append(f"records:                 {baseline.record_count}")
    lines.append(
        f"baseline cost:           ${baseline.total_cost_usd:.4f}   "
        f"(cache hit ratio {baseline.cache_hit_ratio:.1%})",
    )
    lines.append(
        f"candidate cost:          ${candidate.total_cost_usd:.4f}   "
        f"(cache hit ratio {candidate.cache_hit_ratio:.1%})",
    )
    sign = "+" if diff.delta_cost_usd >= 0 else "−"
    lines.append(
        f"Δ cost:                  {sign}${abs(diff.delta_cost_usd):.4f}   "
        f"({diff.delta_cost_pct:+.1f}%)",
    )
    lines.append("")
    lines.append("tier distribution (baseline → candidate):")
    for tier, td in diff.by_tier.items():
        lines.append(
            f"  {tier:<10} {td.baseline_count:>5} → {td.candidate_count:>5}   "
            f"(Δ {td.delta_count:+d}, Δ cost ${td.delta_cost_usd:+.4f})",
        )
    return "\n".join(lines)


def load_policy(path: str | os.PathLike[str]) -> dict[str, Any]:
    """Load a TOML routing policy. tomllib lives in stdlib from py 3.11."""
    import tomllib

    with Path(path).open("rb") as fh:
        return tomllib.load(fh)
