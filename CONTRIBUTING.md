# Contributing to Lock In

Thanks for helping. Lock In is small and opinionated, so a short issue first is the fastest way to a change that lands.

## Reporting a bug

[Open an issue](https://github.com/gracezrx/lock-in/issues/new/choose) with:

- your Lock In version (*Settings*, bottom of the page) and macOS version,
- what you did, what you expected, and what happened,
- the relevant lines from *Settings → Activity log* (look them over first: they can include app and site names).

Never paste API keys, calendar links or anything personal into an issue.

## Suggesting a feature

Open an issue saying what you were trying to do and where Lock In got in the way. A sentence about the moment it happened helps more than a spec.

## Working on the code

You need macOS 13 or later, Node.js 20 or later and the Xcode Command Line Tools.

```bash
npm install
npm run dev          # builds the Swift sensor and the app, then launches it
npm run typecheck
npm test
```

- `src/main` is the Electron main process (sensors, engine, coach, voice), `src/renderer` the pages, `src/extension` Lock In Extended (the Chrome extension, built separately with `npm run build:extension`), `native` the Swift helpers. *Project layout* in the [README](README.md#project-layout) has the full map.
- Keep pull requests to one change, with a test when the change is logic (see `test/`).
- `npm run dev` never sends usage data. Don't add anything that reads window titles, page contents or what people type into what's shared: see *Usage data* in the README.
- UI copy is plain, short and in the second person. Read it out loud before you commit it.

By contributing you agree that your work is released under the [MIT License](LICENSE).
