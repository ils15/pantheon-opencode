"""Shared fixtures and helpers for scenario tests.

Test configuration for Pantheon.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

# Add MCP server source to path for direct imports
SRC_DIR = (
    Path(__file__).resolve().parents[1]
    / "scripts"
)
sys.path.insert(0, str(SRC_DIR))


# ---------------------------------------------------------------------------
# Fixtures — realistic development conversations
# ---------------------------------------------------------------------------


@pytest.fixture
def auth_conversation() -> list[str]:
    """Simulate a conversation about implementing JWT auth.

    15 turns, mixing high-importance (auth, token, security)
    and low-importance (CSS, typo) content.
    """
    return [
        "Planning the auth endpoint structure with JWT and refresh tokens.",
        "Creating JWT token service with access and refresh token generation.",
        "Implementing login endpoint with email/password validation using bcrypt.",
        "Added password hashing with bcrypt and salt rounds.",
        "Fixed a CSS typo in the login button hover color.",
        "Writing tests for auth endpoint — login, refresh, logout flows.",
        "Adding refresh token rotation logic with token family tracking.",
        "Migration: add refresh_tokens table with FK to users table.",
        "Fixed a typo in the README documentation for setup instructions.",
        "All auth tests passing, 95% coverage with 42 test cases.",
        "Adding rate limiting to login endpoint — 5 attempts per minute.",
        "CSS tweak: changed the sidebar background from #fff to #f8f9fa.",
        "Implementing token blacklist for logout functionality.",
        "Updated swagger docs with auth endpoint request/response schemas.",
        "Fixed indentation in the auth router test file.",
    ]


@pytest.fixture
def mixed_priority_conversation() -> list[str]:
    """Conversation with mixed priorities across all bands."""
    return [
        "Added JWT auth endpoint with refresh token rotation.",
        "API key configuration for external service integration.",
        "The new schema migration adds a refresh_tokens table.",
        "Refactored the user service to use dependency injection.",
        "Fixed CSS button styling issue — color change only.",
        "Typo fix in the login page label from 'Sing In' to 'Sign In'.",
        "Created new auth service with JWT and token rotation.",
        "Updated deployment config for new auth service.",
        "Added index on refresh_tokens.token_hash column for faster lookups.",
        "CSS tweak: changed padding from 8px to 12px on cards.",
    ]


@pytest.fixture
def migration_conversation() -> list[str]:
    """Simulate conversation about a database migration."""
    return [
        "Adding refresh_tokens table to support JWT refresh token rotation.",
        "CREATE TABLE refresh_tokens (id UUID PRIMARY KEY, user_id UUID NOT NULL, token_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());",
        "ALTER TABLE refresh_tokens ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;",
        "CREATE UNIQUE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);",
        "Created Alembic migration script rev1234_add_refresh_tokens.py.",
        "Tested migration upgrade — table created with correct schema.",
        "Tested migration downgrade — table dropped cleanly.",
        "Verified foreign key constraint cascades on user delete.",
        "Index on token_hash for O(1) lookup on refresh operations.",
        "Migration reviewed by Demeter — approved with no changes.",
        "Search result: found 3 migration files.",
        "Reading backend/models/refresh_token.py...",
        "Search result: found 3 migration files.",
        "Reading backend/models/refresh_token.py...",
        "Migration complete — all tests passing.",
    ]


@pytest.fixture
def agent_handoff_conversation() -> list[str]:
    """Simulate a Zeus->Hermes->Themis agent pipeline conversation."""
    return [
        "Zeus: Task Hermes to implement JWT auth endpoint with refresh.",
        "Hermes: Created auth router with /login, /refresh, /logout endpoints.",
        "Hermes: Added JWT token service with access+refresh token generation.",
        "Hermes: Login validates email/password via bcrypt.",
        "Hermes: Refresh endpoint rotates refresh tokens with family tracking.",
        "Hermes: All 42 tests passing, 95% coverage.",
        "Zeus: Handoff to Themis for code review.",
        "Themis: REVIEW status: APPROVED. Found 0 critical, 2 minor issues.",
        "Themis: Minor: add rate limiting to login endpoint (HIGH).",
        "Themis: Minor: add input validation for email format (MEDIUM).",
        "Hermes: Fixed both minor issues — rate limiting and validation added.",
        "Zeus: Phase 1 complete. Compressing context for Phase 2.",
        "Zeus: Injecting compressed context to Hermes for frontend integration.",
        "Hermes: Creating frontend API client for auth endpoints.",
        "Zeus: Sprint progress — Phase 1 done, Phase 2 started.",
    ]


@pytest.fixture
def heavy_conversation() -> list[str]:
    """Generate 50+ turns of mixed development conversation."""
    turns = [
        # Auth work (CRITICAL)
        "Added JWT auth endpoint with access and refresh token rotation.",
        "Implemented login with email/password validation using bcrypt.",
        "Refresh token rotation with token family tracking and blacklist.",
        "Rate limiting on login endpoint — 5 attempts per minute.",
        "Token blacklist stored in Redis with 7-day TTL.",
        # Schema work (CRITICAL)
        "Schema migration: added refresh_tokens table with FK to users.",
        "CREATE TABLE refresh_tokens with UUID PK, token_hash, expires_at.",
        "Unique index on refresh_tokens.token_hash for fast lookup.",
        "Alembic migration tested both upgrade and downgrade paths.",
        "Foreign key cascade — deleting user revokes all refresh tokens.",
        # API work (HIGH)
        "New user API endpoint: GET /users/{id}/sessions returns active sessions.",
        "API key authentication for machine-to-machine endpoints.",
        "Pagination and filtering for /admin/users list endpoint.",
        "Versioned API routes with /v1/ prefix for all endpoints.",
        "API response envelope with status, data, meta fields.",
        # Service refactoring (MEDIUM)
        "Refactored AuthService into smaller Single Responsibility classes.",
        "Extracted TokenService from AuthService for cleaner separation.",
        "Created UserService with dependency injection pattern.",
        "Added RedisCache service with connection pooling.",
        "Refactored error handling into middleware pattern.",
        # CSS and styling (LOW)
        "Fixed CSS button hover color from #333 to #555.",
        "Updated sidebar width from 280px to 300px responsive.",
        "CSS tweak: card padding 16px instead of 12px.",
        "Changed font size in table header from 14px to 13px.",
        "Typography: adjusted line-height from 1.5 to 1.6.",
        # Documentation (LOW)
        "Fixed typo in README: 'recieve' -> 'receive'.",
        "Updated docstring in auth router — corrected param types.",
        "Fixed spelling in comment: 'occured' -> 'occurred'.",
        "Removed stale TODO comments from user service.",
        "Grammar fix in API documentation intro paragraph.",
        # More CRITICAL work (sprinkled throughout)
        "Security audit: password minimum 12 characters enforced.",
        "JWT signing key rotated — old key kept for 5 min grace period.",
        "Added CSRF protection middleware for all mutation endpoints.",
        "SQL injection prevention — parameterized queries verified.",
        # More HIGH
        "Database connection pool size increased from 5 to 20.",
        "Cache invalidation on user profile update via Redis pub/sub.",
        "Async background job for cleaning expired tokens.",
        # More MEDIUM
        "Renamed UserRepository to UserDAO for consistency.",
        "Extracted config into Pydantic Settings class.",
        "Added request ID middleware for distributed tracing.",
        # Edge cases and testing
        "Edge case: expired refresh token returns 401 with clear message.",
        "Test: concurrent refresh requests — only first succeeds.",
        "Test: revoked token reuse detection — returns 401 with 'token_revoked'.",
        "Performance: 1000 concurrent login attempts in under 2 seconds.",
        # Final wrap-up
        "Zeus: All phases complete. Compressing full session context.",
        "Mnemosyne: ZZ-phase4-context.md written to .tmp/.",
        "Themis: Final review APPROVED — all 128 tests passing at 91% coverage.",
    ]
    return turns


# ---------------------------------------------------------------------------
# Custom assertion helpers
# ---------------------------------------------------------------------------


def assert_compression_ratio(
    original: str,
    compressed: str,
    min_ratio: float = 0.3,
) -> None:
    """Assert compression ratio meets minimum threshold.

    Args:
        original: Original uncompressed text.
        compressed: Compressed result.
        min_ratio: Minimum ratio required (default 0.3 = 30% reduction).

    Raises:
        AssertionError: If ratio is below minimum.
    """
    if not original:
        pytest.skip("Empty original — cannot compute ratio")
    ratio = 1 - (len(compressed) / len(original))
    assert ratio >= min_ratio, (
        f"Compression ratio {ratio:.1%} < {min_ratio:.1%} "
        f"({len(original)} -> {len(compressed)} chars, diff={len(original) - len(compressed)} chars)"
    )
