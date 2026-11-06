// The bomb clip's timeline, shared by every frame of the scene. Times are seconds.
// Each page draws itself from a time t (no CSS animations), so record.mjs can capture
// exact frames at 30 fps.
(function () {
  const q = new URLSearchParams((window.top || window).location.search);
  const she = (q.get('pronoun') || 'he').toLowerCase() === 'she';
  const CAST = {
    me: q.get('me') || 'Grace',
    them: q.get('them') || 'Sam',
    line: q.get('line') || 'I can hear you scrolling from here.',
    where: q.get('where') || 'doomscroll.app',
    goal: q.get('goal') || 'Investor update',
    myGoal: q.get('mygoal') || 'Pitch deck',
    crew: q.get('crew') || 'Cofounders',
    his: she ? 'her' : 'his',
    he: she ? 'she' : 'he',
  };

  // The feed: a made-up site, with public-domain and CC0 pictures (feed/CREDITS.md).
  // fmt: 'full' (a vertical clip), 'meme' (a caption bar over a landscape clip),
  // 'blur' (a landscape clip over a blurred copy of itself). tint: the light it throws.
  const REELS = [
    { img: '00-raccoon', fmt: 'full', style: 'outline', text: 'raccoon caught stealing snacks at 3am 😭', who: 'trash.panda.daily', likes: '2.1M', comments: '18.4K', tint: '#8fd16a' },
    { img: '01-cat', fmt: 'meme', text: 'my cat when i say “5 more minutes” and it’s been 3 hours', who: 'cat.ceo', likes: '1.2M', comments: '9,817', tint: '#e0a85c' },
    { img: '02-coffee', fmt: 'full', style: 'box', text: 'rating every coffee spot in NYC ☕ #47', who: 'bean.there', likes: '88.4K', comments: '1,204', tint: '#d0603a' },
    { img: '03-space', fmt: 'full', style: 'outline', text: 'this will make you feel so small 🌌', who: 'space.facts', likes: '640K', comments: '4,410', tint: '#7a6cff', capY: 250 },
    { img: '04-rocket', fmt: 'full', style: 'box', text: 'wait for it… 🚀', who: 'launch.pad', likes: '301K', comments: '2,876', tint: '#4f7fe0' },
    { img: '05-grass', fmt: 'full', style: 'outline', text: 'POV: you touched grass (you didn’t) 🌱', who: 'touch.grass.club', likes: '48.2K', comments: '731', tint: '#6fd04a' },
    { img: '06-raccoon', fmt: 'full', style: 'box', text: 'part 2 because you asked 🦝', who: 'trash.panda.daily', likes: '980K', comments: '6,032', tint: '#9fd17a' },
    { img: '07-cat', fmt: 'blur', style: 'outline', text: 'he knows what he did 💀', who: 'cat.ceo', likes: '3.4M', comments: '21K', tint: '#e0a85c', capY: 110 },
    { img: '08-coins', fmt: 'blur', style: 'box', text: 'found these in my grandma’s attic 😳', who: 'attic.finds', likes: '76K', comments: '3,190', tint: '#c8c8c8', capY: 100 },
    { img: '09-gravel', fmt: 'full', style: 'outline', text: 'ASMR: walking on gravel for 10 hours 🎧', who: 'asmr.daily', likes: '512K', comments: '8,888', tint: '#e0d0b8' },
  ];

  const B = {
    length: 11.5,
    // The feed speeds up: each swipe comes sooner than the last.
    swipes: [0.3, 0.72, 1.06, 1.34, 1.56, 1.74, 1.89, 2.02, 2.14],
    toPhone: [2.45, 2.8], // whip pan to your phone
    tapBomb: 2.95,
    sheetUp: [3.05, 3.22],
    tapChip: 3.42,
    tapThrow: 3.78,
    sheetDown: [3.84, 3.98],
    phoneToast: [3.95, 5.4],
    pop: 3.95, // the bomb pops out of the Throw button
    windup: [4.22, 4.36], // squashes down…
    launch: 4.36, // …and goes
    flight: [4.36, 5.2],
    notice: 4.95, // he looks up: "!"
    impact: 5.2,
    countdown: [5.2, 5.65, 6.1, 6.55, 7.0], // "Locked for 5…" to "1…" (sped up)
    unlock: 7.45,
    cursorIn: [7.5, 7.85],
    click: 7.92,
    cardOut: [7.96, 8.1],
    sessionToast: 8.14,
    theyLockIn: 8.35, // the crew sees it on your phone
    toDesk: [8.05, 8.6],
    typing: [8.4, 9.8],
    endCard: [9.9, 10.2],
  };
  B.swipeDur = B.swipes.map((s, i) => Math.min(0.3, ((B.swipes[i + 1] ?? s + 0.14) - s) * 0.9));

  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const ease = {
    inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
    out: (k) => 1 - Math.pow(1 - k, 3),
    in: (k) => k * k * k,
    back: (k) => {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
    },
  };
  /** How far the feed has scrolled (in reels) at time t, and how fast it's moving. */
  function feed(t) {
    let pos = 0;
    let speed = 0;
    const ft = Math.min(t, B.impact);
    B.swipes.forEach((s, i) => {
      const d = B.swipeDur[i];
      const k = seg(ft, s, s + d);
      pos += ease.out(k);
      if (k > 0 && k < 1) speed = Math.max(speed, (3 * Math.pow(1 - k, 2)) / d);
    });
    return { pos, speed, reel: REELS[Math.min(REELS.length - 1, Math.round(pos))] };
  }

  window.LOCKIN_BOMB = { CAST, REELS, B, clamp, lerp, seg, ease, feed };
})();
