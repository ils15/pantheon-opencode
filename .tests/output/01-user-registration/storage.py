"""In-memory user storage (no real database)."""

import uuid
from typing import Dict, Optional

_USER_STORE: Dict[str, dict] = {}  # email → user record


def _reset_store() -> None:
    """Clear all stored users (used by tests)."""
    _USER_STORE.clear()


def add_user(email: str, password: str, name: str) -> dict:
    """Insert a new user.

    Raises
    ------
    ValueError
        If *email* already exists.

    Returns
    -------
    dict
        The stored user record (includes ``id``, ``email``, ``name``).
    """
    if email in _USER_STORE:
        raise ValueError(f"User with email '{email}' already exists")

    record = {
        "id": str(uuid.uuid4()),
        "email": email,
        "password": password,  # plain text — demo only, never do this in prod
        "name": name,
    }
    _USER_STORE[email] = record
    return record


def get_user_by_email(email: str) -> Optional[dict]:
    """Return a user record or ``None``."""
    return _USER_STORE.get(email)
