A focus coach for your Mac. It notices when you drift, nudges, talks and then yells you back to work, and your friends can bomb your distractions.

**[Download Lock-In-mac-arm64.zip](https://github.com/gracezrx/lock-in/releases/latest/download/Lock-In-mac-arm64.zip)** for Apple silicon Macs (M1 or later), macOS 13+.

### Install
1. Open the zip and drag **Lock In** into Applications.
2. Open it. Lock In isn't signed with an Apple Developer ID yet, so macOS says it can't check it for malware: click **Done**, then go to *System Settings → Privacy & Security*, scroll down and click **Open Anyway**. (Or run `xattr -cr "/Applications/Lock In.app"` once in Terminal.)
3. Find the padlock in your menu bar. Setup is three questions: your goals, today's to-dos and what distracts you.

### In this version
- Lives in the menu bar: a small panel to lock in, tick off to-dos and see your day; the window is only for Settings.
- Setup in three questions (your goals, today's to-dos, what distracts you), then a one-screen checklist that connects the menu bar padlock, Accessibility, the browser extension and your calendar, a click or two each.
- Bombs from friends lock every distraction for five minutes, then lock the screen for five seconds.

Intel Mac? Build it from source (see the README).
