"""Tests for model routing with fallback and cost tracking."""

import time
from unittest.mock import patch, MagicMock

import pytest

from cost_tracker import CostTracker
from providers import LLMProvider, ClaudeProvider, GPT4Provider
from router import ModelRouter, AllProvidersFailedError, CircuitBreakerOpenError


# ─── CostTracker Tests ────────────────────────────────────────────────────────

class TestCostTracker:
    """Tests for the CostTracker."""

    def test_tracks_tokens_and_cost(self):
        """Track tokens and cost for a provider."""
        tracker = CostTracker()
        tracker.add_usage("claude", tokens=150, cost=0.00045)
        stats = tracker.get_stats()
        assert stats["claude"]["tokens"] == 150
        assert stats["claude"]["cost"] == 0.00045
        assert stats["claude"]["requests"] == 1

    def test_multiple_providers(self):
        """Track multiple providers independently."""
        tracker = CostTracker()
        tracker.add_usage("claude", tokens=100, cost=0.0003)
        tracker.add_usage("gpt4", tokens=200, cost=0.006)
        stats = tracker.get_stats()
        assert stats["claude"]["tokens"] == 100
        assert stats["gpt4"]["tokens"] == 200

    def test_accumulation(self):
        """Costs accumulate across multiple calls."""
        tracker = CostTracker()
        tracker.add_usage("claude", tokens=150, cost=0.00045)
        tracker.add_usage("claude", tokens=300, cost=0.0009)
        stats = tracker.get_stats()
        assert stats["claude"]["tokens"] == 450
        assert stats["claude"]["cost"] == 0.00135
        assert stats["claude"]["requests"] == 2

    def test_reset_session(self):
        """reset_session clears all stats."""
        tracker = CostTracker()
        tracker.add_usage("claude", tokens=150, cost=0.00045)
        tracker.reset_session()
        stats = tracker.get_stats()
        assert stats == {}

    def test_request_count(self):
        """Track number of requests per provider."""
        tracker = CostTracker()
        tracker.add_usage("gpt4", tokens=50, cost=0.0015)
        tracker.add_usage("gpt4", tokens=100, cost=0.003)
        tracker.add_usage("gpt4", tokens=200, cost=0.006)
        stats = tracker.get_stats()
        assert stats["gpt4"]["requests"] == 3

    def test_missing_provider_returns_zero(self):
        """Getting stats for missing provider returns zero values."""
        tracker = CostTracker()
        stats = tracker.get_stats()
        assert "unknown" not in stats


# ─── Provider Tests ───────────────────────────────────────────────────────────

class TestClaudeProvider:
    """Tests for the Claude provider."""

    def test_complete_returns_response(self):
        """Claude provider returns a response string."""
        provider = ClaudeProvider()
        response, tokens = provider.complete("Hello", "claude-sonnet-4")
        assert isinstance(response, str)
        assert len(response) > 0

    def test_uses_correct_model(self):
        """Claude provider stores model name."""
        provider = ClaudeProvider()
        assert provider.model_name == "claude-sonnet-4-20241022"

    def test_tracks_tokens_used(self):
        """Claude provider returns a positive token count."""
        provider = ClaudeProvider()
        _, tokens = provider.complete("Test prompt", "claude-sonnet-4")
        assert isinstance(tokens, int)
        assert tokens > 0

    def test_different_prompts_different_tokens(self):
        """Different prompt lengths produce different token counts."""
        provider = ClaudeProvider()
        _, tokens_short = provider.complete("Hi", "claude-sonnet-4")
        _, tokens_long = provider.complete(
            "Hello, this is a much longer prompt that should produce more tokens.",
            "claude-sonnet-4",
        )
        assert tokens_long > tokens_short


class TestGPT4Provider:
    """Tests for the GPT-4 provider."""

    def test_complete_returns_response(self):
        """GPT-4 provider returns a response string."""
        provider = GPT4Provider()
        response, tokens = provider.complete("Hello", "gpt-4")
        assert isinstance(response, str)
        assert len(response) > 0

    def test_uses_correct_model(self):
        """GPT-4 provider stores model name."""
        provider = GPT4Provider()
        assert provider.model_name == "gpt-4-turbo-2024-04-09"


