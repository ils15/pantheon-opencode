"""Tests for /api/users endpoints."""
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_get_users_does_not_expose_password() -> None:
    """GET /api/users should NOT expose password in response."""
    # First create a user
    client.post("/api/users", json={
        "email": "test@example.com",
        "name": "Test User",
        "password": "secret123",
    })
    # Then get users
    response = client.get("/api/users")
    assert response.status_code == 200
    data = response.json()
    assert len(data) > 0
    # The critical assertion: password must NOT be exposed
    assert "password" not in data[0], "Password must not be exposed in user response!"
