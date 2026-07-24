"""Entity extractor using regex patterns for multi-turn chatbot."""

from __future__ import annotations

import re
from typing import Dict, List, Optional


class EntityExtractor:
    """Extract structured entities from natural language text.

    Supported entity types:
        - order_id: Order identifiers in #XXXXX format.
        - email: Email addresses (user@domain).
        - date: Relative dates (today, tomorrow, day names).
        - product_name: Product names in single quotes.
    """

    def __init__(self) -> None:
        self.patterns: Dict[str, List[re.Pattern]] = {
            "order_id": [
                re.compile(r"(#[0-9]{5})\b"),
            ],
            "email": [
                re.compile(r"\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b"),
            ],
            "date": [
                re.compile(r"\b(today|tomorrow)\b", re.IGNORECASE),
                re.compile(
                    r"\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
                    re.IGNORECASE,
                ),
                re.compile(r"\b(yesterday)\b", re.IGNORECASE),
            ],
            "product_name": [
                re.compile(r"'([^']+)'"),
            ],
        }

    def extract(self, text: str) -> Dict[str, Optional[Dict[str, str] | str]]:
        """Extract entities from the given text.

        Args:
            text: The user's input message.

        Returns:
            Dict with keys:
                - entities: Dict mapping entity type to extracted value.
                - raw: The original input text.
        """
        if not text:
            return {"entities": {}, "raw": ""}

        entities: Dict[str, str] = {}

        for entity_type, patterns in self.patterns.items():
            for pattern in patterns:
                match = pattern.search(text)
                if match:
                    value = match.group(1) if match.lastindex else match.group(0)
                    # Normalize day names to lowercase
                    if entity_type == "date":
                        value = value.lower()
                    entities[entity_type] = value
                    # Take the first match for each entity type
                    break

        return {"entities": entities, "raw": text}
