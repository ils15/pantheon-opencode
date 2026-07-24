"""Rule-based intent classifier for multi-turn chatbot."""

from __future__ import annotations

import re
from typing import Dict, List, Tuple


class IntentClassifier:
    """Rule-based intent classifier using regex/keyword pattern matching.

    Classifies text into one of the following intents:
        greet, order_status, cancel_order, track_shipment,
        support_ticket, goodbye, help, fallback
    """

    def __init__(self) -> None:
        self.intents: Dict[str, List[re.Pattern]] = {
            "greet": self._compile_patterns([
                r"\bhello\b",
                r"\bhi\b",
                r"\bhey\b",
                r"\bhowdy\b",
                r"\bgood\s*morning\b",
                r"\bgood\s*evening\b",
                r"\bgood\s*afternoon\b",
                r"\bgreetings\b",
            ]),
            "order_status": self._compile_patterns([
                r"\border\s*status\b",
                r"\bstatus\s*of\s*my\s*order\b",
                r"\bwhere\s*is\s*my\s*order\b",
                r"\bcheck\s*(my\s*)?order\b",
                r"\btracking\s*order\b",
            ]),
            "cancel_order": self._compile_patterns([
                r"\bcancel\s*(my\s*)?order\b",
                r"\bI\s*want\s*to\s*cancel\b",
                r"\bstop\s*(my\s*)?order\b",
                r"\bI\s*'?d?\s*like\s*to\s*cancel\b",
            ]),
            "track_shipment": self._compile_patterns([
                r"\btrack\s*(my\s*)?shipment\b",
                r"\btrack\s*(my\s*)?package\b",
                r"\btrack\s*(my\s*)?order\b",
                r"\bwhere\s*is\s*my\s*package\b",
                r"\bdelivery\s*status\b",
                r"\bshipping\s*update\b",
                r"\bshipment\s*tracking\b",
            ]),
            "support_ticket": self._compile_patterns([
                r"\bsupport\s*ticket\b",
                r"\bopen\s*a?\s*(support|ticket)\b",
                r"\bI\s*need\s*(help|support)\b",
                r"\bI\s*have\s*(a|an)\s*(issue|problem|complaint)\b",
                r"\bissue\s*with\s*(my\s*)?order\b",
                r"\bproblem\s*with\s*(my\s*)?order\b",
            ]),
            "goodbye": self._compile_patterns([
                r"\bgoodbye\b",
                r"\bbye\b",
                r"\bsee\s*you\b",
                r"\btalk\s*to\s*you\s*later\b",
                r"\bthanks?\s*bye\b",
            ]),
            "help": self._compile_patterns([
                r"\bhelp\b",
                r"\bwhat\s*can\s*you\s*do\b",
                r"\bshow\s*(me\s*)?(the\s*)?options\b",
                r"\bcapabilities\b",
                r"\bwhat\s*do\s*you\s*do\b",
            ]),
        }

    def _compile_patterns(self, patterns: List[str]) -> List[re.Pattern]:
        """Compile a list of string patterns into regex patterns.

        Args:
            patterns: List of regex pattern strings.

        Returns:
            List of compiled regex Pattern objects.
        """
        return [re.compile(p, re.IGNORECASE) for p in patterns]

    def classify(self, text: str) -> Dict[str, float | str]:
        """Classify the input text into an intent.

        Args:
            text: The user's input message.

        Returns:
            Dict with keys:
                - intent: The classified intent name.
                - confidence: Float between 0 and 1 indicating match strength.
        """
        if not text or not text.strip():
            return {"intent": "fallback", "confidence": 0.0}

        text_lower = text.strip().lower()
        word_count = len(text_lower.split())

        best_intent = "fallback"
        best_score = 0.0

        for intent, patterns in self.intents.items():
            match_count = 0
            for pattern in patterns:
                matches = pattern.findall(text_lower)
                if matches:
                    match_count += len(matches)

            if match_count > 0:
                # Score based on match density relative to word count
                # More matches relative to message length = higher confidence
                score = min(1.0, match_count / max(1, word_count) * 1.5)
                # Bonus for having any match
                score = max(score, 0.5 + (match_count * 0.1))
                score = min(score, 1.0)

                if score > best_score:
                    best_score = score
                    best_intent = intent

        # If best_score is still 0, it's a fallback
        if best_score == 0.0:
            return {"intent": "fallback", "confidence": 0.1}

        return {"intent": best_intent, "confidence": round(best_score, 2)}
