# lock-in — working in this repo

<!-- TODO: two or three sentences on what this is and how it is built. Point at an architecture doc if there is one. -->

## The rules are in CI, not here

A PR that breaks any of these does not merge, whoever or whatever wrote it:

- **Gates** (`.github/workflows/release.yml`, job `gates`): `npm run typecheck`, `npm test`, `npm run build`, `node scripts/ratchet.mjs`
- **Ratchet**: `scripts/ratchet.json` holds counts of known debt. They may go down, never up. When you lower one, update the baseline in the same PR: `node scripts/ratchet.mjs --update`.
- **Verification**: <!-- TODO: the command that drives the real product (e2e suite, integration tests, simulator build) and what must stay green. -->

If you leave the same review note twice, stop and turn it into a check in CI. The third time is too late.

## How to work

- **Small, atomic PRs.** One concern per PR. Never mix a refactor with a behaviour change.
- **Prove it works.** A PR carries evidence from the real product: the test that failed before and passes after, a screenshot or log, the path to it. "Should work now" is not evidence. Use the `prove` skill.
- **Bugs: reproduced before, gone after.** Failing test first. Use the `bugfix` skill.
- **Find the feature in `docs/FEATURE_MAP.md`** before touching code. If it isn't there, add the row in the same PR.
- **Read before you diagnose.** Never state a root cause you haven't seen in code or a log. Can't reproduce? Say so and stop.
- **Don't widen scope.** Other bugs become issues labelled `agent` with a reproduction path.
- **No stale commentary.** Comments say *why*, never *what*.

## Where things live

<!-- TODO: a short table: concern → files. -->

## Running locally

```
npm ci && npm run dev
```
