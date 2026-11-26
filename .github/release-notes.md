A focus coach for your Mac. It notices when you drift, nudges, talks and then yells you back to work, and your friends can bomb your distractions.

**[Download Lock-In-mac-arm64.zip](https://github.com/gracezrx/lock-in/releases/latest/download/Lock-In-mac-arm64.zip)** for Apple silicon Macs (M1 or later), macOS 13+.

Optional: **[Lock-In-Extended.zip](https://github.com/gracezrx/lock-in/releases/latest/download/Lock-In-Extended.zip)**, the Chrome extension (Chrome, Arc, Brave, Edge). It's a separate download: setup walks you through adding it.

### Install
1. Open the zip and drag **Lock In** into Applications.
2. Open it. Lock In isn't signed with an Apple Developer ID yet, so macOS says it can't check it for malware: click **Done**, then go to *System Settings → Privacy & Security*, scroll down and click **Open Anyway**. (Or run `xattr -cr "/Applications/Lock In.app"` once in Terminal.)
3. Setup takes a few minutes and walks you through everything: your goals, today's to-dos, what distracts you, your coach (and its Claude and ElevenLabs keys, with where to get them), whether to share usage data, then the menu bar padlock, Accessibility, the microphone, the Chrome extension and your calendar.

### In this version
- **A team in one Google Sheet.** Everyone gets their own tab (*Lock In · Grace*, *Lock In · Sam*), so nobody writes into anyone else's list. One person sets up the Google connector and presses *Copy link for your team*; everyone else pastes that link.
- **Everything you did lands in the sheet.** Things you tell the coach you finished that weren't on the list go in as ticked rows. Picking a spreadsheet during setup now starts with your own tab, and the to-dos you type during setup go into it.
- **Locked-in minutes are right.** A session going on was counted twice on the Friends page; now it's counted once, live. While you're locked in your minutes reach your crew every 3 minutes (it was 10).
- Tested end to end: two copies of Lock In in one crew, bombs refused while someone's locked in and landing once they stop, the 5-minute lockout, and the Google connector script itself.

From 0.5.0: the Lock In list in a spreadsheet tab (Google Sheets, Excel, Numbers, CSV), *Today's numbers* and *Share my to-dos* for crews, and clearer voice errors when your ElevenLabs credits run out.

*Using the Google connector from before? Paste the new script over the old one and deploy a new version (the setup screen shows how).*

Intel Mac? Build it from source (see the README).
