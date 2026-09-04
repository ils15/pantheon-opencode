"""RED tests for env sanitization and prlimit resource limits.

Covers:
- _build_script_env: allowlist-only env, unknown vars excluded, empty env safe default
- _prlimit_prefix: None when prlimit_path is None, correct prefix otherwise
"""
from __future__ import annotations

import importlib
from unittest.mock import patch

import pytest

MODULE_PATH = "src.mcp.code_mode_server"


@pytest.fixture(scope="session")
def module():
    """Import and return the server module."""
    mod = importlib.import_module(MODULE_PATH)
    importlib.reload(mod)
    return mod


# =============================================================================
# _build_script_env
# =============================================================================


class TestBuildScriptEnv:
    """Tests for _build_script_env allowlist filtering."""

    def test_only_allowlisted_vars_pass_through(self, module) -> None:
        """Vars in the allowlist should appear in the result."""
        fake_env = {
            "PATH": "/usr/bin",
            "HOME": "/home/test",
            "LANG": "en_US.UTF-8",
            "PANTHEON_HOME": "/opt/pantheon",
            "PANTHEON_PROJECT": "/project",
            "OPENAI_API_KEY": "sk-test",
            "OPENAI_BASE_URL": "https://api.openai.com",
            "EVAL_JUDGE_MODEL": "gpt-4",
            "SHELL": "/bin/bash",
            "USER": "testuser",
        }
        result = module._build_script_env(fake_env)
        assert result["PATH"] == "/usr/bin"
        assert result["HOME"] == "/home/test"
        assert result["OPENAI_API_KEY"] == "sk-test"
        assert result["USER"] == "testuser"

    def test_unknown_vars_excluded(self, module) -> None:
        """Vars NOT in the allowlist should be excluded."""
        fake_env = {
            "PATH": "/usr/bin",
            "HOME": "/home/test",
            "MY_SECRET_TOKEN": "secret123",
            "AWS_ACCESS_KEY_ID": "AKIA",
            "DATABASE_URL": "postgres://localhost/db",
            "RANDOM_VAR": "nope",
        }
        result = module._build_script_env(fake_env)
        assert "MY_SECRET_TOKEN" not in result
        assert "AWS_ACCESS_KEY_ID" not in result
        assert "DATABASE_URL" not in result
        assert "RANDOM_VAR" not in result

    def test_empty_env_safe_default(self, module) -> None:
        """Empty input env should produce a safe default with at least PATH."""
        result = module._build_script_env({})
        # PATH should always be set (safe default)
        assert "PATH" in result
        assert isinstance(result["PATH"], str)

    def test_env_dict_is_new_not_mutated(self, module) -> None:
        """The returned dict must be a new dict, not a reference to input."""
        fake_env = {"PATH": "/usr/bin", "HOME": "/home/test"}
        result = module._build_script_env(fake_env)
        result["INJECTED"] = "bad"
        assert "INJECTED" not in module._build_script_env(fake_env)

    def test_extra_env_set_passthrough(self, module) -> None:
        """CODE_MODE_EXTRA_ENV vars should pass through when present."""
        extra = {"MY_CUSTOM_VAR"}
        fake_env = {"PATH": "/usr/bin", "MY_CUSTOM_VAR": "yes"}
        with patch.object(module, "CODE_MODE_EXTRA_ENV", extra):
            result = module._build_script_env(fake_env)
        assert result["MY_CUSTOM_VAR"] == "yes"


# =============================================================================
# _prlimit_prefix
# =============================================================================


class TestPrlimitPrefix:
    """Tests for _prlimit_prefix command prefix generation."""

    def test_none_when_no_prlimit(self, module) -> None:
        """_prlimit_prefix(None) returns None (no wrapping)."""
        assert module._prlimit_prefix(None) is None

    def test_none_when_empty_string(self, module) -> None:
        """_prlimit_prefix('') returns None."""
        assert module._prlimit_prefix("") is None

    def test_correct_prefix_when_prlimit_available(self, module) -> None:
        """_prlimit_prefix('/usr/bin/prlimit') returns the prlimit command."""
        result = module._prlimit_prefix("/usr/bin/prlimit")
        assert result is not None
        assert result[0] == "/usr/bin/prlimit"
        assert "--nproc=512" in result
        assert "--as=1073741824" in result  # 1 GiB in bytes
        # CPU limit should be present (timeout+5)
        cpu_args = [a for a in result if a.startswith("--cpu=")]
        assert len(cpu_args) == 1

    def test_cpu_limit_includes_timeout_plus_5(self, module) -> None:
        """CPU timeout should be timeout_s + 5."""
        result = module._prlimit_prefix("/usr/bin/prlimit", timeout_s=10)
        cpu_arg = next(a for a in result if a.startswith("--cpu="))
        assert cpu_arg == "--cpu=15"


# =============================================================================
# Env passed to subprocess (integration)
# =============================================================================


class TestSubprocessEnvIntegration:
    """Verify that execute_code_script uses the sanitized env."""

    async def test_script_does_not_inherit_full_env(self, module) -> None:
        """A script should NOT see env vars outside the allowlist."""
        # Write a script that dumps a secret env var
        secret_script = (
            '#!/usr/bin/env python3\n'
            'import os\n'
            'secret = os.environ.get("CODE_MODE_TEST_SECRET", "NOT_SET")\n'
            'print(f"SECRET:{secret}")\n'
        )
        from pathlib import Path

        scripts_dir = Path(__file__).resolve().parent.parent / ".pantheon" / "code-mode"
        path = scripts_dir / "env_leak_test.py"
        path.write_text(secret_script, encoding="utf-8")
        path.chmod(0o755)
        try:
            # Inject a secret into the current process env
            import os

            os.environ["CODE_MODE_TEST_SECRET"] = "SHOULD_NOT_LEAK"
            try:
                result = await module.execute_code_script("env_leak_test.py", json_output=True)
                # The script should NOT see the secret
                assert "SHOULD_NOT_LEAK" not in result["stdout"]
                assert "SECRET:NOT_SET" in result["stdout"]
            finally:
                del os.environ["CODE_MODE_TEST_SECRET"]
        finally:
            path.unlink(missing_ok=True)

    async def test_script_sees_allowlisted_vars(self, module) -> None:
        """A script should see PATH and HOME from the sanitized env."""
        check_script = (
            '#!/usr/bin/env python3\n'
            'import os\n'
            'print(f"PATH_SET:{bool(os.environ.get(' + "'PATH'" + '))}")\n'
            'print(f"HOME_SET:{bool(os.environ.get(' + "'HOME'" + '))}")\n'
        )
        from pathlib import Path

        scripts_dir = Path(__file__).resolve().parent.parent / ".pantheon" / "code-mode"
        path = scripts_dir / "env_allow_test.py"
        path.write_text(check_script, encoding="utf-8")
        path.chmod(0o755)
        try:
            result = await module.execute_code_script("env_allow_test.py", json_output=True)
            assert "PATH_SET:True" in result["stdout"]
            assert "HOME_SET:True" in result["stdout"]
        finally:
            path.unlink(missing_ok=True)
