"""Cost tracker for model provider usage and billing."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict


@dataclass
class ProviderStats:
    """Statistics for a single provider."""

    tokens: int = 0
    cost: float = 0.0
    requests: int = 0


class CostTracker:
    """Tracks token usage, costs, and request counts per provider.

    Supports multiple cost tiers:
    - Claude Sonnet: $3 per million input tokens
    - GPT-4 Turbo: $30 per million input tokens
    """

    COST_PER_MILLION_TOKENS: Dict[str, float] = {
        "claude": 3.0,
        "gpt4": 30.0,
    }

    def __init__(self) -> None:
        self._providers: Dict[str, ProviderStats] = {}

    def add_usage(self, provider: str, tokens: int, cost: float) -> None:
        """Record token usage and cost for a provider.

        Args:
            provider: Provider name (e.g., 'claude', 'gpt4').
            tokens: Number of tokens used.
            cost: Cost in dollars for this request.
        """
        if provider not in self._providers:
            self._providers[provider] = ProviderStats()
        stats = self._providers[provider]
        stats.tokens += tokens
        stats.cost += cost
        stats.requests += 1

    def get_stats(self) -> Dict[str, Dict[str, int | float]]:
        """Return a summary dict of all provider stats.

        Returns:
            Dict mapping provider name to dict with keys:
            tokens, cost, requests.
        """
        return {
            name: {
                "tokens": stats.tokens,
                "cost": stats.cost,
                "requests": stats.requests,
            }
            for name, stats in self._providers.items()
        }

    def reset_session(self) -> None:
        """Clear all tracked statistics."""
        self._providers.clear()

    @classmethod
    def calculate_cost(cls, provider: str, tokens: int) -> float:
        """Calculate cost for a given number of tokens.

        Args:
            provider: Provider name.
            tokens: Number of tokens used.

        Returns:
            Cost in dollars.
        """
        rate = cls.COST_PER_MILLION_TOKENS.get(provider, 0.0)
        return (tokens / 1_000_000) * rate
