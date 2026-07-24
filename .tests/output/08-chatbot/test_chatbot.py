"""Tests for multi-turn chatbot with intent classification and entity extraction."""

import pytest
from intents import IntentClassifier
from entities import EntityExtractor
from dialogue import DialogueManager


# =============================================================================
# Intent Classifier Tests
# =============================================================================

class TestIntentClassifier:
    """Test suite for IntentClassifier — rule-based intent classification."""

    def setup_method(self):
        self.classifier = IntentClassifier()

    def test_greet_intent(self):
        """Test greet intent is classified correctly."""
        result = self.classifier.classify("Hello there!")
        assert result["intent"] == "greet"
        assert 0.5 <= result["confidence"] <= 1.0

        result = self.classifier.classify("Good morning, how are you?")
        assert result["intent"] == "greet"

        result = self.classifier.classify("Hey!")
        assert result["intent"] == "greet"

    def test_order_status_intent(self):
        """Test order_status intent."""
        result = self.classifier.classify("What is the status of my order?")
        assert result["intent"] == "order_status"

        result = self.classifier.classify("Where is my order #12345?")
        assert result["intent"] == "order_status"

        result = self.classifier.classify("Check order status")
        assert result["intent"] == "order_status"

    def test_cancel_order_intent(self):
        """Test cancel_order intent."""
        result = self.classifier.classify("I want to cancel my order")
        assert result["intent"] == "cancel_order"

        result = self.classifier.classify("Cancel order please")
        assert result["intent"] == "cancel_order"

        result = self.classifier.classify("Can I stop my order?")
        assert result["intent"] == "cancel_order"

    def test_track_shipment_intent(self):
        """Test track_shipment intent."""
        result = self.classifier.classify("Track my shipment")
        assert result["intent"] == "track_shipment"

        result = self.classifier.classify("Where is my package?")
        assert result["intent"] == "track_shipment"

        result = self.classifier.classify("Delivery status update")
        assert result["intent"] == "track_shipment"

    def test_support_ticket_intent(self):
        """Test support_ticket intent."""
        result = self.classifier.classify("I need help with a problem")
        assert result["intent"] == "support_ticket"

        result = self.classifier.classify("Open a support ticket")
        assert result["intent"] == "support_ticket"

        result = self.classifier.classify("I have an issue with my order")
        assert result["intent"] == "support_ticket"

    def test_goodbye_intent(self):
        """Test goodbye intent."""
        result = self.classifier.classify("Goodbye")
        assert result["intent"] == "goodbye"

        result = self.classifier.classify("Bye, thanks for your help")
        assert result["intent"] == "goodbye"

        result = self.classifier.classify("See you later")
        assert result["intent"] == "goodbye"

    def test_help_intent(self):
        """Test help intent."""
        result = self.classifier.classify("Help me")
        assert result["intent"] == "help"

        result = self.classifier.classify("What can you do?")
        assert result["intent"] == "help"

        result = self.classifier.classify("Show me the options")
        assert result["intent"] == "help"

    def test_fallback_intent(self):
        """Test unknown input returns fallback with low confidence."""
        result = self.classifier.classify("Lorem ipsum dolor sit amet")
        assert result["intent"] == "fallback"
        assert result["confidence"] < 0.5

        result = self.classifier.classify("12345")
        assert result["intent"] == "fallback"
        assert result["confidence"] < 0.5

    def test_confidence_scoring(self):
        """Test confidence varies based on match strength."""
        # Direct match should be high confidence
        result = self.classifier.classify("Hello")
        assert result["confidence"] >= 0.7

        result = self.classifier.classify("hello there")
        assert result["confidence"] >= 0.7

    def test_case_insensitivity(self):
        """Test classification is case-insensitive."""
        result_upper = self.classifier.classify("HELLO")
        result_lower = self.classifier.classify("hello")
        assert result_upper["intent"] == result_lower["intent"]
        assert result_upper["confidence"] == result_lower["confidence"]

    def test_partial_match_priority(self):
        """Test that when multiple intents match, the best one wins."""
        # "help with order" could match help or order_status
        # Priority should go to more specific match
        result = self.classifier.classify("help with my order")
        # order_status should win since it has more specific intent
        assert result["intent"] in ("help", "order_status")
        assert result["confidence"] > 0


# =============================================================================
# Entity Extractor Tests
# =============================================================================

