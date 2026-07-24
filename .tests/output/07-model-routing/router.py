"""Model router with priority-based fallback and circuit breaker."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from cost_tracker import CostTracker
from providers import LLMProvider


class AllProvidersFailedError(Exception):
    """All configured providers failed to complete the request."""

    def __init__(self, errors: List[Tuple[str, str, Exception]]) -> None:
        self.errors = errors
        messages = "; ".join(
            f"{name}/{model}: {err}" for name, model, err in errors
        )
        super().__init__(f"All providers failed: {messages}")


class CircuitBreakerOpenError(Exception):
    """Circuit breaker is open; providers are temporarily unavailable."""

    def __init__(self, retry_after: float) -> None:
        self.retry_after = retry_after
        super().__init__(
            f"Circuit breaker is open. Retry after {retry_after:.1f}s"
        )


@dataclass
class ProviderEntry:
    """A registered provider with its metadata."""

    name: str
    provider: LLMProvider
    model: str
    priority: int


@dataclass
class CircuitBreakerState:
    """Tracks circuit breaker state for a provider."""

    failures: int = 0
    last_failure_time: float = 0.0
    is_open: bool = False


class ModelRouter:
    """Routes requests to providers in priority order with fallback.

    Features:
    - Priority-based provider selection
    - Automatic fallback on failure
    - Circuit breaker (after N consecutive failures, cooldown period)
    - Per-request and session-level cost tracking
    """

    def __init__(
        self,
        tracker: Optional[CostTracker] = None,
        circuit_breaker_threshold: int = 3,
        circuit_breaker_timeout: float = 30.0,
    ) -> None:
        """Initialize the router.

        Args:
            tracker: CostTracker instance. Creates one if not provided.
            circuit_breaker_threshold: Failures before circuit opens.
            circuit_breaker_timeout: Seconds before circuit resets.
        """
        self.tracker = tracker or CostTracker()
        self._providers: List[ProviderEntry] = []
        self._circuit_breaker_threshold = circuit_breaker_threshold
        self._circuit_breaker_timeout = circuit_breaker_timeout
        self._circuit_breaker: Dict[str, CircuitBreakerState] = {}
        self._request_count = 0
        self._total_cost = 0.0

    def add_provider(
        self, name: str, provider: LLMProvider, model: str, priority: int
    ) -> None:
        """Register a provider for routing.

        Args:
            name: Provider identifier (e.g., 'claude', 'gpt4').
            provider: An LLMProvider instance.
            model: Model name string to use with this provider.
            priority: Lower number = higher priority (1 is highest).
        """
        entry = ProviderEntry(
            name=name, provider=provider, model=model, priority=priority
        )
        self._providers.append(entry)
        self._providers.sort(key=lambda p: p.priority)

    def complete(self, prompt: str) -> Dict:
        """Send a prompt to the highest-priority available provider.

        Args:
            prompt: The input text to send.

        Returns:
            Dict with keys:
            - response: The generated text.
            - provider: Provider name used.
            - model: Model name used.
            - cost: Cost in dollars for this request.

        Raises:
            CircuitBreakerOpenError: All providers are circuit-broken.
            AllProvidersFailedError: All providers attempted and failed.
        """
        self._check_circuit_breakers()

        available = [
            e for e in self._providers
            if not self._is_circuit_open(e.name)
        ]

        if not available:
            retry_after = self._min_retry_after()
            raise CircuitBreakerOpenError(retry_after)

        errors: List[Tuple[str, str, Exception]] = []

        for entry in available:
            try:
                response, tokens = entry.provider.complete(prompt, entry.model)
                cost = CostTracker.calculate_cost(entry.name, tokens)

                self.tracker.add_usage(entry.name, tokens, cost)
                self._request_count += 1
                self._total_cost += cost

                self._record_success(entry.name)

                return {
                    "response": response,
                    "provider": entry.name,
                    "model": entry.model,
                    "cost": cost,
                }
            except Exception as exc:
                self._record_failure(entry.name)
                errors.append((entry.name, entry.model, exc))

        raise AllProvidersFailedError(errors)

    def _check_circuit_breakers(self) -> None:
        """Check and reset any circuit breakers that have timed out."""
        current_time = time.time()
        for name, state in self._circuit_breaker.items():
            if state.is_open:
                elapsed = current_time - state.last_failure_time
                if elapsed >= self._circuit_breaker_timeout:
                    state.is_open = False
                    state.failures = 0

    def _is_circuit_open(self, name: str) -> bool:
        """Check if a provider's circuit breaker is open."""
        state = self._circuit_breaker.get(name)
        if state is None:
            return False
        if not state.is_open:
            return False
        # Check if timeout has elapsed
        if time.time() - state.last_failure_time >= self._circuit_breaker_timeout:
            state.is_open = False
            state.failures = 0
            return False
        return True

    def _record_failure(self, name: str) -> None:
        """Record a failure for a provider."""
        if name not in self._circuit_breaker:
            self._circuit_breaker[name] = CircuitBreakerState()
        state = self._circuit_breaker[name]
        state.failures += 1
        state.last_failure_time = time.time()
        if state.failures >= self._circuit_breaker_threshold:
            state.is_open = True

    def _record_success(self, name: str) -> None:
        """Reset failure count on success."""
        if name in self._circuit_breaker:
            self._circuit_breaker[name].failures = 0
            self._circuit_breaker[name].is_open = False

    def _min_retry_after(self) -> float:
        """Get the shortest retry-after time across all open circuits."""
        current_time = time.time()
        min_remaining = self._circuit_breaker_timeout
        for state in self._circuit_breaker.values():
            if state.is_open:
                elapsed = current_time - state.last_failure_time
                remaining = max(0.0, self._circuit_breaker_timeout - elapsed)
                min_remaining = min(min_remaining, remaining)
        return min_remaining

    def get_session_summary(self) -> Dict:
        """Return a summary of the current session.

        Returns:
            Dict with keys: total_requests, total_cost, providers.
        """
        return {
            "total_requests": self._request_count,
            "total_cost": self._total_cost,
            "providers": self.tracker.get_stats(),
        }