class TestLLMProvider:
    """Tests for the abstract LLM provider."""

    def test_abstract_cannot_be_instantiated(self):
        """LLMProvider cannot be instantiated directly."""
        with pytest.raises(TypeError):
            LLMProvider()  # type: ignore[abstract]


# ─── Router Tests ─────────────────────────────────────────────────────────────

class TestModelRouter:
    """Tests for the ModelRouter with fallback."""

    def test_primary_succeeds(self):
        """Primary provider is used when it succeeds."""
        tracker = CostTracker()
        router = ModelRouter(tracker=tracker)
        router.add_provider("claude", ClaudeProvider(), "claude-sonnet-4", priority=1)
        router.add_provider("gpt4", GPT4Provider(), "gpt-4", priority=2)
        result = router.complete("Hello")
        assert result["provider"] == "claude"
        assert result["model"] == "claude-sonnet-4"
        assert "response" in result
        assert "cost" in result

    def test_fallback_on_failure(self):
        """Fallback to secondary when primary fails."""
        tracker = CostTracker()
        router = ModelRouter(tracker=tracker)
        failing = ClaudeProvider()
        # Make primary fail
        original_complete = failing.complete
        failing.complete = lambda prompt, model: (_ for _ in ()).throw(
            RuntimeError("API error")
        )
        router.add_provider("claude", failing, "claude-sonnet-4", priority=1)
        router.add_provider("gpt4", GPT4Provider(), "gpt-4", priority=2)
        result = router.complete("Hello")
        assert result["provider"] == "gpt4"
        assert result["model"] == "gpt-4"

    def test_all_providers_fail_raises_error(self):
        """Raises error when all providers fail."""
        tracker = CostTracker()
        router = ModelRouter(tracker=tracker)

        def fail_always(prompt, model):
            raise RuntimeError("Always fails")

        claude = ClaudeProvider()
        claude.complete = fail_always
        gpt4 = GPT4Provider()
        gpt4.complete = fail_always

        router.add_provider("claude", claude, "claude-sonnet-4", priority=1)
        router.add_provider("gpt4", gpt4, "gpt-4", priority=2)
        with pytest.raises(AllProvidersFailedError):
            router.complete("Hello")

    def test_circuit_breaker_trips(self):
        """Circuit breaker trips after 3 consecutive failures."""
        tracker = CostTracker()
        router = ModelRouter(tracker=tracker)

        def fail_always(prompt, model):
            raise RuntimeError("Always fails")

        claude = ClaudeProvider()
        claude.complete = fail_always
        gpt4 = GPT4Provider()
        gpt4.complete = fail_always

        router.add_provider("claude", claude, "claude-sonnet-4", priority=1)
        router.add_provider("gpt4", gpt4, "gpt-4", priority=2)

        # First 3 calls should raise AllProvidersFailedError
        for _ in range(3):
            with pytest.raises(AllProvidersFailedError):
                router.complete("Hello")

        # 4th call should raise CircuitBreakerOpenError
        with pytest.raises(CircuitBreakerOpenError):
            router.complete("Hello")

    def test_circuit_breaker_recovers_after_timeout(self):
        """Circuit breaker resets after the cooldown period."""
        tracker = CostTracker()
        router = ModelRouter(tracker=tracker, circuit_breaker_timeout=0.1)

        def fail_always(prompt, model):
            raise RuntimeError("Always fails")

        claude = ClaudeProvider()
        claude.complete = fail_always
        gpt4 = GPT4Provider()
        gpt4.complete = fail_always

        router.add_provider("claude", claude, "claude-sonnet-4", priority=1)
        router.add_provider("gpt4", gpt4, "gpt-4", priority=2)

        # Trip the breaker
        for _ in range(3):
            with pytest.raises(AllProvidersFailedError):
                router.complete("Hello")

        # Should be open now
        with pytest.raises(CircuitBreakerOpenError):
            router.complete("Hello")

        # Wait for cooldown
        time.sleep(0.15)

        # Should try again (will still fail but not circuit breaker)
        with pytest.raises(AllProvidersFailedError):
            router.complete("Hello")

    def test_cost_tracking_accumulates(self):
        """Cost tracking accumulates across multiple requests."""
        tracker = CostTracker()
        router = ModelRouter(tracker=tracker)
        router.add_provider("claude", ClaudeProvider(), "claude-sonnet-4", priority=1)
        router.add_provider("gpt4", GPT4Provider(), "gpt-4", priority=2)

        router.complete("Hello")
        stats = tracker.get_stats()
        assert stats["claude"]["requests"] == 1
        assert stats["claude"]["tokens"] > 0
        assert stats["claude"]["cost"] > 0

        router.complete("Hello again")
        stats = tracker.get_stats()
        assert stats["claude"]["requests"] == 2

    def test_mixed_provider_costs(self):
        """Both primary and fallback costs are tracked."""
        tracker = CostTracker()
        router = ModelRouter(tracker=tracker)

        failing = ClaudeProvider()
        original = failing.complete
        failing.complete = lambda prompt, model: (_ for _ in ()).throw(
            RuntimeError("API error")
        )

        router.add_provider("claude", failing, "claude-sonnet-4", priority=1)
        router.add_provider("gpt4", GPT4Provider(), "gpt-4", priority=2)
        router.complete("Hello")

        stats = tracker.get_stats()
        # Primary failed so no claude cost, but fallback GPT-4 was used
        assert "gpt4" in stats
        assert stats["gpt4"]["requests"] == 1

    def test_priority_ordering(self):
        """Providers are tried in priority order."""
        tracker = CostTracker()
        router = ModelRouter(tracker=tracker)

        # Add in reverse priority order
        router.add_provider("gpt4", GPT4Provider(), "gpt-4", priority=2)
        router.add_provider("claude", ClaudeProvider(), "claude-sonnet-4", priority=1)

        result = router.complete("Hello")
        # Claude has priority 1, should be tried first
        assert result["provider"] == "claude"

    def test_get_session_summary(self):
        """Router returns a session summary."""
        tracker = CostTracker()
        router = ModelRouter(tracker=tracker)
        router.add_provider("claude", ClaudeProvider(), "claude-sonnet-4", priority=1)
        router.add_provider("gpt4", GPT4Provider(), "gpt-4", priority=2)

        router.complete("Hello")
        summary = router.get_session_summary()
        assert "total_requests" in summary
        assert "total_cost" in summary
        assert "providers" in summary
        assert summary["total_requests"] > 0


