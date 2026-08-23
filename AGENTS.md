# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Validate plugin/helper changes with `./scripts/validate-plugin.sh .`, `./scripts/check-actions-pinned.sh`, `./scripts/release-notes.sh "v$(jq -r '.version' manifest.json)" >/dev/null`, `bash -n install.sh scripts/validate-plugin.sh scripts/check-actions-pinned.sh scripts/release-notes.sh`, `node --check bin/chromium-castctl test/fixtures/dummy-chromium-cast`, and `node --test`.
- `bin/chromium-castctl` is the authority for receiver discovery and casting safety. Quickshell should consume `chromium-castctl sinks --json`; do not reintroduce newline-delimited untrusted receiver names into `Chromecast.qml`.
- Chromium CDP is loopback-only but unauthenticated by Chromium; keep controller state under private XDG paths, validate CDP URLs/process identity before reuse/signaling, and treat the plugin as a single-user desktop tool rather than a cross-user isolation boundary.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
