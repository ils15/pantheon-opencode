# Pytest configuration
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
for p in [PROJECT_ROOT, PROJECT_ROOT / "src" / "mcp", PROJECT_ROOT / "scripts"]:
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

_CODE_MODE_MANIFEST = PROJECT_ROOT / ".pantheon" / "code-mode" / "manifest.json"


@pytest.fixture(autouse=True)
def _restore_code_mode_manifest():
    """Restore the shipped code-mode manifest after each test.

    B3-08 makes script execution opt-in via a SHA-256 manifest. Tests that
    exercise the approve path write to that file; this guard keeps the
    tracked manifest pristine and avoids cross-test leakage.
    """
    original = (
        _CODE_MODE_MANIFEST.read_text(encoding="utf-8")
        if _CODE_MODE_MANIFEST.is_file()
        else None
    )
    try:
        yield
    finally:
        current = (
            _CODE_MODE_MANIFEST.read_text(encoding="utf-8")
            if _CODE_MODE_MANIFEST.is_file()
            else None
        )
        if current != original:
            if original is None:
                _CODE_MODE_MANIFEST.unlink(missing_ok=True)
            else:
                _CODE_MODE_MANIFEST.write_text(original, encoding="utf-8")

