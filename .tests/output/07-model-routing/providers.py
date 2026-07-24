"""Abstract and concrete LLM provider implementations.

Providers simulate API calls — no real network requests are made.
Costs are calculated based on token usage and provider-specific rates.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Tuple

from cost_tracker import CostTracker


class LLMProvider(ABC):
    """Abstract base class for LLM providers.

    All providers must implement the ``complete`` method.
    """

    def __init__(self) -> None:
        self.model_name: str = ""

    @abstractmethod
    def complete(self, prompt: str, model: str) -> Tuple[str, int]:
        """Send a prompt to the model and return the response.

        Args:
            prompt: The input text to send.
            model: The model identifier to use.

        Returns:
            Tuple of (response_text, tokens_used).
        """
        ...


class ClaudeProvider(LLMProvider):
    """Simulated Anthropic Claude provider.

    Uses a token estimation of ~4 characters per token.
    Cost rate: $3 per million input tokens.
    """

    MODEL_MAP = {
        "claude-sonnet-4": "claude-sonnet-4-20241022",
        "claude-opus-4": "claude-opus-4-20241022",
        "claude-haiku-4": "claude-haiku-4-20241022",
    }

    DEFAULT_MODEL = "claude-sonnet-4-20241022"

    def __init__(self) -> None:
        super().__init__()
        self.model_name = self.DEFAULT_MODEL
        self._response_prefix = "Claude response"

    def complete(self, prompt: str, model: str = "claude-sonnet-4") -> Tuple[str, int]:
        """Simulate a Claude API completion.

        Args:
            prompt: Input prompt text.
            model: Claude model identifier (e.g., 'claude-sonnet-4').

        Returns:
            Tuple of (simulated_response, token_count).

        Raises:
            RuntimeError: If the API call is simulated to fail.
        """
        self.model_name = self.MODEL_MAP.get(model, self.DEFAULT_MODEL)
        input_token_est = max(1, len(prompt) // 4)
        response_text = f"{self._response_prefix} to: {prompt[:50]}..."
        output_token_est = max(1, len(response_text) // 4)
        total_tokens = input_token_est + output_token_est
        return response_text, total_tokens


class GPT4Provider(LLMProvider):
    """Simulated OpenAI GPT-4 provider.

    Uses a token estimation of ~4 characters per token.
    Cost rate: $30 per million input tokens.
    """

    MODEL_MAP = {
        "gpt-4": "gpt-4-turbo-2024-04-09",
        "gpt-4o": "gpt-4o-2024-08-06",
        "gpt-4o-mini": "gpt-4o-mini-2024-07-18",
    }

    DEFAULT_MODEL = "gpt-4-turbo-2024-04-09"

    def __init__(self) -> None:
        super().__init__()
        self.model_name = self.DEFAULT_MODEL
        self._response_prefix = "GPT-4 response"

    def complete(self, prompt: str, model: str = "gpt-4") -> Tuple[str, int]:
        """Simulate a GPT-4 API completion.

        Args:
            prompt: Input prompt text.
            model: GPT-4 model identifier (e.g., 'gpt-4').

        Returns:
            Tuple of (simulated_response, token_count).

        Raises:
            RuntimeError: If the API call is simulated to fail.
        """
        self.model_name = self.MODEL_MAP.get(model, self.DEFAULT_MODEL)
        input_token_est = max(1, len(prompt) // 4)
        response_text = f"{self._response_prefix} to: {prompt[:50]}..."
        output_token_est = max(1, len(response_text) // 4)
        total_tokens = input_token_est + output_token_est
        return response_text, total_tokens
