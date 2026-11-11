// The page a blocked site turns into: until the session ends (a red card), or for a few minutes
// after a friend's bomb (a yellow one, with a countdown).
export {};

const q = new URLSearchParams(location.search);
const site = q.get('d') ?? '';
const from = q.get('from');
const until = Number(q.get('until')) || 0;
const el = (id: string) => document.getElementById(id) as HTMLElement;
const msg = el('msg');
const open = el('open') as HTMLAnchorElement;

el('close').addEventListener('click', () => {
  chrome.tabs.getCurrent((tab) => {
    if (tab?.id !== undefined) void chrome.tabs.remove(tab.id);
    else window.close();
  });
});

const unlocked = () => {
  el('card').classList.remove('bomb');
  el('card').classList.add('open');
  el('mark').textContent = 'Lock In';
  el('title').textContent = 'Unlocked.';
  if (site) {
    open.hidden = false;
    open.href = `https://${site}`;
    open.textContent = `Open ${site}`;
  }
};

if (from && until) {
  el('card').classList.add('bomb');
  el('mark').textContent = `💣 Bomb from ${from}`;
  el('title').textContent = 'Locked.';
  const tick = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (left > 0) {
      msg.textContent = `${site || 'This site'} is locked for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}. Every distraction is. Back to work.`;
    } else {
      unlocked();
      msg.textContent = `The bomb wore off. ${site || 'This site'} is open again, if you really need it.`;
      clearInterval(timer);
    }
  };
  const timer = setInterval(tick, 500);
  tick();
} else {
  if (site) msg.textContent = `${site} is blocked until your session ends. Your work is one tab away.`;
  // When the session ends the block lifts: offer the way back.
  const check = async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules().catch(() => null);
    if (rules && !rules.some((r) => r.condition.requestDomains?.includes(site))) {
      unlocked();
      msg.textContent = `Your session is over. ${site || 'This site'} is open again.`;
      clearInterval(poll);
    }
  };
  const poll = setInterval(() => void check(), 3000);
}
