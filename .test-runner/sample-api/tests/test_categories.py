"""Tests for /api/categories endpoints."""
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_create_category() -> None:
    """POST /api/categories should create a category."""
    response = client.post("/api/categories", json={"name": "Electronics"})
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Electronics"
    assert "id" in data


def test_get_categories() -> None:
    """GET /api/categories should return list of categories."""
    response = client.get("/api/categories")
    assert response.status_code == 200
    assert isinstance(response.json(), list)
