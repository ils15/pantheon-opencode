"""Tests for authenticate_user function."""
from unittest.mock import MagicMock

import pytest

from sample import User, HTTPException, authenticate_user


class TestAuthenticateUser:
    """Test suite for authenticate_user function."""

    def test_success_returns_user(self):
        """Should return user when credentials are valid."""
        mock_db = MagicMock()
        mock_user = User(email="test@example.com", password="hashed_pw")
        mock_db.query.return_value.filter.return_value.first.return_value = mock_user

        result = authenticate_user("test@example.com", "password123", db=mock_db)

        assert result is mock_user
        mock_db.query.assert_called_once_with(User)

    def test_user_not_found_raises_404(self):
        """Should raise 404 when user not found."""
        mock_db = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = None

        with pytest.raises(HTTPException) as exc:
            authenticate_user("unknown@example.com", "password123", db=mock_db)

        assert exc.value.status_code == 404
        assert "not found" in exc.value.detail.lower()

    def test_database_error_raises_500(self):
        """Should raise 500 on database error."""
        mock_db = MagicMock()
        mock_db.query.side_effect = Exception("DB connection lost")

        with pytest.raises(HTTPException) as exc:
            authenticate_user("test@example.com", "password123", db=mock_db)

        assert exc.value.status_code == 500
        assert "database" in exc.value.detail.lower()

    def test_empty_email_raises_value_error(self):
        """Should raise ValueError for empty email."""
        with pytest.raises(ValueError, match="Email and password are required"):
            authenticate_user("", "password123", db=MagicMock())

    def test_empty_password_raises_value_error(self):
        """Should raise ValueError for empty password."""
        with pytest.raises(ValueError, match="Email and password are required"):
            authenticate_user("test@example.com", "", db=MagicMock())

    def test_none_email_raises_value_error(self):
        """Should raise ValueError for None email."""
        with pytest.raises(ValueError, match="Email and password are required"):
            authenticate_user(None, "password123", db=MagicMock())  # type: ignore[arg-type]
