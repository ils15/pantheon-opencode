"""FastAPI application — user registration endpoint."""

import re

from email_validator import EmailNotValidError, validate_email as lib_validate_email
from fastapi import FastAPI, HTTPException, status

from models import ErrorResponse, RegisterRequest, UserResponse
from storage import add_user, get_user_by_email

app = FastAPI(title="User Registration API", version="0.1.0")

# ── Password rules ──────────────────────────────────────────────
_PASSWORD_MIN_LEN = 8
_RE_DIGIT = re.compile(r"\d")
_RE_SPECIAL = re.compile(r"[!@#$%^&*(),.?\":{}|<>_\-+=~`[\]\\;'/\|]")


def _validate_email(email: str) -> str:
    """Validate email format, return normalised form or raise 400."""
    try:
        result = lib_validate_email(email, check_deliverability=False)
        return result.normalized
    except EmailNotValidError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )


def _validate_password(password: str) -> None:
    """Validate password strength or raise 400."""
    if len(password) < _PASSWORD_MIN_LEN:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Password must be at least {_PASSWORD_MIN_LEN} characters",
        )
    if not _RE_DIGIT.search(password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password must contain at least one digit",
        )
    if not _RE_SPECIAL.search(password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password must contain at least one special character",
        )


@app.post(
    "/api/auth/register",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
    responses={
        400: {"model": ErrorResponse, "description": "Validation error"},
        409: {"model": ErrorResponse, "description": "Email already exists"},
    },
)
async def register(payload: RegisterRequest) -> UserResponse:
    """Register a new user.

    Validates email format and password strength, then stores the user
    in memory.  Returns the created user (without password).
    """
    # 1. Validate email (→ 400)
    normalised_email = _validate_email(payload.email)

    # 2. Validate password (→ 400)
    _validate_password(payload.password)

    # 3. Check duplicate (→ 409)
    if get_user_by_email(normalised_email):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"User with email '{normalised_email}' already exists",
        )

    # 4. Persist
    record = add_user(
        email=normalised_email,
        password=payload.password,
        name=payload.name,
    )

    return UserResponse(id=record["id"], email=record["email"], name=record["name"])
