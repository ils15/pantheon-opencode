"""Tests for the /health endpoint."""

from unittest.mock import patch

from fastapi.testclient import TestClient

from main import app
from db import engine

client = TestClient(app)


def test_health_endpoint() -> None:
    """GET /api/health should return status ok with version (backward compatible)."""
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["version"] == "1.0.0"


def test_health_endpoint_db_connected() -> None:
    """GET /api/health should include database: connected when DB is reachable."""
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["version"] == "1.0.0"
    assert data["database"] == "connected"


def test_health_endpoint_db_disconnected() -> None:
    """GET /api/health should include database: disconnected when DB is down.

    The endpoint must never crash (never 500) even when the DB is unreachable.
    """
    with patch.object(engine, "connect", side_effect=Exception("DB unavailable")):
        response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["version"] == "1.0.0"
    assert data["database"] == "disconnected"
