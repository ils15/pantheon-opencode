"""Health check endpoint providing system status and database connectivity."""

from sqlalchemy import text

from fastapi import APIRouter

from db import engine

router = APIRouter()


@router.get("/health")
def health_check() -> dict[str, str]:
    """Return health status, version, and database connectivity.

    The endpoint NEVER raises an exception — health checks must be resilient.
    If the database is unreachable, it reports ``database: "disconnected"``
    instead of returning a 500 error.
    """
    result: dict[str, str] = {"status": "ok", "version": "1.0.0"}

    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        result["database"] = "connected"
    except Exception:
        result["database"] = "disconnected"

    return result