class TestIntegration:
    """Integration tests combining all components."""

    def test_full_workflow_with_claude_primary(self):
        """Full workflow: Claude primary → GPT-4 fallback → cost tracked."""
        tracker = CostTracker()
        router = ModelRouter(tracker=tracker)
        router.add_provider("claude", ClaudeProvider(), "claude-sonnet-4", priority=1)
        router.add_provider("gpt4", GPT4Provider(), "gpt-4", priority=2)

        # First request - Claude works
        r1 = router.complete("What is Python?")
        assert r1["provider"] == "claude"
        assert r1["cost"] > 0

        # Second request - Claude works
        r2 = router.complete("Explain async/await")
        assert r2["provider"] == "claude"

        # Check stats
        stats = tracker.get_stats()
        assert stats["claude"]["requests"] == 2
        assert stats["claude"]["tokens"] > 0
        assert stats["claude"]["cost"] > 0

    def test_fallback_on_make_failure(self):
        """When primary is patched to fail, fallback is used."""
        tracker = CostTracker()
        router = ModelRouter(tracker=tracker)
        router.add_provider("claude", ClaudeProvider(), "claude-sonnet-4", priority=1)
        router.add_provider("gpt4", GPT4Provider(), "gpt-4", priority=2)

        # Patch claude to fail
        router._providers[0].provider.complete = MagicMock(
            side_effect=RuntimeError("API unavailable")
        )

        result = router.complete("Hello")
        assert result["provider"] == "gpt4"

        stats = tracker.get_stats()
        assert stats["gpt4"]["requests"] == 1
