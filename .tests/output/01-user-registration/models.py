"""Pydantic schemas for the registration API."""

from pydantic import BaseModel


class RegisterRequest(BaseModel):
    """Payload for ``POST /api/auth/register``."""

    email: str
    password: str
    name: str


class UserResponse(BaseModel):
    """Public user info returned after registration (no password)."""

    id: str
    email: str
    name: str


class ErrorResponse(BaseModel):
    """Standard error payload."""

    detail: str
