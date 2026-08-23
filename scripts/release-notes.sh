#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "release-notes: $*" >&2
  exit 1
}

[[ $# -eq 1 ]] || fail "usage: $0 vX.Y.Z"

tag="$1"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]] \
  || fail "release tag must look like vX.Y.Z: $tag"

version="${tag#v}"
changelog="${CHANGELOG_FILE:-CHANGELOG.md}"
[[ -f "$changelog" ]] || fail "missing changelog: $changelog"

tmp="$(mktemp)"
trimmed="$(mktemp)"
trap 'rm -f "$tmp" "$trimmed"' EXIT

if ! awk -v version="$version" '
  BEGIN {
    heading = "## [" version "]"
    found = 0
  }
  /^##[[:space:]]/ {
    if (found) {
      exit 0
    }
    if (index($0, heading) == 1) {
      found = 1
      next
    }
  }
  found {
    print
  }
  END {
    if (!found) {
      exit 2
    }
  }
' "$changelog" >"$tmp"; then
  fail "missing CHANGELOG.md section '## [$version]' for $tag"
fi

awk '
  NF { seen = 1 }
  seen { lines[++count] = $0 }
  END {
    while (count > 0 && lines[count] == "") {
      count--
    }
    for (i = 1; i <= count; i++) {
      print lines[i]
    }
  }
' "$tmp" >"$trimmed"

[[ -s "$trimmed" ]] || fail "CHANGELOG.md section '## [$version]' is empty"
cat "$trimmed"
