"""Regression tests for checkpoint validation on the live context_save tool."""

from __future__ import annotations

import pytest
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.exceptions import ValidationError as FastMCPValidationError
from pydantic import ValidationError as PydanticValidationError

MCP_VALIDATION_ERRORS = (
    ToolError,
    FastMCPValidationError,
    PydanticValidationError,
)


class TestLiveCheckpointValidation:
    """Validation must stay reachable through the registered save tool."""

    async def test_context_save_rejects_wrong_section_shape(
        self, server: FastMCP
    ) -> None:
        with pytest.raises(
            MCP_VALIDATION_ERRORS, match=r"content\.phase must be an object"
        ):
            await server.call_tool(
                "context_save",
                {
                    "slug": "shape-validation",
                    "key": "latest",
                    "content": '{"phase": 3}',
                    "session_id": "shape-validation-session",
                },
            )

    async def test_context_save_rejects_invalid_tail_item(
        self, server: FastMCP
    ) -> None:
        with pytest.raises(MCP_VALIDATION_ERRORS, match="tail entries must be strings"):
            await server.call_tool(
                "context_save",
                {
                    "slug": "tail-validation",
                    "key": "latest",
                    "content": '{"tail": [1]}',
                    "session_id": "tail-validation-session",
                },
            )
