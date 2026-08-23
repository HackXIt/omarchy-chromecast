## Summary

- 

Fixes #

## Validation

- [ ] `./scripts/validate-plugin.sh .`
- [ ] `./scripts/check-actions-pinned.sh`
- [ ] `./scripts/release-notes.sh "v$(jq -r '.version' manifest.json)" >/dev/null`
- [ ] `node --test`
- [ ] `node --check bin/chromium-castctl test/fixtures/dummy-chromium-cast`
- [ ] `bash -n install.sh scripts/validate-plugin.sh scripts/check-actions-pinned.sh scripts/release-notes.sh`
- [ ] Manual Omarchy/Quickshell validation, if UI behavior changed

## Notes