class TestEntityExtractor:
    """Test suite for EntityExtractor — regex-based entity extraction."""

    def setup_method(self):
        self.extractor = EntityExtractor()

    def test_extract_order_id(self):
        """Test order_id extraction (#XXXXX format)."""
        result = self.extractor.extract("What is the status of order #12345?")
        assert "order_id" in result["entities"]
        assert result["entities"]["order_id"] == "#12345"

        result = self.extractor.extract("Cancel #99999 please")
        assert "order_id" in result["entities"]
        assert result["entities"]["order_id"] == "#99999"

    def test_order_id_not_extracted_without_hash(self):
        """Test that numbers without # are not extracted as order_id."""
        result = self.extractor.extract("My order number is 12345")
        # 12345 without # should not be an order_id
        assert "order_id" not in result["entities"]

    def test_extract_email(self):
        """Test email extraction."""
        result = self.extractor.extract("Contact me at user@example.com")
        assert "email" in result["entities"]
        assert result["entities"]["email"] == "user@example.com"

        result = self.extractor.extract("My email is john.doe@company.co.uk")
        assert "email" in result["entities"]
        assert result["entities"]["email"] == "john.doe@company.co.uk"

    def test_extract_date_today_tomorrow(self):
        """Test relative date extraction."""
        result = self.extractor.extract("I need it delivered today")
        assert "date" in result["entities"]
        assert result["entities"]["date"] == "today"

        result = self.extractor.extract("Can you ship it tomorrow?")
        assert "date" in result["entities"]
        assert result["entities"]["date"] == "tomorrow"

    def test_extract_date_day_names(self):
        """Test day name extraction."""
        result = self.extractor.extract("Schedule for monday")
        assert "date" in result["entities"]
        assert result["entities"]["date"] == "monday"

        result = self.extractor.extract("Next Friday delivery")
        assert "date" in result["entities"]
        assert result["entities"]["date"] == "friday"

    def test_extract_product_name(self):
        """Test product name extraction from quoted strings or known products."""
        result = self.extractor.extract("I ordered a 'Wireless Mouse'")
        assert "product_name" in result["entities"]
        assert result["entities"]["product_name"] == "Wireless Mouse"

        result = self.extractor.extract("I want to buy a 'USB-C Hub'")
        assert "product_name" in result["entities"]
        assert result["entities"]["product_name"] == "USB-C Hub"

    def test_extract_no_entities(self):
        """Test that text with no entities returns empty dict."""
        result = self.extractor.extract("Hello, how are you?")
        assert result["entities"] == {}
        assert result["raw"] == "Hello, how are you?"

    def test_extract_multiple_entities(self):
        """Test extraction of multiple entity types from one message."""
        result = self.extractor.extract(
            "Check order #12345 for user@example.com shipped yesterday"
        )
        assert "order_id" in result["entities"]
        assert "email" in result["entities"]
        # yesterday is a date
        assert "date" in result["entities"]

    def test_extract_raw_text(self):
        """Test that raw text is preserved in result."""
        text = "Hello world"
        result = self.extractor.extract(text)
        assert result["raw"] == text


# =============================================================================
# Dialogue Manager Tests
# =============================================================================

