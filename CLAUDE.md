# lock-in — working in this repo

Lock In: a macOS focus coach. Electron app (`src/main` process, `src/preload`, `src/renderer` UI, `src/shared` types and engine), a Swift window/site sensor in `native/mac-helper` (built by `npm run helper`), a Chrome extension in `src/extension`, and a phone surface in `src/phone`. `build.mjs` bundles with esbuild into `dist/`. The Swift helper and the Electron shell only run on macOS; the engine, coaches, data and extension logic are plain TypeScript with `node:test` coverage in `test/`.

## The rules are in CI, not here

A PR that breaks any of these does not merge, whoever or whatever wrote it:

- **Gates** (`.github/workflows/gates.yml`, job `gates`): `npm run typecheck`, `npm test`, `npm run build`, `node scripts/ratchet.mjs`
- **Ratchet**: `scripts/ratchet.json` holds counts of known debt. They may go down, never up. When you lower one, update the baseline in the same PR: `node scripts/ratchet.mjs --update`.
- **Verification**: `npm test` covers the engine, coaches, attention, deadlines, crew, data, bridge and extension logic (233 cases) and is the gate for anything in `src/shared` or `src/extension`. The Electron shell and Swift sensor can't run in CI: changes there carry a screenshot or recording from a real Mac (`npm run dev`), or a `scripts/demo` recording. A headless renderer/extension e2e is the first `agent` issue.

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

| Concern | Files |
| --- | --- |
| Drift detection, nudges, escalation | `src/shared/engine*`, `test/engine.test.ts`, `test/attention.test.ts` |
| Coaches and voice | `src/shared/coach*`, `test/coach.test.ts`, `test/coaches.test.ts` |
| Goals, deadlines, achievements, crew | `src/shared/`, matching `test/*.test.ts` |
| Electron main process, windows, menu bar | `src/main/` |
| Renderer UI (cards, setup, roast) | `src/renderer/` |
| Preload bridge | `src/preload/`, `test/bridge.test.ts` |
| Mac window/site sensor | `native/mac-helper/` (Swift, `npm run helper`) |
| Chrome extension | `src/extension/`, `test/extension.test.ts`, `npm run extension:zip` |
| Phone surface | `src/phone/` |
| Build and packaging | `build.mjs`, `scripts/package-mac.mjs`, `.github/workflows/release.yml` |
| Demo recordings | `scripts/demo/` |

## Running locally

```
npm ci && npm run dev
```
