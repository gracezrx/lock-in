A focus coach for your Mac. It notices when you drift, nudges, talks and then yells you back to work, and your friends can bomb your distractions.

**[Download Lock-In-mac-arm64.zip](https://github.com/gracezrx/lock-in/releases/latest/download/Lock-In-mac-arm64.zip)** for Apple silicon Macs (M1 or later), macOS 13+.

Optional: **[Lock-In-Extended.zip](https://github.com/gracezrx/lock-in/releases/latest/download/Lock-In-Extended.zip)**, the Chrome extension (Chrome, Arc, Brave, Edge). It's a separate download: setup walks you through adding it.

### Install
1. Open the zip and drag **Lock In** into Applications.
2. Open it. Lock In isn't signed with an Apple Developer ID yet, so macOS says it can't check it for malware: click **Done**, then go to *System Settings → Privacy & Security*, scroll down and click **Open Anyway**. (Or run `xattr -cr "/Applications/Lock In.app"` once in Terminal.)
3. Setup takes a few minutes and walks you through everything: your goals, today's to-dos, what distracts you, your coach (and its Claude and ElevenLabs keys, with where to get them), whether to share usage data, then the menu bar padlock, Accessibility, the microphone, the Chrome extension and your calendar.

### In this version
- Setup covers the whole thing now: picking your coach, adding the two API keys (with links and what each one does), the microphone for talking back, and the Chrome extension.
- Lock In Extended, the Chrome extension, is its own download instead of a folder inside the app.
- Optional, anonymous usage data (Settings → Usage data): which features you use, and, only if you say yes, time per app and site. Never window titles, page addresses, what you type or what the coach says. You can see exactly what's sent, and delete it.

Intel Mac? Build it from source (see the README).
