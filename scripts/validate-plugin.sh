#!/usr/bin/env bash
set -euo pipefail

plugin_dir="${1:-.}"
manifest="$plugin_dir/manifest.json"

fail() {
  echo "validate-plugin: $*" >&2
  exit 1
}

[[ -d "$plugin_dir" ]] || fail "plugin folder not found: $plugin_dir"
[[ -f "$manifest" ]] || fail "missing manifest.json in $plugin_dir"

jq -e . "$manifest" >/dev/null || fail "manifest.json is not valid JSON"
jq -e '.schemaVersion == 1' "$manifest" >/dev/null \
  || fail "unsupported or missing schemaVersion (expected 1)"

for field in id name version kinds entryPoints; do
  jq -e --arg f "$field" 'has($f)' "$manifest" >/dev/null \
    || fail "manifest missing required field '$field'"
done

id=$(jq -r '.id // ""' "$manifest")
[[ -n "$id" ]] || fail "manifest 'id' is empty"
[[ "$id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail "invalid plugin id '$id'"
[[ "$id" != *".."* ]] || fail "invalid plugin id '$id'"
[[ "$id" != omarchy.* ]] || fail "plugin id '$id' uses the reserved omarchy.* namespace"

jq -e '(.kinds | type) == "array" and (.kinds | length) > 0' "$manifest" >/dev/null \
  || fail "'kinds' must be a non-empty array"
jq -e '(.entryPoints | type) == "object"' "$manifest" >/dev/null \
  || fail "'entryPoints' must be an object"

jq -e '
  if ((.barWidget? | type) == "object" and (.barWidget | has("defaultSection"))) then
    .barWidget.defaultSection as $section
    | ($section | type) == "string"
      and (["left", "center", "right"] | index($section)) != null
  else
    true
  end
' "$manifest" >/dev/null \
  || fail "'barWidget.defaultSection' must be left, center, or right"

while IFS= read -r ep_json; do
  [[ -n "$ep_json" ]] || continue
  ep=$(jq -r '.' <<<"$ep_json")
  [[ -n "$ep" ]] || fail "entry point path is empty"
  [[ "$ep" != *$'\n'* ]] || fail "entry point may not contain a newline"
  [[ "$ep" != /* ]] || fail "entry point must be a relative path: '$ep'"
  [[ "$ep" != *".."* ]] || fail "entry point may not contain '..': '$ep'"
  [[ -f "$plugin_dir/$ep" ]] || fail "entry point file not found: '$ep'"
done < <(jq -c '.entryPoints | to_entries[] | .value' "$manifest")

for kind_entry_point in \
  "bar:bar" \
  "bar-widget:barWidget" \
  "menu:menu" \
  "overlay:overlay" \
  "panel:panel" \
  "service:service"; do
  kind="${kind_entry_point%%:*}"
  entry_point="${kind_entry_point##*:}"
  jq -e --arg kind "$kind" '(.kinds | index($kind)) != null' "$manifest" >/dev/null || continue
  jq -e --arg ep "$entry_point" '.entryPoints | has($ep)' "$manifest" >/dev/null \
    || fail "kind '$kind' requires an 'entryPoints.$entry_point' to load"
done

link=$(find "$plugin_dir" -name .git -prune -o -type l -print -quit 2>/dev/null)
[[ -z "$link" ]] || fail "symlinks are not allowed inside a plugin folder: $link"

echo "Plugin manifest is valid: $id"
