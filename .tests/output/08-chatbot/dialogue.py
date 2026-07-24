"""Multi-turn dialogue manager with state machine for chatbot."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from entities import EntityExtractor
from intents import IntentClassifier


class DialogueManager:
    """Multi-turn dialogue state machine.

    Manages conversation flow through states:
        greeting -> collecting_info -> processing -> confirming -> resolved

    Maintains context across turns including slots, history, and unresolved
    intents. Handles slot filling by requesting missing entities.
    """

    VALID_STATES = frozenset({
        "greeting",
        "collecting_info",
        "processing",
        "confirming",
        "resolved",
    })

    def __init__(self) -> None:
        self.classifier = IntentClassifier()
        self.extractor = EntityExtractor()
        self.state: str = "greeting"
        self.context: Dict[str, Any] = self._fresh_context()

    def _fresh_context(self) -> Dict[str, Any]:
        """Create a new, empty conversation context.

        Returns:
            A fresh context dictionary with empty history, slots,
            and unresolved intents.
        """
        return {
            "state": self.state,
            "history": [],
            "unresolved_intents": [],
            "slots": {},
            "entities": {},
        }

    def reset(self) -> None:
        """Reset the dialogue manager to its initial state."""
        self.state = "greeting"
        self.context = self._fresh_context()

    @staticmethod
    def _required_slots(intent: str) -> List[str]:
        """Return the required slots for a given intent.

        Args:
            intent: The classified intent name.

        Returns:
            List of slot names required to fulfill the intent.
        """
        required: Dict[str, List[str]] = {
            "order_status": ["order_id"],
            "cancel_order": ["order_id"],
            "track_shipment": ["order_id"],
            "support_ticket": ["email"],
        }
        return required.get(intent, [])

    def _get_missing_slots(self, intent: str) -> List[str]:
        """Determine which required slots are still missing for an intent.

        Args:
            intent: The intent to check slots for.

        Returns:
            List of slot names that are still missing.
        """
        required = self._required_slots(intent)
        return [s for s in required if s not in self.context["slots"]]

    @staticmethod
    def _generate_slot_request(missing_slots: List[str]) -> str:
        """Generate a natural language request for missing information.

        Args:
            missing_slots: List of slot names that need to be filled.

        Returns:
            A string asking the user to provide the missing information.
        """
        prompts: Dict[str, str] = {
            "order_id": (
                "Could you please provide your order ID? "
                "It should start with # followed by 5 digits (e.g., #12345)."
            ),
            "email": (
                "Could you please provide your email address "
                "so we can look up your account?"
            ),
        }
        if missing_slots:
            slot = missing_slots[0]
            return prompts.get(slot, f"Could you please provide your {slot}?")
        return "How can I help you?"

    @staticmethod
    def _is_confirmation(message: str) -> bool:
        """Check if the user message is a confirmation.

        Args:
            message: The user's input text.

        Returns:
            True if the message indicates confirmation.
        """
        positive = re.compile(
            r"\b(yes|yeah|yep|correct|right|that'?s right|"
            r"that'?s correct|sure|go ahead|proceed|confirm)\b",
            re.IGNORECASE,
        )
        return bool(positive.search(message.strip()))

    @staticmethod
    def _is_negation(message: str) -> bool:
        """Check if the user message is a negation or correction.

        Args:
            message: The user's input text.

        Returns:
            True if the message indicates negation.
        """
        negative = re.compile(
            r"\b(no|nope|not|wrong|incorrect|that'?s not|"
            r"that'?s wrong|don'?t|doesn'?t)\b",
            re.IGNORECASE,
        )
        return bool(negative.search(message.strip()))

    def process_message(self, message: str) -> Dict[str, Any]:
        """Process a user message and advance the dialogue state.

        Args:
            message: The user's input text.

        Returns:
            Dict with keys:
                - response: The system's response text.
                - context: The current conversation context.
                - action: The action taken.
        """
        message = message.strip()
        if not message:
            return {
                "response": "Please say something!",
                "context": self.context,
                "action": "fallback",
            }

        # 1. Classify intent and extract entities
        classification = self.classifier.classify(message)
        intent = classification["intent"]
        extraction = self.extractor.extract(message)
        entities = extraction["entities"]

        # 2. Store entities in context slots
        for entity_type, value in entities.items():
            self.context["slots"][entity_type] = value
        self.context["entities"] = entities

        # 3. Record turn in history
        self.context["history"].append({
            "message": message,
            "intent": intent,
            "entities": entities,
        })

        # 4. Track unresolved intents (skip meta intents)
        if intent not in ("greet", "goodbye", "help", "fallback"):
            if intent not in self.context["unresolved_intents"]:
                self.context["unresolved_intents"].append(intent)

        # 5. State machine dispatch
        result = self._dispatch(intent, message)

        # 6. Update context state
        self.context["state"] = self.state

        return result

    def _dispatch(self, intent: str, message: str) -> Dict[str, Any]:
        """Dispatch to the appropriate handler based on intent and state.

        Args:
            intent: The classified intent.
            message: The original user message.

        Returns:
            Response dict with response text, context, and action.
        """
        # Resolved state: only greet restarts
        if self.state == "resolved":
            if intent == "greet":
                self.reset()
                return self._handle_greet()
            return {
                "response": (
                    "The conversation has ended. "
                    "Say 'hello' to start a new one."
                ),
                "context": self.context,
                "action": "restart",
            }

        # Meta intents handled directly
        if intent == "greet":
            return self._handle_greet()
        if intent == "goodbye":
            return self._handle_goodbye()
        if intent == "help":
            return self._handle_help()

        # In confirming state, check for confirmation/negation
        if self.state == "confirming":
            if self._is_confirmation(message):
                return self._handle_resolved()
            if self._is_negation(message):
                return self._handle_negation()

        # If we have pending unresolved intents and the user provides
        # slot-filling entities, try to advance the flow
        if intent == "fallback" and self.context["unresolved_intents"]:
            # Check if entities fill any missing slots
            pending = self.context["unresolved_intents"][-1]
            missing = self._get_missing_slots(pending)
            if not missing:
                return self._process_intent(pending)

        # Fallback in collecting_info: check if entities fill slots
        if intent == "fallback" and self.state == "collecting_info":
            if self.context["unresolved_intents"]:
                pending = self.context["unresolved_intents"][-1]
                missing = self._get_missing_slots(pending)
                if not missing:
                    return self._process_intent(pending)

            return self._handle_fallback(message)

        if intent == "fallback":
            return self._handle_fallback(message)

        # Actionable intent handling
        return self._handle_actionable(intent, message)

    def _handle_greet(self) -> Dict[str, Any]:
        """Handle greeting intent."""
        self.state = "greeting"
        return {
            "response": (
                "Hello! Welcome to customer support. How can I help you today? "
                "You can ask about your order status, track a shipment, "
                "cancel an order, or open a support ticket."
            ),
            "context": self.context,
            "action": "greet",
        }

    def _handle_goodbye(self) -> Dict[str, Any]:
        """Handle goodbye intent."""
        self.state = "resolved"
        return {
            "response": "Thank you for contacting us! Have a great day!",
            "context": self.context,
            "action": "goodbye",
        }

    def _handle_help(self) -> Dict[str, Any]:
        """Handle help intent."""
        return {
            "response": (
                "I can help you with:\n"
                "- Check order status\n"
                "- Cancel an order\n"
                "- Track a shipment\n"
                "- Open a support ticket\n\n"
                "What would you like to do?"
            ),
            "context": self.context,
            "action": "help",
        }

    def _handle_fallback(self, message: str) -> Dict[str, Any]:
        """Handle unrecognized input."""
        return {
            "response": (
                "I'm sorry, I didn't understand that. Could you rephrase? "
                "You can say 'help' to see what I can do."
            ),
            "context": self.context,
            "action": "fallback",
        }

    def _handle_actionable(self, intent: str, message: str) -> Dict[str, Any]:
        """Handle an actionable intent using the slot-filling state machine.

        Args:
            intent: The classified intent.
            message: The original user message.

        Returns:
            Response dict.
        """
        self.state = "collecting_info"
        missing = self._get_missing_slots(intent)

        if missing:
            return self._request_slot(intent, missing)

        # All slots filled, process the intent
        self.state = "processing"
        return self._process_intent(intent)

    def _request_slot(self, intent: str, missing: List[str]) -> Dict[str, Any]:
        """Request missing slot information from the user.

        Args:
            intent: The current intent being processed.
            missing: List of missing slot names.

        Returns:
            Response dict with a request for information.
        """
        self.state = "collecting_info"
        prompt = self._generate_slot_request(missing)
        action = "ask_order_id" if "order_id" in missing else "collect_info"
        return {
            "response": prompt,
            "context": self.context,
            "action": action,
        }

    def _process_intent(self, intent: str) -> Dict[str, Any]:
        """Process a fully-slotted intent.

        Args:
            intent: The intent to process.

        Returns:
            Response dict with processing result.
        """
        self.state = "confirming"

        order_id = self.context["slots"].get("order_id", "")
        email = self.context["slots"].get("email", "")
        date = self.context["slots"].get("date", "")
        product = self.context["slots"].get("product_name", "")

        if intent == "order_status":
            detail = f" for order {order_id}" if order_id else ""
            return {
                "response": (
                    f"Let me check the status of your order{detail}. "
                    f"Your order is currently being processed and "
                    f"is on track for delivery. Does that answer your question?"
                ),
                "context": self.context,
                "action": "confirm",
            }

        if intent == "cancel_order":
            detail = f" for order {order_id}" if order_id else ""
            return {
                "response": (
                    f"I've initiated a cancellation request{detail}. "
                    f"Your cancellation has been submitted and you will "
                    f"receive a confirmation email shortly. "
                    f"Does that look correct?"
                ),
                "context": self.context,
                "action": "confirm",
            }

        if intent == "track_shipment":
            parts = [f"tracking order {order_id}"] if order_id else ["tracking your shipment"]
            if date:
                parts.append(f"from {date}")
            detail_str = " ".join(parts)
            return {
                "response": (
                    f"I'm {detail_str}. Your package is in transit "
                    f"and expected to arrive soon. Does that help?"
                ),
                "context": self.context,
                "action": "confirm",
            }

        if intent == "support_ticket":
            detail = f" for {email}" if email else ""
            return {
                "response": (
                    f"I've opened a support ticket{detail}. "
                    f"One of our agents will follow up with you "
                    f"within 24 hours. Is there anything else I can help with?"
                ),
                "context": self.context,
                "action": "confirm",
            }

        return {
            "response": "I've processed your request. Is there anything else I can help with?",
            "context": self.context,
            "action": "process",
        }

    def _handle_resolved(self) -> Dict[str, Any]:
        """Handle successful confirmation from user."""
        self.state = "resolved"
        return {
            "response": "Great! I'm glad I could help. Is there anything else you need?",
            "context": self.context,
            "action": "resolved",
        }

    def _handle_negation(self) -> Dict[str, Any]:
        """Handle user negating the confirmation."""
        self.state = "collecting_info"
        return {
            "response": (
                "I apologize for the confusion. Let me try again. "
                "Could you please provide more details about your issue?"
            ),
            "context": self.context,
            "action": "collect_info",
        }
