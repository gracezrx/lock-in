// The page for a coach made from someone you know: feed it recordings and messages, say which
// voice is them, distill how they talk, tweak every line, and (with their yes) copy their voice.
import type { CoachLineKind, CoachSource, CustomCoachView, Persona } from '../shared/types';
import { LINE_GROUPS, LINE_KINDS, LINE_SPECS, PLACEHOLDERS, lineProblem } from '../shared/coachlines';
import { api, clear, h, mmss } from './lib';
import { cutVoice, type Segment } from './clips';

const WORDS = { sketch: 150, good: 800, great: 3000 };
const VOICE = { min: 60, good: 120 };

const PUSH: { id: Persona; name: string; desc: string }[] = [
  { id: 'gentle', name: 'Gently', desc: 'Soft, never harsh' },
  { id: 'firm', name: 'Firmly', desc: 'Direct and short' },
  { id: 'sassy', name: 'With sass', desc: 'Teasing, dramatic' },
  { id: 'drill', name: 'Like a drill sergeant', desc: 'Loud, relentless' },
];

const BUILT_IN: Record<Persona, string> = { gentle: 'gentle friend', firm: 'firm coach', sassy: 'sassy best friend', drill: 'drill sergeant' };

const STYLE_WORD: Record<CustomCoachView['readiness']['style'], string> = {
  empty: 'Keep feeding it',
  sketch: 'A first sketch',
  good: 'Sounds like them',
  great: 'Spot on',
};

const fmt = (n: number) => n.toLocaleString();
const her = (v: CustomCoachView) => v.name;

interface PageCtx {
  view: HTMLElement;
  /** Back to Coach. */
  back: () => void;
  /** The page is still the one on screen. */
  current: () => boolean;
}

let unsubscribe: (() => void) | null = null;

/** Stops listening for updates once you leave the page. */
export function leaveCoachPage(): void {
  unsubscribe?.();
  unsubscribe = null;
}

