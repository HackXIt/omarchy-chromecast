# Contributing

Thanks for helping improve Omarchy Chromecast. Focused issues and pull requests are easiest to review: keep each change centered on one bug or feature, avoid unrelated cleanup, and explain the user-visible result.

## Local development

The helper has no npm dependencies. Run it and its tests directly from a clone with Node.js. For Quickshell work, follow the README's [local Omarchy plugin setup](README.md#install-on-omarchy-quattro); full UI testing requires an Omarchy desktop with the documented runtime requirements.

## Tests and validation

Add or update a regression test under `test/` whenever helper behavior changes. Before opening a pull request, run the repository's authoritative checks:

```bash
./scripts/validate-plugin.sh .
./scripts/check-actions-pinned.sh
./scripts/release-notes.sh "v$(jq -r '.version' manifest.json)" >/dev/null
node --test
node --check bin/chromium-castctl test/fixtures/dummy-chromium-cast
bash -n install.sh scripts/validate-plugin.sh scripts/check-actions-pinned.sh scripts/release-notes.sh
```

For QML or shell-integration changes, also validate the affected flow manually on Omarchy. Exercise the relevant target refresh, start, active status, stop, and diagnostics behavior, including the Wayland portal prompt where applicable. State clearly when manual Omarchy validation was not possible or not applicable.

## Preserve safety and lifecycle boundaries

Review [the helper architecture](docs/architecture.md) before changing discovery, Chromium/CDP handling, state, process cleanup, or UI data flow. In particular:

- Keep `bin/chromium-castctl` a thin wrapper around `lib/chromium-castctl/`.
- Keep CDP loopback-only, controller state in private XDG paths, and process/CDP identity validation in place before reuse or signaling.
- Treat receiver names as untrusted data; Quickshell must consume `sinks --json` rather than newline-delimited names.
- Preserve the documented command lifecycle and cleanup behavior, including that status does not launch Chromium and stop still cleans up after Cast stop failures.
- Do not bypass the Wayland portal consent flow or treat this single-user desktop tool as a cross-user isolation boundary.

## Documentation and pull request evidence

Update the README or architecture documentation when behavior, setup, interfaces, or security/lifecycle boundaries change. Add user-visible changes to the `Unreleased` section of `CHANGELOG.md`; release version and tag changes follow [the release process](docs/releasing.md) and are separate maintainer-approved work.

In the pull request, include:

- a concise summary and a linked issue when one exists;
- the regression tests added or updated for behavior changes;
- the validation commands run and their results;
- manual Omarchy/Quickshell coverage, or why it was not applicable or available; and
- relevant screenshots or command output when they help demonstrate a UI or lifecycle change.
