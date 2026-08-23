# Release process

This repository uses tag-driven GitHub Releases for public plugin releases. The process stays separate from Omarchy Marketplace verification: Omarchy distributes third-party plugins as public git repositories with a root `manifest.json`, while marketplace verification records and reviews an exact commit separately.

## Policy

- Release tags use `vX.Y.Z` and must match `manifest.json` version `X.Y.Z`.
- Release notes come from `CHANGELOG.md`; tag `vX.Y.Z` requires a `## [X.Y.Z]` section.
- Use patch releases for compatible fixes and hardening, minor releases for compatible user-facing additions, and escalate before tagging if the version level is not obvious.
- Do not use issue-closing keywords in changelog entries or release-process PRs. Link pull requests directly; issue attribution and closure are separate issue-triage work.
- Do not push tags, create public releases, or request marketplace updates without maintainer approval.

## Preparing a release PR

1. Start from current `main` in a dedicated branch.
2. Choose the next version and update `manifest.json`.
3. Move relevant `CHANGELOG.md` entries from `## [Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD` and keep links to the pull requests that introduced the changes.
4. Verify release notes extraction:

   ```bash
   ./scripts/release-notes.sh vX.Y.Z
   ```

5. Run the normal repository validation:

   ```bash
   ./scripts/validate-plugin.sh .
   ./scripts/check-actions-pinned.sh
   ./scripts/release-notes.sh "v$(jq -r '.version' manifest.json)" >/dev/null
   node --test
   node --check bin/chromium-castctl test/fixtures/dummy-chromium-cast
   bash -n install.sh scripts/validate-plugin.sh scripts/check-actions-pinned.sh scripts/release-notes.sh
   ```

6. Open a small release-prep PR and wait for CI/review.

## Publishing after approval

After the release-prep PR is merged and approval to publish is explicit:

```bash
git switch main
git pull --ff-only origin main
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Pushing the tag runs `.github/workflows/release.yml`. The workflow validates the plugin/helper, checks that the tag matches `manifest.json`, extracts the matching changelog section into the GitHub Release body, builds source archives, writes `SHA256SUMS`, verifies those checksums, and publishes the GitHub Release.

## Omarchy Marketplace updates

Marketplace publication and verification are not part of the GitHub Release workflow. If this plugin is listed, request verification for the exact merged commit only after the release candidate and public release policy are approved. Treat marketplace update requests as a separate, explicit publishing step.

## PR #31 release path

PR #31 is already merged after `v0.1.1`. Its security hardening and lifecycle fixes are recorded under `CHANGELOG.md` `## [Unreleased]`; use those notes as the starting point for the next release-prep PR. A patch release is the default fit for compatible hardening, but confirm the final version before tagging.
