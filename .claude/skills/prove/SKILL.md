---
name: prove
description: Prove a change works with evidence from the real product — a test that failed before and passes after, a screenshot, a log line. Use before opening any PR and whenever a PR template asks for verification. Not the same as gstack's /verify (which makes the checks green); this is about evidence.
---

# Prove it works

A change is proven when the real product did the thing and the proof survives the session. Reading code or passing typecheck is not proof.

## Steps

1. **Find the feature** in the repo's `docs/FEATURE_MAP.md` (entry point, control names, files). If the repo has no feature map, or the feature isn't in it, add the row in this PR.
2. **Start from green.** Run every gate the repo's `CLAUDE.md` lists. A red gate before you start is a separate issue, not your PR.
3. **Drive the feature in the real product.** Web: a Playwright spec that walks the user's path and screenshots the result. API/CLI/job: an integration test against the real process. Mobile/desktop: the simulator or a device, with a screenshot saved to the repo's evidence folder. Capture console errors, failed requests and crash logs, and assert there are none.
4. **Run it.** If something can't be driven in CI (needs real keys, a device, a signed build), say exactly what and verify what can be.
5. **Look at the evidence yourself** (Read the screenshot). A green test with a blank screenshot is a broken test.
6. **Write it up** under "Verification" in the PR body: spec or test name, evidence path, what you saw. One sentence each.

## Counts as evidence

- A test that fails without the change and passes with it
- A screenshot of the result in the real UI
- An integration test exercising the real API path
- A log line or trace from a real run

## Does not

- "Typecheck passes", "build succeeds"
- "Looked at the code and it should work"
- A unit test of a function the feature doesn't call
- A screenshot with hand-edited state
