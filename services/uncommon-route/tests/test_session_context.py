"""Tests for the session-aware routing headers.

Covers `_resolve_session_context`, the per-field coercers, and the
`_session_extras` helper that spreads into `RouteRecord` constructors.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from uncommon_route.proxy import (
    SessionContext,
    _coerce_difficulty_hint,
    _coerce_float_header,
    _coerce_int_header,
    _resolve_session_context,
    _resolve_session_id,
    _session_extras,
)
from uncommon_route.stats import RouteRecord


def _make_request(headers: dict[str, str]) -> Any:
    """Tiny stand-in for starlette.requests.Request — only `.headers` used."""
    req = MagicMock()
    req.headers = headers
    return req


class TestCoercers:
    def test_int_header_default(self) -> None:
        assert _coerce_int_header(None) == -1
        assert _coerce_int_header("") == -1
        assert _coerce_int_header("not an int") == -1

    def test_int_header_strips_whitespace(self) -> None:
        assert _coerce_int_header("  7 ") == 7
        assert _coerce_int_header("0") == 0

    def test_float_header_default(self) -> None:
        assert _coerce_float_header(None) == 0.0
        assert _coerce_float_header("") == 0.0
        assert _coerce_float_header("nope") == 0.0

    def test_float_header_parses(self) -> None:
        assert _coerce_float_header("0.5") == pytest.approx(0.5)
        assert _coerce_float_header(" 1.25  ") == pytest.approx(1.25)

    def test_difficulty_hint_normalises_and_validates(self) -> None:
        assert _coerce_difficulty_hint("HARD") == "hard"
        assert _coerce_difficulty_hint("medium") == "medium"
        assert _coerce_difficulty_hint("Reasoning") == "reasoning"
        # Unknown labels collapse to empty so the router can't be bluffed.
        assert _coerce_difficulty_hint("apocalyptic") == ""
        assert _coerce_difficulty_hint(None) == ""
        assert _coerce_difficulty_hint("") == ""


class TestResolveSessionContext:
    def test_returns_sentinels_when_no_headers(self) -> None:
        # Even with no session headers, derive_session_id can still mint
        # an id from the message digest. We just assert the four enrichment
        # fields fall back to sentinels.
        req = _make_request({})
        ctx = _resolve_session_context(req, {"messages": []})
        assert ctx.turn_index == -1
        assert ctx.session_budget_usd == 0.0
        assert ctx.difficulty_hint == ""
        assert ctx.context_usage_pct == 0.0

    def test_propagates_x_session_id(self) -> None:
        req = _make_request({"x-session-id": "sess-42"})
        ctx = _resolve_session_context(req, {})
        assert ctx.session_id == "sess-42"

    def test_falls_back_to_openclaw_session_key(self) -> None:
        req = _make_request({"x-openclaw-session-key": "ocw-7"})
        ctx = _resolve_session_context(req, {})
        assert ctx.session_id == "ocw-7"

    def test_x_session_id_wins_over_openclaw_key(self) -> None:
        req = _make_request(
            {"x-session-id": "primary", "x-openclaw-session-key": "secondary"}
        )
        ctx = _resolve_session_context(req, {})
        assert ctx.session_id == "primary"

    def test_parses_all_enrichment_headers(self) -> None:
        req = _make_request(
            {
                "x-session-id": "sess-99",
                "x-uncommon-route-turn-index": "12",
                "x-uncommon-route-session-budget-usd": "2.50",
                "x-uncommon-route-difficulty-hint": "Hard",
                "x-uncommon-route-context-usage-pct": "0.83",
            }
        )
        ctx = _resolve_session_context(req, {})
        assert ctx.session_id == "sess-99"
        assert ctx.turn_index == 12
        assert ctx.session_budget_usd == pytest.approx(2.5)
        assert ctx.difficulty_hint == "hard"
        assert ctx.context_usage_pct == pytest.approx(0.83)

    def test_malformed_enrichment_headers_fall_back_to_sentinels(self) -> None:
        req = _make_request(
            {
                "x-session-id": "s",
                "x-uncommon-route-turn-index": "definitely-not-a-number",
                "x-uncommon-route-session-budget-usd": "free!",
                "x-uncommon-route-difficulty-hint": "apocalyptic",
                "x-uncommon-route-context-usage-pct": "many",
            }
        )
        ctx = _resolve_session_context(req, {})
        assert ctx.turn_index == -1
        assert ctx.session_budget_usd == 0.0
        assert ctx.difficulty_hint == ""
        assert ctx.context_usage_pct == 0.0


class TestResolveSessionIdBackCompat:
    def test_returns_same_id_as_context_resolver(self) -> None:
        req = _make_request({"x-session-id": "sess-back-compat"})
        body: dict[str, Any] = {}
        assert _resolve_session_id(req, body) == "sess-back-compat"
        assert (
            _resolve_session_context(req, body).session_id == "sess-back-compat"
        )


class TestSessionExtras:
    def test_returns_only_the_four_new_fields(self) -> None:
        ctx = SessionContext(
            session_id="anything",
            turn_index=3,
            session_budget_usd=1.0,
            difficulty_hint="medium",
            context_usage_pct=0.42,
        )
        extras = _session_extras(ctx)
        assert set(extras.keys()) == {
            "turn_index",
            "session_budget_usd",
            "difficulty_hint",
            "context_usage_pct",
        }

    def test_spreads_cleanly_into_route_record(self) -> None:
        ctx = SessionContext(
            session_id="sess-1",
            turn_index=5,
            session_budget_usd=4.0,
            difficulty_hint="hard",
            context_usage_pct=0.91,
        )
        rec = RouteRecord(
            timestamp=0.0,
            model="m",
            tier="HARD",
            confidence=1.0,
            method="pool",
            estimated_cost=0.0,
            session_id=ctx.session_id,
            **_session_extras(ctx),
        )
        assert rec.turn_index == 5
        assert rec.session_budget_usd == pytest.approx(4.0)
        assert rec.difficulty_hint == "hard"
        assert rec.context_usage_pct == pytest.approx(0.91)


class TestRouteRecordDefaults:
    def test_existing_constructors_still_work(self) -> None:
        # Mirrors the smallest RouteRecord ctor used by the existing test
        # suite — ensures the four new fields have safe defaults so we
        # haven't broken the upstream call sites we don't touch.
        rec = RouteRecord(
            timestamp=0.0,
            model="m",
            tier="MEDIUM",
            confidence=0.5,
            method="pool",
            estimated_cost=0.0,
        )
        assert rec.turn_index == -1
        assert rec.session_budget_usd == 0.0
        assert rec.difficulty_hint == ""
        assert rec.context_usage_pct == 0.0
