#!/bin/sh
# Refuse a new fleet value. See CLAUDE.md. Does not set core.hooksPath.
set -u
root=$(git rev-parse --show-toplevel) || exit 1
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not installed; cannot scan for fleet values." >&2
  exit 1
fi
# Fleet rules, without the default allowlist (that allowlist hides a /home/ path).
if ! gitleaks git --pre-commit --staged --no-banner --redact \
  --config "$root/.gitleaks.toml" \
  "$root" >/dev/null 2>&1; then
  echo "fleet value; put it in the operator's private deploy notes (see CLAUDE.md)" >&2
  exit 1
fi
# Default secret rules, selected by their own config. Omitting --config makes
# gitleaks load .gitleaks.toml again, which does not extend the defaults.
if ! gitleaks git --pre-commit --staged --no-banner --redact \
  --config "$root/scripts/gitleaks-defaults.toml" \
  "$root" >/dev/null 2>&1; then
  echo "gitleaks: a staged secret was found." >&2
  exit 1
fi
exit 0
