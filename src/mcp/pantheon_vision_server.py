#!/usr/bin/env python3
"""Small OpenCode-backed vision MCP server.

The server deliberately keeps image handling in the standard library.  Local
images are turned into data URIs; remote images remain URLs so the gateway can
fetch them.  No image, API key, or request payload is written to disk.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import mimetypes
import os
import struct
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import httpx
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("pantheon-vision")

# MCP talks JSON-RPC over stdout; all diagnostic logging must go to stderr so
# the stdio protocol never sees it.
_logger = logging.getLogger("pantheon.vision")


class _LateStderr:
    """File-like object resolving ``sys.stderr`` at write time.

    A plain ``logging.StreamHandler`` binds the import-time stderr, which
    pytest's capsys (or any runtime that swaps stderr) cannot observe.
    Resolving at emit time keeps diagnostics off stdout while remaining
    observable and redirectable.
    """

    def write(self, message: str) -> int:
        return sys.stderr.write(message)

    def flush(self) -> None:
        sys.stderr.flush()


if not _logger.handlers:
    _handler = logging.StreamHandler(_LateStderr())
    _handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    _logger.addHandler(_handler)
    _logger.setLevel(logging.INFO)
    _logger.propagate = False

MAX_IMAGE_BYTES = 25 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 20.0
HTTP_ERROR_STATUS = 400
DEFAULT_MODEL = "opencode-go/mimo-v2.5"
GO_ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions"
OPENCODE_ENDPOINT = "https://opencode.ai/zen/v1/chat/completions"
_ALLOWED_MIME_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
_EXTENSION_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}
_JPEG_MARKER = 0xFF
_JPEG_MIN_SEGMENT = 2
_JPEG_SOF_MIN_SEGMENT = 7
_PNG_HEADER_END = 24
_GIF_HEADER_END = 10
_WEBP_VP8X_END = 30


class VisionError(Exception):
    """Expected, user-facing vision error."""


@dataclass(frozen=True)
class ImageInput:
    """Validated image source and metadata available without Pillow."""

    source: str
    mime: str
    size: int | None
    width: int | None
    height: int | None


def _mime_from_bytes(data: bytes) -> str | None:
    """Identify one of the supported formats from its file signature."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _mime_from_path(path: Path) -> str | None:
    """Return a supported MIME type inferred from a path extension."""
    mime = _EXTENSION_MIME_TYPES.get(path.suffix.lower())
    if mime:
        return mime
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed if guessed in _ALLOWED_MIME_TYPES else None


def _jpeg_dimensions(data: bytes) -> tuple[int | None, int | None]:
    """Read JPEG dimensions from a start-of-frame marker."""
    if not data.startswith(b"\xff\xd8"):
        return None, None
    index = 2
    sof_markers = set(range(0xC0, 0xC4)) | set(range(0xC5, 0xC8))
    sof_markers |= set(range(0xC9, 0xCC)) | set(range(0xCD, 0xD0))
    try:
        while index + 9 < len(data):
            if data[index] != _JPEG_MARKER:
                index += 1
                continue
            while index < len(data) and data[index] == _JPEG_MARKER:
                index += 1
            marker = data[index]
            index += 1
            if marker in (0xD8, 0xD9):
                continue
            if index + 2 > len(data):
                break
            segment_length = int.from_bytes(data[index : index + 2], "big")
            if segment_length < _JPEG_MIN_SEGMENT or index + segment_length > len(data):
                break
            if marker in sof_markers and segment_length >= _JPEG_SOF_MIN_SEGMENT:
                height = int.from_bytes(data[index + 3 : index + 5], "big")
                width = int.from_bytes(data[index + 5 : index + 7], "big")
                return width, height
            index += segment_length
    except (IndexError, struct.error, ValueError):
        pass
    return None, None


