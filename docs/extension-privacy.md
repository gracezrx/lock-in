# Lock In Extended: privacy policy

Lock In Extended is a focus coach for Chrome. This page says what it looks at, what it keeps, and what leaves your computer. Short version: it keeps everything in your browser, it has no servers of its own, and nothing is sold, shared for ads or used for anything other than coaching you.

## What it looks at

- **The tab in front of you**: its address (URL), title and whether something is playing, and whether Chrome's window is in front. This is how it tells work from distraction. It only builds up "drift" while a session is running.
- **Whether you're at the computer** (Chrome's idle state), so time away isn't counted as drifting.
- **What you type into its panel**: your first name, what you're locking in on, to-dos, goals, the sites you mark as work or distraction, and settings.

## What it keeps

Everything is kept in Chrome's local extension storage on your computer: your settings, your session history (goal, length, minutes focused and drifting, the sites you drifted to), to-dos, goals, site labels, your crew membership and the private calendar link if you add one. Page titles are never stored in the history. Removing the extension deletes all of it.

## What leaves your browser, and only when you use the feature

- **Lock In for Mac (optional)**: if the Lock In app is running on the same computer, the extension connects to it at `127.0.0.1` (your own machine, never the internet). It sends the app the active tab's address and title so the app can coach you, receives your profile, labels, to-dos, goals, crew and meetings from it, and sends it the sessions and to-dos you made in Chrome. You can turn this off in Settings.
- **Crews (optional)**: if you start or join a crew, a short status goes to your crew through a public relay ([ntfy.sh](https://ntfy.sh) by default): whether you're locked in, on a break or drifting, your session goal (unless you turn that off in the Mac app), the site you drifted to (only if you turn that on), your focus minutes and streak, and bombs you throw. Every message is end-to-end encrypted (AES-256-GCM) with a key derived from your crew's invite code, so the relay and anyone else without the code can't read it.
- **Calendar (optional)**: if you paste a private iCal link, the extension downloads it from your calendar provider to know when you're in a meeting. The link stays in your browser.
- **The coach's voice**: spoken lines use Chrome's built-in text-to-speech. Some of Chrome's voices are provided by Google over the network; if you pick one of those, the line being spoken is sent to Google to be read out. Pick a voice marked as local to avoid that, or turn the voice off.

## What it never does

- No analytics, tracking, ads or third-party scripts. No remote code: everything it runs ships inside the extension.
- It doesn't read what's on pages (beyond whether a video or audio is playing), forms, passwords, cookies or your browsing history. It only looks at the tab in front of you.
- It doesn't sell or transfer your data to anyone, and doesn't use it for anything except coaching you.

## Permissions, and why

| Permission | Why |
| --- | --- |
| tabs, all sites | Know which site is in front, cover a distracting page with the coach's card, and pause its video |
| scripting | Draw the coach's cards on the page you drifted to |
| declarativeNetRequest | Block a distracting site until the session ends (or for 5 minutes after a friend's bomb) |
| storage | Keep your settings, history, to-dos and goals in your browser |
| alarms | Keep time every 30 seconds while the browser is open |
| idle | Don't count time away from the computer as drifting |
| tts | The coach talks |
| notifications | Tell you when it can't draw on a page (like Chrome's own pages) |

## Contact

Questions or problems: open an issue at [github.com/gracezrx/lock-in](https://github.com/gracezrx/lock-in/issues).