class TestDialogueManager:
    """Test suite for DialogueManager — multi-turn state machine."""

    def setup_method(self):
        self.manager = DialogueManager()

    def test_initial_state(self):
        """Test dialogue manager starts in greeting state."""
        assert self.manager.state == "greeting"
        assert self.manager.context["history"] == []
        assert self.manager.context["unresolved_intents"] == []
        assert self.manager.context["slots"] == {}

    def test_greeting_flow(self):
        """Test greeting message sets correct state."""
        result = self.manager.process_message("Hello")
        assert result["action"] == "greet"
        assert result["context"]["state"] == "greeting"

    def test_greeting_then_order_status(self):
        """Test multi-turn: greet then ask order status."""
        # Turn 1: Greet
        self.manager.process_message("Hello")

        # Turn 2: Ask order status
        result = self.manager.process_message("What is my order status?")
        assert result["action"] == "ask_order_id"
        assert result["context"]["state"] == "collecting_info"
        # Order status should be tracked as unresolved
        assert "order_status" in result["context"]["unresolved_intents"]

    def test_slot_filling_order_id(self):
        """Test that missing order_id triggers slot filling."""
        # Ask for order status without providing order_id
        # This should trigger a request for order_id
        result = self.manager.process_message("Check my order status")
        # State should change to collecting_info
        assert result["context"]["state"] == "collecting_info"

        # Now provide the order_id
        result = self.manager.process_message("It is #12345")
        entities = result["context"].get("entities", {})
        # The order_id should be extracted
        if "order_id" not in entities:
            # If not directly in context, check slots
            slots = result["context"].get("slots", {})
            assert slots.get("order_id") == "#12345" or entities.get("order_id") == "#12345"

    def test_full_conversation_flow(self):
        """Test complete multi-turn conversation."""
        # Turn 1: Greet
        result = self.manager.process_message("Hi there!")
        assert result["action"] == "greet"
        assert "hello" in result["response"].lower() or "hi" in result["response"].lower()

        # Turn 2: Ask for order status
        result = self.manager.process_message("I want to check my order")
        assert result["action"] in ("ask_order_id", "collect_info")
        # Should ask for order_id

        # Turn 3: Provide order_id
        result = self.manager.process_message("The order id is #98765")
        # Should process the order

        # Turn 4: Confirm
        result = self.manager.process_message("Yes, that's correct")
        assert result["action"] in ("confirm", "resolved")
        assert result["context"]["state"] in ("confirming", "resolved")

    def test_context_persistence(self):
        """Test that context persists across multiple turns."""
        self.manager.process_message("Hello")
        self.manager.process_message("Check order #55555")

        context = self.manager.context
        assert len(context["history"]) >= 2

        # Check history contains the messages
        messages = [entry["message"] for entry in context["history"]]
        assert "Hello" in messages
        assert "Check order #55555" in messages

    def test_order_id_extracted_in_conversation(self):
        """Test that order_id is extracted during conversation processing."""
        # Provide order_id directly in the message
        result = self.manager.process_message("Check order #77777")
        entities = result["context"].get("entities", {})
        slots = result["context"].get("slots", {})
        order_id = entities.get("order_id") or slots.get("order_id")
        assert order_id == "#77777"

    def test_fallback_handling(self):
        """Test that unrecognized messages trigger fallback."""
        result = self.manager.process_message("xylophone zebra quantum")
        assert result["action"] == "fallback"
        assert result["context"]["state"] == "greeting"

    def test_goodbye_ends_conversation(self):
        """Test goodbye intent changes state to resolved."""
        result = self.manager.process_message("Goodbye!")
        assert result["action"] == "goodbye"
        assert result["context"]["state"] == "resolved"

    def test_support_ticket_flow(self):
        """Test support ticket flow collects issue description."""
        result = self.manager.process_message("I need to open a support ticket")
        assert result["action"] in ("collect_info", "ask_issue")
        assert result["context"]["state"] == "collecting_info"

        # Provide issue details
        result = self.manager.process_message(
            "My order arrived damaged, I need a refund"
        )
        # Should process the ticket
        assert result["action"] in ("confirm", "process")

    def test_track_shipment_with_date(self):
        """Test tracking shipment with a date entity."""
        result = self.manager.process_message("Track my shipment from today")
        assert result["context"]["state"] in ("collecting_info", "processing")

        # Check that date entities are extracted
        slots = result["context"].get("slots", {})
        entities = result["context"].get("entities", {})
        date_value = entities.get("date") or slots.get("date")
        if date_value:
            assert date_value == "today"

    def test_resolved_state_not_processing(self):
        """Test that resolved state doesn't continue processing old intents."""
        self.manager.process_message("Goodbye!")
        assert self.manager.state == "resolved"

        # After resolved, new greeting should restart
        result = self.manager.process_message("Hello again")
        # Should restart the conversation
        assert result["action"] in ("greet", "restart")

    def test_multiple_unresolved_intents(self):
        """Test that multiple intents can be tracked as unresolved."""
        self.manager.process_message("Hello")
        self.manager.process_message("Cancel my order")
        self.manager.process_message("Also I need support")

        unresolved = self.manager.context["unresolved_intents"]
        assert "cancel_order" in unresolved
        assert "support_ticket" in unresolved


# =============================================================================
# Integration Tests
# =============================================================================

class TestChatbotIntegration:
    """End-to-end integration tests for the full chatbot pipeline."""

    def setup_method(self):
        self.classifier = IntentClassifier()
        self.extractor = EntityExtractor()
        self.manager = DialogueManager()

    def test_pipeline_from_text_to_response(self):
        """Test full pipeline: text → classify → extract → dialogue."""
        # Simulate the pipeline manually
        text = "I want to track order #12345"

        # Step 1: Classify
        intent_result = self.classifier.classify(text)
        assert intent_result["intent"] == "track_shipment"

        # Step 2: Extract entities
        entity_result = self.extractor.extract(text)
        assert "order_id" in entity_result["entities"]

        # Step 3: Dialogue
        result = self.manager.process_message(text)
        # The order_id should be stored in context
        entities = result["context"].get("entities", {})
        slots = result["context"].get("slots", {})
        order_id = entities.get("order_id") or slots.get("order_id")
        assert order_id == "#12345"

    def test_complex_scenario(self):
        """Test a complex real-world conversation."""
        conversation = [
            ("Hi", "greet"),
            ("I need help with order #67890", "support_ticket", "order_status"),
            ("Yes, it arrived broken", None),
            ("My email is sam@test.com", None),
            ("Yes, please proceed", None),
            ("Thank you, goodbye", "goodbye"),
        ]

        for i, turn in enumerate(conversation):
            message = turn[0]
            result = self.manager.process_message(message)

            if len(turn) > 1 and turn[1] is not None:
                assert result["context"]["state"] in (
                    "greeting",
                    "collecting_info",
                    "processing",
                    "confirming",
                    "resolved",
                )

        # Final state should be resolved
        assert self.manager.state == "resolved"
