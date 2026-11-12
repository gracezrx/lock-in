---
name: bugfix
description: Fix a bug the way the night shift requires — reproduced before the fix, gone after, with the failing test written first. Use for any issue labelled bug or agent, and for anything a user reports as broken.
---

# Bug fix: reproduced before, gone after

The acceptance standard is a test that failed before the fix and passes after. A fix with no failing test first is a guess, however plausible.

## Steps

1. **Read the report, then the code.** Map it to the repo's `docs/FEATURE_MAP.md`. Read the files that row names and the tests near them. Do not state a root cause yet.
2. **Reproduce in the real product.** Write the smallest e2e spec or integration test that walks the reported path and asserts the correct behaviour. Run it. **It must fail.** Save the failing output and any screenshot.
   - Can't make it fail? Stop. Comment on the issue with what you tried, what you observed, and what would let someone reproduce it. Add the `agent:blocked` label. Do not ship a speculative fix.
   - `main` already fixed it? (`git log -S`, run the test on main.) Say so and close.
3. **Find the cause with evidence.** Logs, a trace, a temporary `console.log` you remove. Quote the line that proves it in the PR.
4. **Fix the smallest thing.** Stay inside the files the feature map names unless the cause is elsewhere. No refactoring in the same PR; open an `agent` issue for that.
5. **Run the test again. It must pass.** Then every gate in the repo's `CLAUDE.md`.
6. **Open the PR** with: the issue number; "Reproduced: `<test>` failed with `<one line>`"; "Fixed: `<one sentence>`; `<test>` passes; evidence `<path>`"; anything noticed but not touched, as a new issue.
