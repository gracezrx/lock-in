function refresh() {
  chrome.runtime.sendMessage({ type: 'status' }, (res) => {
    const on = !!(res && res.connected);
    document.getElementById('dot').classList.toggle('on', on);
    document.getElementById('status').textContent = on ? 'Connected to Lock In' : 'Not connected';
    document.getElementById('hint').textContent = on
      ? 'Your coach can see your active tab and pause or close distractions.'
      : 'Open the Lock In desktop app, then press Reconnect.';
    // Reconnect is only for when it isn't connected.
    document.getElementById('retry').hidden = on;
  });
}
document.getElementById('retry').addEventListener('click', () => {
  document.getElementById('status').textContent = 'Connecting…';
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => setTimeout(refresh, 800));
});
refresh();
