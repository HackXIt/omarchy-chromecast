# Contributing

Thanks for helping improve Omarchy Chromecast.

## Development setup

This project has no npm dependencies. You need:

- Node.js with built-in `fetch` and `WebSocket`
- `jq`
- Bash

Run the local validation suite before opening a pull request:

```bash
./scripts/validate-plugin.sh .
node --test
node --check bin/chromium-castctl
bash -n install.sh scripts/validate-plugin.sh
```

For changes that affect the Omarchy/Quickshell widget, also test the plugin manually in Omarchy when possible.

## Pull request expectations

- Keep PRs focused on one bug, feature, or maintenance task.
- Link the issue with `Fixes #123` or `Closes #123` when the PR should close it.
- Add or update tests for helper CLI behavior when practical.
- Document user-visible behavior changes in `README.md`.
- Do not include unrelated refactors or formatting churn.

## Reporting issues

Please use the GitHub issue templates for bug reports and feature requests. Include command output, environment details, and manual reproduction steps when relevant.