def _dimensions(data: bytes, mime: str) -> tuple[int | None, int | None]:
    """Read dimensions for PNG/JPEG/WebP/GIF without a third-party decoder."""
    if mime == "image/png" and len(data) >= _PNG_HEADER_END:
        return struct.unpack(">II", data[16:_PNG_HEADER_END])
    if mime == "image/gif" and len(data) >= _GIF_HEADER_END:
        return struct.unpack("<HH", data[6:_GIF_HEADER_END])
    if mime == "image/webp" and len(data) >= _WEBP_VP8X_END and data[12:16] == b"VP8X":
        width = 1 + int.from_bytes(data[24:27], "little")
        height = 1 + int.from_bytes(data[27:30], "little")
        return width, height
    if mime == "image/jpeg":
        return _jpeg_dimensions(data)
    return None, None


def _read_local(path: Path) -> bytes:
    """Read a local file after applying the size cap."""
    try:
        size = path.stat().st_size
    except FileNotFoundError as exc:
        raise VisionError("Image file not found.") from exc
    except OSError as exc:
        raise VisionError("Image file cannot be accessed.") from exc
    if not path.is_file():
        raise VisionError("Image path is not a file.")
    if size > MAX_IMAGE_BYTES:
        raise VisionError("Image exceeds the 25 MB size limit.")
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise VisionError("Image file cannot be read.") from exc
    if len(data) > MAX_IMAGE_BYTES:
        raise VisionError("Image exceeds the 25 MB size limit.")
    return data


def _data_uri_input(value: str) -> ImageInput:
    """Validate and decode a base64 image data URI without persisting it."""
    header, separator, encoded = value.partition(",")
    if not separator or not header.lower().startswith("data:"):
        raise VisionError("Invalid image data URI.")
    pieces = header[5:].split(";")
    mime = pieces[0].lower()
    if mime not in _ALLOWED_MIME_TYPES:
        raise VisionError("Unsupported image MIME type. Use PNG, JPEG, WebP, or GIF.")
    if "base64" not in {piece.lower() for piece in pieces[1:]}:
        raise VisionError("Only base64 image data URIs are supported.")
    if len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
        raise VisionError("Image exceeds the 25 MB size limit.")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise VisionError("Invalid base64 image data.") from exc
    if len(data) > MAX_IMAGE_BYTES:
        raise VisionError("Image exceeds the 25 MB size limit.")
    width, height = _dimensions(data, mime)
    return ImageInput(value, mime, len(data), width, height)


async def _prepare_input(value: str) -> ImageInput:
    """Accept local paths, file URIs, data URIs, and remote HTTP URLs."""
    if not value or not value.strip():
        raise VisionError("Image path or URL cannot be empty.")
    value = value.strip()
    if value.lower().startswith("data:"):
        return _data_uri_input(value)

    parsed = urlparse(value)
    if parsed.scheme in {"http", "https"}:
        if not parsed.netloc:
            raise VisionError("Invalid image URL.")
        mime = _mime_from_path(Path(parsed.path))
        if mime is None and Path(parsed.path).suffix:
            raise VisionError("Unsupported image MIME type. Use PNG, JPEG, WebP, or GIF.")
        # The remote server owns the bytes.  The gateway receives the URL and
        # enforces its own fetch limits; unknown extensions remain possible.
        return ImageInput(value, mime or "image/jpeg", None, None, None)
    if parsed.scheme == "file":
        local_path = Path(unquote(parsed.path))
    elif parsed.scheme:
        raise VisionError("Only file, HTTP, and HTTPS image sources are supported.")
    else:
        local_path = Path(value).expanduser()
    data = await asyncio.to_thread(_read_local, local_path)
    detected_mime = _mime_from_bytes(data)
    extension_mime = _mime_from_path(local_path)
    mime = detected_mime or extension_mime
    if mime not in _ALLOWED_MIME_TYPES or detected_mime is None:
        raise VisionError("Unsupported image MIME type. Use PNG, JPEG, WebP, or GIF.")
    encoded = base64.b64encode(data).decode("ascii")
    width, height = _dimensions(data, mime)
    return ImageInput(
        f"data:{mime};base64,{encoded}", mime, len(data), width, height
    )


def _extract_key(value: Any) -> str | None:
    """Extract a key from the known OpenCode auth store shapes."""
    if isinstance(value, str) and value:
        return value
    if isinstance(value, dict):
        for field in (
            "key",
            "apiKey",
            "api_key",
            "token",
            "accessToken",
            "access_token",
            "access",
        ):
            candidate = value.get(field)
            if isinstance(candidate, str) and candidate:
                return candidate
    return None


