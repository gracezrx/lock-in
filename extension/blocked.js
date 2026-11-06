const q = new URLSearchParams(location.search);
const d = q.get('d');
const from = q.get('from');
const until = Number(q.get('until')) || 0;
const msg = document.getElementById('msg');
const mark = document.querySelector('.mark');
const title = document.querySelector('h1');

if (from && until) {
  // A friend's Lock In bomb: every distraction is locked for a few minutes.
  mark.textContent = `Lock In bomb from ${from}`;
  title.textContent = 'Locked.';
  const tick = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (left > 0) {
      msg.textContent = `${d || 'This site'} is locked for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}. Every distraction is. Back to work.`;
    } else {
      title.textContent = 'Unlocked.';
      msg.textContent = `The bomb wore off. ${d || 'This site'} is open again, if you really need it.`;
      clearInterval(timer);
    }
  };
  const timer = setInterval(tick, 500);
  tick();
} else if (d) {
  msg.textContent = `${d} is blocked until your session ends. Your work is one tab away.`;
}
