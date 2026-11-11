// Tells the extension whether a video or audio element is playing in this frame.
(() => {
  let last: boolean | null = null;
  const report = () => {
    const playing = Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio')).some((m) => !m.paused && !m.ended && m.readyState > 2);
    if (playing === last) return;
    last = playing;
    try {
      void chrome.runtime.sendMessage({ type: 'media', playing });
    } catch {
      /* extension reloaded */
    }
  };
  for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied']) document.addEventListener(ev, report, true);
  setInterval(report, 5000);
})();
