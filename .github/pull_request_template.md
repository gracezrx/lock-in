## What changed

<!-- One concern per PR. What, and why. Link the issue: Closes #N -->

## Verification

<!-- Evidence from the real product, not "should work". Delete lines that don't apply. -->

- Reproduced before: `<spec or test name>` failed with `<one line of the failure>`
- Gone after: `<spec or test name>` passes
- Evidence: `<screenshot / log / trace path>` — shows `<what you saw>`
- Not verifiable in CI: `<what, and how it was checked instead>`

## Gates

- [ ] Every gate in `CLAUDE.md` is green locally
- [ ] `node scripts/ratchet.mjs` (baseline lowered if a count went down)
- [ ] `docs/FEATURE_MAP.md` updated if a control or entry point changed

## Noticed, not touched

<!-- Anything else you saw. Open an issue labelled `agent` with a reproduction path. -->
