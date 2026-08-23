#!/usr/bin/env bash
set -euo pipefail

fail=0
while IFS=: read -r file line_no line; do
  value=${line#*uses:}
  value=${value%%#*}
  value=$(printf '%s' "$value" | xargs)
  [[ -z "$value" ]] && continue
  [[ "$value" == ./* || "$value" == ../* ]] && continue
  if [[ "$value" != *@* ]]; then
    echo "workflow action is missing an explicit ref: $file:$line_no: $value" >&2
    fail=1
    continue
  fi
  ref=${value##*@}
  if [[ ! "$ref" =~ ^[0-9a-f]{40}$ ]]; then
    echo "workflow action ref is not pinned to a full SHA: $file:$line_no: $value" >&2
    fail=1
  fi
done < <(grep -RInE '^[[:space:]]*uses:[[:space:]]*[^[:space:]]+' .github/workflows || true)

exit "$fail"