export async function renderCoachPage(id: string, ctx: PageCtx): Promise<void> {
  leaveCoachPage();
  let v = await api.invoke<CustomCoachView | null>('coaches:get', id);
  if (!ctx.current()) return;
  if (!v) {
    ctx.view.append(h('section', { class: 'page' }, h('p', { class: 'empty' }, 'That coach is gone. ', h('a', { href: '#coach' }, 'Back to Coach'))));
    return;
  }

  const page = h('section', { class: 'page coach-page' });
  const headBox = h('div');
  const feedBox = h('div');
  const styleBox = h('div');
  const linesBox = h('div');
  const voiceBox = h('div');
  let linesFor = 0;

  const refresh = (next: CustomCoachView | null, opts: { lines?: boolean } = {}) => {
    if (!next || !ctx.current()) return;
    const distilledAgain = next.distilledAt !== v!.distilledAt;
    v = next;
    drawHead();
    drawFeed();
    drawStyle();
    drawVoice();
    // Lines are only redrawn when something new arrived and you're not typing in one.
    const typing = linesBox.contains(document.activeElement);
    if ((opts.lines || distilledAgain || linesFor === 0) && !typing) drawLines();
  };
  unsubscribe = api.on('coaches:update', (x) => {
    const next = x as CustomCoachView | null;
    if (next?.id === id) refresh(next);
  });

  // ---- head ------------------------------------------------------------------------

  const drawHead = () => {
    const c = v!;
    clear(headBox);
    const hasLines = Object.keys(c.lines).length > 0 || !!c.style?.persona;
    const useBox = c.active
      ? h('div', { class: 'cm-use on' }, h('span', { class: 'cm-on' }, `✓ ${c.name} is your coach`), h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: async () => refresh(await use(null)) }, 'Back to the built-in coach'))
      : h(
          'div',
          { class: 'cm-use' },
          h('button', { class: 'btn btn-ink', type: 'button', disabled: !hasLines, title: hasLines ? '' : 'Distill or write some of their lines first', onclick: async () => refresh(await use(c.id)) }, `Make ${c.name} my coach`),
          hasLines ? null : h('span', { class: 'help' }, 'Once there are lines in their voice.'),
        );
    headBox.append(
      h('a', { class: 'back-link', href: '#coach', onclick: (e: Event) => { e.preventDefault(); ctx.back(); } }, '← Coach'),
      h(
        'div',
        { class: 'cm-head' },
        h('div', null, h('p', { class: 'cm-kicker' }, 'A coach made from someone you know'), h('h1', { class: 'display cm-name' }, c.name), c.relation ? h('p', { class: 'cm-rel' }, c.relation) : null),
        useBox,
      ),
      h('p', { class: 'lede' }, `Feed Lock In recordings of ${c.name} and things ${c.name} wrote. Once there's enough, Claude distills how they talk into everything your coach says, and with a minute or two of clean audio (and their yes) it can talk in their voice too.`),
    );
  };

  const use = async (cid: string | null): Promise<CustomCoachView | null> => {
    await api.invoke('coaches:use', cid);
    return api.invoke<CustomCoachView | null>('coaches:get', id);
  };

  // ---- who they are ------------------------------------------------------------------

  const save = async (patch: Record<string, unknown>) => refresh(await api.invoke<CustomCoachView | null>('coaches:update', id, patch));
  const textInput = (value: string, ph: string, onSave: (x: string) => void, label: string) => {
    const i = h('input', { type: 'text', value, placeholder: ph, 'aria-label': label });
    i.addEventListener('change', () => onSave(i.value));
    return i;
  };
  const pushRow = h('div', { class: 'inline cm-push' });
  const drawPush = () => {
    clear(pushRow);
    for (const x of PUSH) {
      pushRow.append(
        h('button', { class: 'chip pick', type: 'button', 'aria-pressed': String(v!.base === x.id), title: x.desc, onclick: async () => { await save({ base: x.id }); drawPush(); } }, x.name),
      );
    }
  };
  drawPush();
  const who = h(
    'div',
    { class: 'section' },
    h('h2', null, 'Who they are'),
    h('div', { class: 'field' }, h('label', null, 'Name'), textInput(v.name, 'Mum', (x) => void save({ name: x }), 'Name')),
    h('div', { class: 'field' }, h('label', null, 'Who they are to you', h('span', { class: 'help' }, 'Claude uses this to get the relationship right.')), textInput(v.relation, 'my mum, my boss, my coach', (x) => void save({ relation: x }), 'Who they are to you')),
    h('div', { class: 'field' }, h('label', null, 'How hard they push', h('span', { class: 'help' }, 'How hard the coach leans on you, and which built-in lines fill any gaps.')), pushRow),
    h('div', { class: 'field' }, h('label', null, 'Language', h('span', { class: 'help' }, 'Leave empty to talk the way they do in the recordings, mixing languages and all.')), textInput(v.language, 'Same as the recordings', (x) => void save({ language: x }), 'Language')),
  );

  // ---- feed it -------------------------------------------------------------------------

  const notes = h('textarea', { class: 'cm-notes', rows: 4, value: v.notes, placeholder: 'What they call you, things they always say, what they nag you about. "Calls me 宝贝. Always asks if I ate. Says \'circle back\' a lot."', 'aria-label': 'Notes about them' });
  notes.addEventListener('change', () => void save({ notes: notes.value }));
  const pasteTitle = h('input', { type: 'text', placeholder: 'Where it is from, e.g. WeChat with Mum, emails from Sam', 'aria-label': 'Title' });
  const pasteText = h('textarea', { rows: 7, placeholder: 'Paste their messages, emails or anything they wrote. If it is a chat, keep the names on each line ("Mum: ...") and Lock In only learns from their side.', 'aria-label': 'Their messages' });
  const pasteNote = h('p', { class: 'help' });
  const pasteBox = h(
    'div',
    { class: 'cm-paste', hidden: true },
    pasteTitle,
    pasteText,
    h(
      'div',
      { class: 'inline' },
      h('button', { class: 'btn btn-small btn-ink', type: 'button', onclick: async () => {
        const r = await api.invoke<{ ok: boolean; error?: string; view: CustomCoachView | null }>('coaches:addText', id, { title: pasteTitle.value || 'Messages', text: pasteText.value });
        if (!r.ok) {
          pasteNote.textContent = r.error ?? "Couldn't add that.";
          return;
        }
        pasteTitle.value = '';
        pasteText.value = '';
        pasteNote.textContent = '';
        pasteBox.hidden = true;
        refresh(r.view);
      } }, 'Add'),
      h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => { pasteBox.hidden = true; } }, 'Cancel'),
      pasteNote,
    ),
  );
  const addNote = h('p', { class: 'help cm-add-note', 'aria-live': 'polite' });
  const addFiles = async (paths?: string[]) => {
    addNote.textContent = paths?.length ? 'Adding…' : '';
    const r = await api.invoke<{ added: number; skipped: { name: string; reason: string }[]; view: CustomCoachView | null }>('coaches:addFiles', id, paths);
    addNote.textContent = r.skipped.length ? r.skipped.map((s) => `${s.name}: ${s.reason}`).join(' ') : r.added ? `Added ${r.added}. Recordings are turned into words by ElevenLabs; it takes a moment.` : '';
    refresh(r.view);
  };
  const drop = h(
    'div',
    { class: 'cm-drop' },
    h('b', null, 'Drop recordings or text files here'),
    h('span', null, 'Voice memos, calls, meetings, videos (.m4a .mp3 .wav .mp4 .mov…), chats or emails saved as text.'),
    h(
      'div',
      { class: 'inline' },
      h('button', { class: 'btn btn-small btn-ink', type: 'button', onclick: () => void addFiles() }, 'Add files…'),
      h('button', { class: 'btn btn-small', type: 'button', onclick: () => { pasteBox.hidden = false; pasteText.focus(); } }, 'Paste messages'),
    ),
  );
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const paths = [...(e.dataTransfer?.files ?? [])].map((f) => api.pathFor?.(f) ?? '').filter(Boolean);
    if (paths.length) void addFiles(paths);
  });
  const meters = h('div', { class: 'cm-meters' });
  const sourcesBox = h('div', { class: 'cm-sources' });

  const meter = (label: string, value: string, tier: string, frac: number, marks: [number, string][], cls = '') =>
    h(
      'div',
      { class: `cm-meter ${cls}` },
      h('div', { class: 'cm-meter-top' }, h('span', null, h('b', null, value), ` ${label}`), h('span', { class: 'cm-tier' }, tier)),
      h('div', { class: 'cm-bar' }, h('i', { style: `width:${Math.round(Math.min(1, frac) * 100)}%` }), ...marks.map(([at]) => h('s', { style: `left:${Math.round(at * 100)}%` }))),
      h('div', { class: 'cm-marks' }, ...marks.map(([at, t]) => h('span', { style: `left:${Math.round(at * 100)}%` }, t))),
    );

  const drawFeed = () => {
    const c = v!;
    const r = c.readiness;
    clear(meters);
    // Words on a curve so the first steps show: 150 → 20%, 800 → 55%, 3000 → 100%.
    const wf = (w: number) => (w <= WORDS.sketch ? (w / WORDS.sketch) * 0.2 : w <= WORDS.good ? 0.2 + ((w - WORDS.sketch) / (WORDS.good - WORDS.sketch)) * 0.35 : 0.55 + (Math.min(w, WORDS.great) - WORDS.good) / (WORDS.great - WORDS.good) * 0.45);
    const tier = r.pending ? `${STYLE_WORD[r.style]} · listening to ${r.pending} more…` : STYLE_WORD[r.style];
    meters.append(
      meter(`of ${her(c)}'s words`, fmt(r.words), tier, wf(r.words), [[0.2, 'first sketch'], [0.55, 'sounds like them'], [1, 'spot on']]),
      meter(`of ${her(c)}'s voice`, mmss(r.theirSec), r.theirSec >= VOICE.good ? 'Plenty to copy' : r.theirSec >= VOICE.min ? 'Enough to copy' : 'Not enough yet', r.theirSec / 180, [[VOICE.min / 180, '1 min'], [VOICE.good / 180, '2 min'], [1, '3 min']], 'voice'),
    );
    clear(sourcesBox);
    if (!c.sources.length) {
      sourcesBox.append(h('p', { class: 'muted' }, 'Nothing yet. A 10-minute call is about 1,000 of their words.'));
      return;
    }
    for (const s of [...c.sources].reverse()) sourcesBox.append(sourceRow(c, s));
  };

  const sourceRow = (c: CustomCoachView, s: CoachSource) => {
    const remove = h('button', { class: 'cm-x', type: 'button', title: 'Remove', 'aria-label': `Remove ${s.title}`, onclick: async () => refresh(await api.invoke<CustomCoachView | null>('coaches:removeSource', id, s.id)) }, '×');
    const icon = s.kind === 'recording' ? '🎙' : '💬';
    let status: Node | string;
    let extra: Node | null = null;
    switch (s.status) {
      case 'waiting':
        status = 'Waiting to be transcribed';
        break;
      case 'transcribing':
        status = h('span', { class: 'cm-busy' }, 'Turning it into words…');
        break;
      case 'error':
        status = h('span', { class: 'bad' }, s.error ?? 'Something went wrong.');
        extra = h('button', { class: 'btn btn-small', type: 'button', onclick: async () => refresh(await api.invoke<CustomCoachView | null>('coaches:retry', id, s.id)) }, 'Try again');
        break;
      case 'pick-speaker':
        status = h('b', { class: 'cm-ask' }, `${s.speakers?.length ?? 0} voices. Which one is ${c.name}?`);
        extra = speakerPicker(c, s);
        break;
      default:
        status =
          s.kind === 'recording'
            ? s.speaker === 'none'
              ? `${c.name} isn't in this one`
              : `${fmt(s.words)} of their words · ${mmss(s.theirSec ?? 0)} of them talking${s.seconds ? ` (of ${mmss(s.seconds)})` : ''}`
            : `${fmt(s.words)} words`;
        if (s.kind === 'recording' && (s.speakers?.length ?? 0) > 1) {
          const change = h('button', { class: 'cm-link', type: 'button' }, 'Wrong voice?');
          change.addEventListener('click', () => {
            row.querySelector('.cm-speakers')?.remove();
            row.append(speakerPicker(c, s));
          });
          extra = change;
        }
    }
    const row = h('div', { class: `cm-source st-${s.status}` }, h('span', { class: 'cm-icon', 'aria-hidden': 'true' }, icon), h('div', { class: 'cm-src-main' }, h('b', null, s.title), h('span', { class: 'cm-src-status' }, status)), remove);
    if (extra) row.append(extra);
    return row;
  };

  const speakerPicker = (c: CustomCoachView, s: CoachSource) =>
    h(
      'div',
      { class: 'cm-speakers' },
      ...(s.speakers ?? []).map((sp, i) =>
        h(
          'button',
          { class: `cm-speaker${s.speaker === sp.id ? ' on' : ''}`, type: 'button', onclick: async () => refresh(await api.invoke<CustomCoachView | null>('coaches:pickSpeaker', id, s.id, sp.id)) },
          h('span', { class: 'cm-sp-name' }, `Voice ${i + 1}`, h('small', null, ` · ${mmss(sp.seconds)}, ${fmt(sp.words)} words`)),
          ...sp.quotes.map((q) => h('q', null, q)),
          h('span', { class: 'cm-sp-pick' }, `That's ${c.name}`),
        ),
      ),
      h('button', { class: 'cm-link', type: 'button', onclick: async () => refresh(await api.invoke<CustomCoachView | null>('coaches:pickSpeaker', id, s.id, null)) }, `${c.name} isn't in this one`),
    );

  const feed = h(
    'div',
    { class: 'section', id: 'cm-feed' },
    h('h2', null, 'Feed it'),
    h('p', { class: 'sub' }, 'The more of their own words, the more it sounds like them. Each recording is turned into words, and if more than one person talks, you pick which voice is them.'),
    meters,
    drop,
    pasteBox,
    addNote,
    sourcesBox,
    h('div', { class: 'cm-notes-row' }, h('label', null, 'What you know about how they talk', h('span', { class: 'help' }, 'Claude reads this too. A few sentences here work even before there are recordings.')), notes),
    h('p', { class: 'muted cm-privacy' }, 'Only use recordings you are allowed to use, and keep the coach to yourself. Recordings stay in Lock In\'s data folder and only go to ElevenLabs (to turn them into words); their words only go to Claude (to learn the style); both with your own keys.'),
  );

  // ---- how they talk -------------------------------------------------------------------

  const drawStyle = () => {
    const c = v!;
    const r = c.readiness;
    clear(styleBox);
    const busy = c.busy === 'distilling';
    const again = !!c.distilledAt;
    const btn = h(
      'button',
      { class: `btn ${again ? '' : 'btn-ink'}`, type: 'button', disabled: busy || !r.canDistill || r.pending > 0 },
      busy ? 'Distilling…' : again ? (r.newWords > 0 ? `Distill again with ${fmt(r.newWords)} new words` : 'Distill again') : `Distill ${c.name}'s voice`,
    );
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Distilling…';
      status.textContent = `Claude is reading everything ${c.name} said. About a minute.`;
      const res = await api.invoke<{ ok: boolean; error?: string; view: CustomCoachView | null }>('coaches:distill', id);
      refresh(res.view, { lines: res.ok });
    });
    const status = h(
      'p',
      { class: `sub cm-status${c.lastError ? ' sheet-error' : ''}`, 'aria-live': 'polite' },
      c.lastError
        ? c.lastError
        : busy
          ? `Claude is reading everything ${c.name} said. About a minute.`
          : again
            ? `Distilled from ${fmt(c.distilledWords ?? 0)} of their words on ${new Date(c.distilledAt!).toLocaleDateString([], { month: 'short', day: 'numeric' })}. Lines you edited stay as you wrote them.`
            : !r.canDistill
              ? `Add about ${WORDS.sketch} of their words (or a few sentences of notes) to start. At ${fmt(WORDS.good)} it distills by itself.`
              : r.pending
                ? 'Waiting for the recordings to be transcribed.'
                : r.words < WORDS.good
                  ? `You can distill now for a rough sketch, or keep feeding it: at ${fmt(WORDS.good)} words it distills by itself.`
                  : 'Ready.',
    );
    styleBox.append(h('h2', null, 'How they talk'), status, h('div', { class: 'inline' }, btn));
    const st = c.style;
    if (st && (st.summary || st.persona)) {
      const persona = h('textarea', { rows: 5, value: st.persona, 'aria-label': 'What Claude is told about them' });
      persona.addEventListener('change', () => void save({ persona: persona.value }));
      styleBox.append(
        h(
          'div',
          { class: 'cm-style' },
          st.summary ? h('p', { class: 'cm-summary' }, st.summary) : null,
          st.callsYou.length ? h('div', { class: 'cm-facts' }, h('span', null, 'Calls you'), ...st.callsYou.map((x) => h('span', { class: 'chip' }, x))) : null,
          st.catchphrases.length ? h('div', { class: 'cm-facts' }, h('span', null, 'Says'), ...st.catchphrases.map((x) => h('span', { class: 'chip' }, x))) : null,
          st.language ? h('div', { class: 'cm-facts' }, h('span', null, 'Talks in'), h('span', { class: 'chip' }, st.language)) : null,
        ),
        h('details', { class: 'how' }, h('summary', null, 'What Claude is told about them'), h('p', { class: 'help' }, 'Used for live lines and conversations. Edit it if it got them wrong.'), persona),
      );
    } else if (!st?.persona) {
      const persona = h('textarea', { rows: 3, value: '', placeholder: `Or describe them yourself: "Talks fast, mixes Mandarin and English, calls me 宝贝, nags about sleep, proud of me underneath."`, 'aria-label': 'Describe how they talk' });
      persona.addEventListener('change', () => void save({ persona: persona.value }));
      styleBox.append(h('details', { class: 'how' }, h('summary', null, 'No Claude key? Describe them yourself'), persona));
    }
  };

  // ---- what they'd say -------------------------------------------------------------------

  const drawLines = () => {
    linesFor++;
    const c = v!;
    clear(linesBox);
    linesBox.append(
      h('h2', null, "What they'd say"),
      h('p', { class: 'sub' }, `Every moment the coach speaks. One line per row; it picks one at random. Words in {curly braces} get filled in. Empty moments use the built-in ${BUILT_IN[c.base]}.`),
    );
    for (const g of LINE_GROUPS) {
      const kinds = LINE_KINDS.filter((k) => LINE_SPECS[k].group === g.id);
      const box = h('details', { class: 'cm-group', open: g.id === 'drift' });
      const filled = kinds.filter((k) => c.lines[k]?.length).length;
      box.append(h('summary', null, h('b', null, g.title), h('span', { class: 'muted' }, ` ${filled} of ${kinds.length} in their voice`)));
      for (const k of kinds) box.append(moment(c, k));
      linesBox.append(box);
    }
  };

  const moment = (c: CustomCoachView, k: CoachLineKind) => {
    const spec = LINE_SPECS[k];
    const ta = h('textarea', { rows: Math.max(2, Math.min(6, (c.lines[k]?.length ?? 0) + 1)), value: (c.lines[k] ?? []).join('\n'), placeholder: 'Empty: the built-in coach says this one.', 'aria-label': spec.label });
    const problem = h('p', { class: 'cm-problem', 'aria-live': 'polite' });
    const check = () => {
      const bad = ta.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => lineProblem(k, l)).find(Boolean);
      problem.textContent = bad ?? '';
    };
    ta.addEventListener('input', check);
    ta.addEventListener('change', async () => {
      const r = await api.invoke<{ ok: string[]; problems: { line: string; problem: string }[]; view: CustomCoachView | null }>('coaches:setLines', id, k, ta.value.split('\n'));
      problem.textContent = r.problems.length ? `Not saved: "${r.problems[0].line}". ${r.problems[0].problem}` : '';
      if (r.view) {
        v = r.view;
        edited.hidden = !v.edited.includes(k);
        drawHead();
      }
    });
    const edited = h('span', { class: 'vc-tag quiet', hidden: !c.edited.includes(k) }, 'yours');
    const hear = h('button', { class: 'btn btn-small btn-quiet', type: 'button', title: 'Hear one, with example details filled in' }, '▶ Hear');
    hear.addEventListener('click', async () => {
      const line = ta.value.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!line.length) return;
      hear.textContent = '…';
      await api.invoke('coaches:hear', id, k, line[Math.floor(Math.random() * line.length)]);
      hear.textContent = '▶ Hear';
    });
    const chips = spec.vars.map((p) =>
      h('button', { class: 'cm-ph', type: 'button', title: PLACEHOLDERS[p], onclick: () => {
        const at = ta.selectionStart ?? ta.value.length;
        ta.value = `${ta.value.slice(0, at)}{${p}}${ta.value.slice(ta.selectionEnd ?? at)}`;
        ta.focus();
        ta.selectionStart = ta.selectionEnd = at + p.length + 2;
        ta.dispatchEvent(new Event('change'));
      } }, `{${p}}`),
    );
    return h(
      'div',
      { class: 'cm-moment' },
      h('div', { class: 'cm-m-head' }, h('b', null, spec.label), edited, h('span', { class: 'cm-m-when' }, spec.when), hear),
      ta,
      chips.length ? h('div', { class: 'cm-phs' }, ...chips) : null,
      problem,
    );
  };

  // ---- their voice -------------------------------------------------------------------------

  const drawVoice = () => {
    const c = v!;
    const r = c.readiness;
    clear(voiceBox);
    voiceBox.append(h('h2', null, `${c.name}'s voice`));
    if (c.voice) {
      const sw = h('input', { type: 'checkbox', checked: c.useVoice, 'aria-label': `Speak in ${c.name}'s voice` });
      sw.addEventListener('change', () => void save({ useVoice: sw.checked }));
      voiceBox.append(
        h('p', { class: 'sub' }, `A copy of ${c.name}'s voice is on your ElevenLabs account, made from ${mmss(c.voice.seconds)} of recordings on ${new Date(c.voice.madeAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}.`),
        h('div', { class: 'field' }, h('label', null, `Speak in ${c.name}'s voice`, h('span', { class: 'help' }, `While ${c.name} is your coach: spoken lines and live conversations.`)), h('label', { class: 'switch' }, sw, h('span'))),
        h(
          'div',
          { class: 'inline cm-voice-actions' },
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => void api.invoke('coaches:hear', id) }, '▶ Hear it'),
          h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: async () => {
            const res = await api.invoke<{ view: CustomCoachView | null }>('coaches:deleteVoice', id);
            refresh(res.view);
          } }, 'Delete the voice'),
        ),
      );
      return;
    }
    const busy = c.busy === 'cloning';
    const consent = h('input', { type: 'checkbox', 'aria-label': 'They agreed' });
    const make = h('button', { class: 'btn btn-ink', type: 'button', disabled: true }, busy ? 'Making it…' : `Make ${c.name}'s voice`);
    const note = h('p', { class: `help cm-clone-note${c.lastError && !busy ? ' bad' : ''}`, 'aria-live': 'polite' }, busy ? 'Working on it…' : c.lastError ?? '');
    const sync = () => {
      make.disabled = busy || !consent.checked || !r.canClone;
    };
    consent.addEventListener('change', sync);
    sync();
    make.addEventListener('click', async () => {
      make.disabled = true;
      make.textContent = 'Making it…';
      const res = await makeVoice(c, (m) => (note.textContent = m));
      note.classList.toggle('bad', !res.ok);
      if (!res.ok) {
        note.textContent = res.error ?? "Couldn't make the voice.";
        make.textContent = `Make ${c.name}'s voice`;
        sync();
      }
      refresh(res.view);
    });
    voiceBox.append(
      h('p', { class: 'sub' }, `With a minute or two of ${c.name} talking on their own, ElevenLabs can make a copy of their voice on your account, and the coach talks in it.`),
      h('p', { class: `cm-need${r.canClone ? ' ok' : ''}` }, r.canClone ? `${mmss(r.theirSec)} of ${c.name} talking: enough.` : `${mmss(r.theirSec)} of ${c.name} talking so far. It needs at least 1:00 (2:00 is better). Voice memos where only they talk work best.`),
      h('label', { class: 'cm-consent' }, consent, h('span', null, `${c.name} knows about this and said yes to me making a copy of their voice for my own Lock In.`)),
      h('div', { class: 'inline' }, make),
      note,
      h('p', { class: 'muted' }, `Needs a paid ElevenLabs plan (Starter or up) and a key with Voices set to Write. You can also make it on elevenlabs.io (Voices, Add a new voice, Instant Voice Clone) and pick it under Voice on the Coach page.`),
    );
  };

  const makeVoice = async (c: CustomCoachView, say: (m: string) => void): Promise<{ ok: boolean; error?: string; view: CustomCoachView | null }> => {
    const plan = await api.invoke<{ sources: { sid: string; title: string; mime: string; seconds: number; segments: Segment[] }[]; seconds: number }>('coaches:clipPlan', id);
    const files: { name: string; data: Uint8Array; mime: string; seconds: number }[] = [];
    const macCut: string[] = [];
    for (const s of plan.sources) {
      say(`Cutting ${c.name}'s voice out of ${s.title}…`);
      // Very long recordings are cut by macOS instead (decoding them here takes a lot of memory).
      if (s.seconds > 30 * 60) {
        macCut.push(s.sid);
        continue;
      }
      try {
        const a = await api.invoke<{ data: Uint8Array; mime: string } | null>('coaches:audio', id, s.sid);
        if (!a) continue;
        const w = await cutVoice(a.data, s.segments);
        if (w.seconds >= 1) files.push({ name: `${s.sid}.wav`, data: w.data, mime: 'audio/wav', seconds: w.seconds });
      } catch {
        macCut.push(s.sid);
      }
    }
    say('Sending it to ElevenLabs…');
    return api.invoke('coaches:clone', id, { files, macCut, consent: true });
  };

  // ---- delete ------------------------------------------------------------------------------

  const delBox = h('div', { class: 'section cm-delete' });
  const drawDelete = (asking = false) => {
    clear(delBox);
    if (!asking) {
      delBox.append(h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => drawDelete(true) }, `Delete ${v!.name}`));
      return;
    }
    const alsoVoice = h('input', { type: 'checkbox', checked: true });
    delBox.append(
      h('p', null, `Delete ${v!.name} and everything you fed it?`),
      ...(v!.voice ? [h('label', { class: 'cm-consent' }, alsoVoice, h('span', null, 'Also delete their voice from my ElevenLabs account'))] : []),
      h(
        'div',
        { class: 'inline' },
        h('button', { class: 'btn btn-small cm-danger', type: 'button', onclick: async () => {
          await api.invoke('coaches:remove', id, !!v!.voice && alsoVoice.checked);
          ctx.back();
        } }, 'Delete'),
        h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => drawDelete(false) }, 'Cancel'),
      ),
    );
  };
  drawDelete();

  page.append(
    headBox,
    who,
    feed,
    h('div', { class: 'section', id: 'cm-style' }, styleBox),
    h('div', { class: 'section', id: 'cm-lines' }, linesBox),
    h('div', { class: 'section', id: 'cm-voice' }, voiceBox),
    delBox,
  );
  refresh(v);
  if (!ctx.current()) return;
  clear(ctx.view);
  ctx.view.append(page);
}