def _endpoint_for_model(model: str) -> str:
    """Select the OpenCode endpoint from a model provider prefix."""
    return OPENCODE_ENDPOINT if model.startswith("opencode/") else GO_ENDPOINT


def _strip_provider_prefix(model: str) -> str:
    """Return the model ID without its provider prefix.

    The Zen gateway already encodes the provider in the endpoint URL (see
    ``_endpoint_for_model``); the /chat/completions payload must carry the bare
    model name, e.g. ``opencode-go/mimo-v2.5`` → ``mimo-v2.5``. A qualified
    model ID is rejected by the gateway with a 401 ("Model ... is not
    supported"). Models without a ``/`` are returned unchanged.
    """
    _prefix, separator, model_name = model.rpartition("/")
    return model_name if separator else model


def _resolve_auth() -> tuple[str | None, str]:
    """Resolve auth in env-first, then OpenCode auth-store order."""
    model = os.getenv("PANTHEON_VISION_MODEL") or DEFAULT_MODEL
    env_key = os.getenv("PANTHEON_OPENCODE_API_KEY") or os.getenv("OPENCODE_API_KEY")
    if env_key:
        return env_key, _endpoint_for_model(model)

    auth_path = Path.home() / ".local" / "share" / "opencode" / "auth.json"
    try:
        auth = json.loads(auth_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        auth = {}
    if isinstance(auth, dict):
        for provider, endpoint in (("opencode-go", GO_ENDPOINT), ("opencode", OPENCODE_ENDPOINT)):
            key = _extract_key(auth.get(provider))
            if key:
                return key, endpoint
    return None, _endpoint_for_model(model)


def _model() -> str:
    """Return the configured model without exposing configuration secrets."""
    return os.getenv("PANTHEON_VISION_MODEL") or DEFAULT_MODEL


def _metadata(image: ImageInput) -> dict[str, Any]:
    """Build stable, JSON-friendly local/remote image metadata."""
    dimensions = None
    if image.width is not None and image.height is not None:
        dimensions = {"width": image.width, "height": image.height}
    return {
        "mime": image.mime,
        "size": image.size,
        "width": image.width,
        "height": image.height,
        "dimensions": dimensions,
    }


def _content_text(value: Any) -> str:
    """Extract text from OpenAI-compatible message content."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        chunks = []
        for item in value:
            if isinstance(item, str):
                chunks.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                chunks.append(item["text"])
        return "".join(chunks)
    return ""


def _scrub(value: str, key: str | None) -> str:
    """Prevent an accidentally echoed API key from reaching the caller."""
    return value.replace(key, "[redacted]") if key else value


def _sanitized_gateway_body(body: dict[str, Any]) -> dict[str, Any]:
    """Non-sensitive summary of a gateway request body (no keys, no image bytes)."""
    messages = body.get("messages")
    content = messages[0].get("content") if isinstance(messages, list) and messages else None
    chunks = content if isinstance(content, list) else [content]
    parts: list[dict[str, Any]] = []
    for chunk in chunks:
        if not isinstance(chunk, dict):
            continue
        if chunk.get("type") == "image_url":
            parts.append({"type": "image_url"})
        else:
            text = chunk.get("text")
            parts.append({"type": "text", "chars": len(text) if isinstance(text, str) else 0})
    return {
        "model": body.get("model"),
        "response_format": body.get("response_format"),
        "content": parts,
    }


def _parse_json_object(value: str) -> dict[str, Any] | None:
    """Parse strict JSON and the fenced JSON commonly returned by models."""
    candidates = [value.strip()]
    if candidates[0].startswith("```") and candidates[0].endswith("```"):
        candidates.append(candidates[0].split("\n", 1)[-1][:-3].strip())
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


async def _gateway(image: ImageInput, prompt: str, *, structured: bool = False) -> str:
    """Send one multimodal request to the selected OpenCode gateway."""
    key, endpoint = _resolve_auth()
    if not key:
        raise VisionError("OpenCode API key not configured.")
    safe_prompt = prompt.replace(key, "[redacted]")
    content: list[dict[str, Any]] = [
        {"type": "text", "text": safe_prompt},
        {"type": "image_url", "image_url": {"url": image.source}},
    ]
    body: dict[str, Any] = {
        "model": _strip_provider_prefix(_model()),
        "messages": [{"role": "user", "content": content}],
    }
    if structured:
        body["response_format"] = {"type": "json_object"}
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(
                endpoint,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json=body,
            )
        if response.status_code >= HTTP_ERROR_STATUS:
            # Sanitized diagnostic: status, endpoint, bare model, truncated
            # gateway detail (scrubbed), and a body summary with no keys or
            # image bytes. Logged to stderr so the MCP stdio protocol is
            # never corrupted.
            detail = _scrub(str(getattr(response, "text", "")), key)
            _logger.warning(
                "vision gateway error status=%s endpoint=%s model=%s detail=%s body=%s",
                response.status_code,
                endpoint,
                body.get("model"),
                detail[:200] or "no detail",
                json.dumps(_sanitized_gateway_body(body)),
            )
            raise VisionError("Vision gateway returned an HTTP error.")
        payload = response.json()
        choices = payload.get("choices") if isinstance(payload, dict) else None
        message = choices[0].get("message") if choices else None
        text = _content_text(message.get("content") if isinstance(message, dict) else "")
        if not text:
            raise VisionError("Vision gateway returned an empty response.")
        return _scrub(text, key)
    except VisionError:
        raise
    except (httpx.TimeoutException, TimeoutError) as exc:
        raise VisionError("Vision gateway request timed out.") from exc
    except (httpx.HTTPError, json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
        raise VisionError("Could not read the vision gateway response.") from exc
    except Exception as exc:
        raise VisionError("Vision gateway request failed.") from exc


def _error_message(exc: Exception) -> str:
    """Return a stable, non-sensitive tool error."""
    return f"Error: {exc}" if isinstance(exc, VisionError) else "Error: Vision request failed."


_DESCRIBE_PROMPT = (
    "Describe faithfully the image content, visible text, layout, and objects. "
    "Mention uncertainty rather than guessing. Respond in clear prose."
)
_OCR_PROMPT = (
    "Perform OCR on this image. Transcribe all visible text exactly, preserving "
    "lines, spacing, punctuation, and formatting (formatação) where possible. If there is no "
    "text, say clearly that no text was found. Do not describe the image."
)
_ANALYZE_PROMPT = (
    "Analyze this image and return only a JSON object with string fields "
    "description and ocr. Describe content, layout, objects, and uncertainty; "
    "ocr must preserve visible text formatting or say no text was found."
)


@mcp.tool(description="Describe an image faithfully using the Pantheon vision gateway.")
async def vision_describe(path: str, prompt: str | None = None) -> str:
    """Describe image content, text, layout, objects, and uncertainty."""
    try:
        image = await _prepare_input(path)
        return await _gateway(image, prompt or _DESCRIBE_PROMPT)
    except Exception as exc:
        return _error_message(exc)


@mcp.tool(description="Extract visible text from an image with OCR.")
async def vision_ocr(path: str) -> str:
    """Transcribe visible image text while preserving line formatting."""
    try:
        image = await _prepare_input(path)
        return await _gateway(image, _OCR_PROMPT)
    except Exception as exc:
        return _error_message(exc)


@mcp.tool(description="Analyze an image and return metadata, description, and OCR as JSON.")
async def vision_analyze(path: str) -> str:
    """Return local metadata plus one structured description/OCR gateway call."""
    try:
        image = await _prepare_input(path)
        content = await _gateway(image, _ANALYZE_PROMPT, structured=True)
        parsed = _parse_json_object(content)
        if parsed is None:
            parsed = {"description": content, "ocr": "No structured OCR was returned."}
        result = {
            "metadata": _metadata(image),
            "description": str(parsed.get("description", "")),
            "ocr": str(parsed.get("ocr", "No text found.")),
        }
        return json.dumps(result, ensure_ascii=False)
    except Exception as exc:
        return _error_message(exc)


if __name__ == "__main__":
    mcp.run()
