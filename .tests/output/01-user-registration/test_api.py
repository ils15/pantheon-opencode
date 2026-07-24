"""Tests for the user registration API (RED phase — will fail initially)."""

import pytest
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


class TestUserRegistration:
    """Test suite for POST /api/auth/register."""

    def setup_method(self):
        """Reset storage before each test."""
        from storage import _reset_store

        _reset_store()

    # ── Happy path ──────────────────────────────────────────────

    def test_successful_registration_returns_201(self):
        """Valid data should return 201 with user info (no password)."""
        response = client.post(
            "/api/auth/register",
            json={
                "email": "alice@example.com",
                "password": "Str0ng!Secret",
                "name": "Alice",
            },
        )
        assert response.status_code == 201
        body = response.json()
        assert "id" in body
        assert body["email"] == "alice@example.com"
        assert body["name"] == "Alice"
        assert "password" not in body

    # ── Validation errors ───────────────────────────────────────

    @pytest.mark.parametrize(
        "email",
        [
            "not-an-email",
            "@domain.com",
            "user@",
            "user@.com",
            "",
        ],
    )
    def test_invalid_email_returns_400(self, email):
        """Malformed emails should return 400."""
        response = client.post(
            "/api/auth/register",
            json={
                "email": email,
                "password": "Str0ng!Secret",
                "name": "Bob",
            },
        )
        assert response.status_code == 400
        body = response.json()
        assert "detail" in body

    @pytest.mark.parametrize(
        "password, reason",
        [
            ("Sh0r!", "too short (min 8)"),
            ("Abcdefgh!", "no digit"),
            ("Abcdefg1", "no special char"),
            ("Abcdefgh", "no digit and no special char"),
        ],
    )
    def test_weak_password_returns_400(self, password, reason):
        """Weak passwords should return 400."""
        response = client.post(
            "/api/auth/register",
            json={
                "email": "charlie@example.com",
                "password": password,
                "name": "Charlie",
            },
        )
        assert response.status_code == 400, f"Expected 400 for: {reason}"
        body = response.json()
        assert "detail" in body

    # ── Conflict ────────────────────────────────────────────────

    def test_duplicate_email_returns_409(self):
        """Registering with an existing email should return 409."""
        payload = {
            "email": "dave@example.com",
            "password": "Str0ng!Secret",
            "name": "Dave",
        }
        # First registration succeeds
        r1 = client.post("/api/auth/register", json=payload)
        assert r1.status_code == 201

        # Second registration with the same email fails
        r2 = client.post("/api/auth/register", json=payload)
        assert r2.status_code == 409
        assert "detail" in r2.json()

    # ── Missing fields (Pydantic validation → 422) ──────────────

    @pytest.mark.parametrize(
        "payload",
        [
            {"password": "Str0ng!Secret", "name": "Eve"},  # missing email
            {"email": "eve@example.com", "name": "Eve"},  # missing password
            {"email": "eve@example.com", "password": "Str0ng!Secret"},  # missing name
            {},  # all missing
        ],
    )
    def test_missing_fields_returns_422(self, payload):
        """Missing required fields should return 422."""
        response = client.post("/api/auth/register", json=payload)
        assert response.status_code == 422
