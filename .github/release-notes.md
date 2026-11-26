A focus coach for your Mac. It notices when you drift, nudges, talks and then yells you back to work, and your friends can bomb your distractions.

**[Download Lock-In-mac-arm64.zip](https://github.com/gracezrx/lock-in/releases/latest/download/Lock-In-mac-arm64.zip)** for Apple silicon Macs (M1 or later), macOS 13+.

Optional: **[Lock-In-Extended.zip](https://github.com/gracezrx/lock-in/releases/latest/download/Lock-In-Extended.zip)**, the Chrome extension (Chrome, Arc, Brave, Edge). It's a separate download: setup walks you through adding it.

### Install
1. Open the zip and drag **Lock In** into Applications.
2. Open it. Lock In isn't signed with an Apple Developer ID yet, so macOS says it can't check it for malware: click **Done**, then go to *System Settings → Privacy & Security*, scroll down and click **Open Anyway**. (Or run `xattr -cr "/Applications/Lock In.app"` once in Terminal.)
3. Setup takes a few minutes and walks you through everything: your goals, today's to-dos, what distracts you, your coach (and its Claude and ElevenLabs keys, with where to get them), whether to share usage data, then the menu bar padlock, Accessibility, the microphone, the Chrome extension and your calendar.

### In this version
- **One to-do list, in a spreadsheet too.** The Lock In list can live in a tab of your Google Sheet, Excel, Numbers or CSV file. Lock In adds a "Lock In" tab (Done, Task, Due, Priority, Project, Notes, Added) with your open to-dos in it, and shows it to you before it's made. What you add or tick in Lock In is written into the sheet; rows you add there show up in Lock In. Or point it at a tab you already have. If the file is open in Excel, Lock In holds your changes and writes them once you close it. *Using the Google connector from before? Paste the new script over the old one and deploy a new version (the setup screen shows how).*
- **Today's numbers for your crew.** A second view on the Friends page: everyone's minutes locked in today (the session going on now included), to-dos done and still to go, and crew totals.
- **Share my to-dos** (crew settings, off by default): your crew sees your open to-dos and what you finished today, and the feed says when someone finishes something.
- **Clearer voice errors.** When a call can't connect because your ElevenLabs credits are used up, Lock In says so and when they come back, instead of "the AI agent is not available".

Intel Mac? Build it from source (see the README).
