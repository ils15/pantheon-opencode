#!/usr/bin/env bash

# Configure a Pantheon sandbox without inheriting host user-data paths.
pantheon_validate_sandbox_path() {
  local path="$1"
  local current="/"
  local component
  local -a components
  local LC_ALL=C

  if [[ "$path" =~ [[:cntrl:]] || "$path" != /* ]]; then
    printf 'ERROR: sandbox path validation failed.\n' >&2
    return 2
  fi

  IFS='/' read -r -a components <<< "$path"
  for component in "${components[@]}"; do
    case "$component" in
      '' | .) continue ;;
      ..)
        printf 'ERROR: sandbox path validation failed.\n' >&2
        return 2
        ;;
    esac

    if [[ "$current" == / ]]; then
      current="/$component"
    else
      current="$current/$component"
    fi
    if [[ -L "$current" ]]; then
      printf 'ERROR: sandbox path validation failed.\n' >&2
      return 2
    fi
  done
  return 0
}

pantheon_validate_sandbox_root() {
  local sandbox_root="$1"
  local LC_ALL=C

  if [[ "$sandbox_root" =~ [[:cntrl:]] || "$sandbox_root" != /* ]]; then
    printf 'ERROR: sandbox path validation failed.\n' >&2
    return 2
  fi

  if [[ "$(pantheon_normalize_sandbox_path "$sandbox_root")" == / ]]; then
    printf 'ERROR: sandbox path validation failed.\n' >&2
    return 2
  fi

  pantheon_validate_sandbox_path "$sandbox_root"
}

pantheon_normalize_sandbox_path() {
  local path="$1" component normalized=""
  local -a components

  IFS='/' read -r -a components <<< "$path"
  for component in "${components[@]}"; do
    case "$component" in
      '' | .) continue ;;
    esac
    if [[ -z "$normalized" ]]; then
      normalized="/$component"
    else
      normalized="$normalized/$component"
    fi
  done
  printf '%s' "${normalized:-/}"
}

# Validate configurable file paths before a caller creates their parent
# directories or launches OpenCode. Reject traversal and symlink components
# first, then compare normalized absolute paths on complete component
# boundaries so a sibling such as sandbox-extra is not accepted.
pantheon_validate_sandbox_file_path() {
  local sandbox_root="$1" file_path="$2" normalized_root normalized_file
  local LC_ALL=C

  if ! pantheon_validate_sandbox_root "$sandbox_root" >/dev/null 2>&1 \
    || ! pantheon_validate_sandbox_path "$file_path" >/dev/null 2>&1; then
    printf 'ERROR: sandbox config/database path validation failed.\n' >&2
    return 2
  fi

  normalized_root="$(pantheon_normalize_sandbox_path "$sandbox_root")"
  normalized_file="$(pantheon_normalize_sandbox_path "$file_path")"
  if [[ "$normalized_file" == "$normalized_root"/* ]]; then
    return 0
  fi

  printf 'ERROR: sandbox config/database path validation failed.\n' >&2
  return 2
}

# The config's parent is passed as OPENCODE_CONFIG_DIR and may be used for
# reads/writes by OpenCode. Keep both the file and that parent strictly below
# the canonical sandbox root (not the root itself or its parent).
pantheon_validate_sandbox_config_path() {
  local sandbox_root="$1" config_path="$2"
  local normalized_root normalized_config normalized_parent config_parent
  local LC_ALL=C

  pantheon_validate_sandbox_file_path "$sandbox_root" "$config_path" || return $?
  normalized_root="$(pantheon_normalize_sandbox_path "$sandbox_root")"
  normalized_config="$(pantheon_normalize_sandbox_path "$config_path")"
  config_parent="$(dirname "$config_path")"
  normalized_parent="$(pantheon_normalize_sandbox_path "$config_parent")"

  if [[ "$normalized_config" != "$normalized_root"/* \
    || "$normalized_parent" == "$normalized_root" \
    || "$normalized_parent" != "$normalized_root"/* ]]; then
    printf 'ERROR: sandbox config/database path validation failed.\n' >&2
    return 2
  fi
}

pantheon_sandbox_env() {
  local sandbox_root="$1"
  local sandbox_home="$2"
  local npm_prefix="$3"
  local python_venv="$4"
  local opencode_config_dir="$5"

  pantheon_validate_sandbox_root "$sandbox_root" || return $?

  export HOME="$sandbox_home"
  export PATH="$npm_prefix/bin:$python_venv/bin:$PATH"
  export npm_config_prefix="$npm_prefix"
  export XDG_CONFIG_HOME="$sandbox_home/.config"
  export XDG_CONFIG_DIRS="$sandbox_home/.config/xdg"
  export XDG_DATA_HOME="$HOME/.local/share"
  export XDG_DATA_DIRS="$sandbox_home/.local/share/xdg"
  export XDG_STATE_HOME="$sandbox_home/.local/state"
  export XDG_CACHE_HOME="$sandbox_home/.cache"
  export XDG_RUNTIME_DIR="$sandbox_root/run"
  export PANTHEON_HOME="$XDG_CONFIG_HOME/opencode"
  export TMPDIR="$sandbox_root/tmp"
  export TMP="$TMPDIR"
  export TEMP="$TMPDIR"
  export OPENCODE_CONFIG_DIR="$opencode_config_dir"
  unset OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_CONFIG_PROJECT_DISABLE \
    OPENCODE_DATA_DIR OPENCODE_STATE_DIR OPENCODE_CACHE_DIR OPENCODE_STORAGE_PATH
  unset LOG_PATH
  LOG_PATH="$XDG_DATA_HOME/opencode/log/opencode.log"

  local path
  local -a sandbox_paths=(
    "$sandbox_root" "$sandbox_home" "$npm_prefix" "$python_venv" "$opencode_config_dir"
    "$XDG_CONFIG_HOME" "$XDG_CONFIG_DIRS" "$XDG_DATA_HOME" "$XDG_DATA_DIRS"
    "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" "$PANTHEON_HOME" "$TMPDIR"
  )
  for path in "${sandbox_paths[@]}"; do
    pantheon_validate_sandbox_path "$path" || return $?
  done

  (
    umask 077
    mkdir -p \
      "$XDG_CONFIG_HOME" "$XDG_CONFIG_DIRS" \
      "$XDG_DATA_HOME" "$XDG_DATA_DIRS" \
      "$XDG_STATE_HOME" "$XDG_CACHE_HOME" \
      "$PANTHEON_HOME" "$TMPDIR" "$XDG_RUNTIME_DIR"
  ) || return $?

  # Re-check after mkdir before chmod, in case a path component changed while
  # the sandbox directories were being created.
  for path in "${sandbox_paths[@]}"; do
    pantheon_validate_sandbox_path "$path" || return $?
  done
  chmod 700 "$TMPDIR" "$XDG_RUNTIME_DIR" || return $?
}
