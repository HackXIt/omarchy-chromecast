#!/usr/bin/env bash
set -euo pipefail

# Legacy/pre-Quattro helper install only.
# Omarchy Quattro installs this repository with `omarchy plugin add` and calls
# bin/chromium-castctl directly; it does not run this script.

repo_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_bin="$repo_dir/bin/chromium-castctl"
target_dir="${HOME:?}/.local/bin"
target="$target_dir/chromium-castctl"
font_source="/usr/share/fonts/WOFF2/fa-brands-400.woff2"
font_dir="${XDG_DATA_HOME:-$HOME/.local/share}/fonts/chromium-castctl"
font_target="$font_dir/chromium-castctl-icons.otf"

if [[ ! -x "$source_bin" ]]; then
  chmod +x "$source_bin"
fi

mkdir -p "$target_dir"
ln -sfn "$source_bin" "$target"

if [[ -r "$font_source" ]] && python - <<'PY' >/dev/null 2>&1
import fontTools.ttLib
PY
then
  mkdir -p "$font_dir"
  SRC_FONT="$font_source" DST_FONT="$font_target" python - <<'PY'
from fontTools.ttLib import TTFont
import os

src = os.environ['SRC_FONT']
dst = os.environ['DST_FONT']
font = TTFont(src)
font.flavor = None
replacements = {
    1: 'Chromium Castctl Icons',
    2: 'Regular',
    3: 'Chromium Castctl Icons Regular',
    4: 'Chromium Castctl Icons Regular',
    6: 'ChromiumCastctlIcons-Regular',
    16: 'Chromium Castctl Icons',
    17: 'Regular',
}
for record in font['name'].names:
    value = replacements.get(record.nameID)
    if value is None:
        continue
    record.string = value.encode(record.getEncoding(), errors='replace')
font.save(dst)
PY
  fc-cache -f "$font_dir" >/dev/null 2>&1 || true
  installed_font_message="Installed legacy/pre-Quattro Waybar icon font -> $font_target"
elif [[ -r "$font_source" ]]; then
  installed_font_message="Warning: Python fontTools is not installed; skipped optional legacy/pre-Quattro Waybar icon font"
else
  installed_font_message="Warning: $font_source not found; legacy Waybar may render the Chromecast glyph as a missing-glyph box"
fi

cat <<EOF
Installed legacy chromium-castctl CLI -> $target
$installed_font_message

This script is for direct CLI usage and legacy/pre-Quattro Waybar setups.
Omarchy Quattro plugin installs use:
  omarchy plugin add https://github.com/HackXIt/omarchy-chromecast --enable

Make sure ~/.local/bin is on PATH, then run:
  chromium-castctl doctor
  chromium-castctl status --waybar
EOF
