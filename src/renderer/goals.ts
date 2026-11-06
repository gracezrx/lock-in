// Goals (beta). Big goals first: what you're going after ("Fundraise well"), kept in view with a
// check-in a day, and the work that counts toward them found for you. Then daily habits that
// Lock In measures itself, and the goals it suggests from your patterns.
import type { AttentionView, GoalKind, GoalQuestion, GoalSuggestion, GoalView, GoalsView, Settings } from '../shared/types';
import { api, clear, h } from './lib';

const minToTime = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const timeToMin = (v: string) => {
  const [hh, mm] = v.split(':').map(Number);
  return (hh || 0) * 60 + (mm || 0);
};
const dur = (min: number) => {
  const m = Math.max(0, Math.round(min));
  const hh = Math.floor(m / 60);
  return hh ? `${hh} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
};
const clockAt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Each kind of goal: how you'd say it, the number in it, and a sensible start. */
const KINDS: { kind: GoalKind; label: string; before: string; after: string; unit: 'hours' | 'minutes' | 'count' | 'time' | 'text'; start: number; step?: number; min?: number; max?: number; weekdays?: boolean; help: string }[] = [
  { kind: 'focus', label: 'Focus time', before: 'Focus', after: 'hours a day', unit: 'hours', start: 3, step: 0.5, min: 0.5, max: 12, weekdays: true, help: 'Counted from your focus sessions.' },
  { kind: 'breaks', label: 'Breaks', before: 'A break at least every', after: 'minutes', unit: 'minutes', start: 60, step: 5, min: 15, max: 240, help: 'Five minutes away from the computer counts. Lock In tells you when a stretch runs long.' },
  { kind: 'water', label: 'Water', before: 'Drink water', after: 'times a day', unit: 'count', start: 6, min: 1, max: 20, help: 'Log a glass from the water reminder, the menu bar or your phone.' },
  { kind: 'bedtime', label: 'Stop time', before: 'Off the computer by', after: '', unit: 'time', start: 23 * 60 + 30, help: 'Counted from your last activity of the night. Lock In gives you a heads-up 15 minutes before.' },
  { kind: 'start', label: 'Start time', before: 'Start focusing by', after: '', unit: 'time', start: 10 * 60, weekdays: true, help: 'Counted from your first focus session of the day.' },
  { kind: 'drift', label: 'Less drifting', before: 'Drift under', after: 'minutes a day', unit: 'minutes', start: 20, step: 5, min: 1, max: 240, help: 'Drifting during focus sessions.' },
  { kind: 'todos', label: 'To-dos', before: 'Finish', after: 'to-dos a day', unit: 'count', start: 3, min: 1, max: 30, weekdays: true, help: 'Counted from your to-do list and what you tell Lock In.' },
];

/** Last day of this month, this quarter, or this year, as YYYY-MM-DD. */
const endOf = (what: 'month' | 'quarter' | 'year') => {
  const d = new Date();
  const m = what === 'month' ? d.getMonth() : what === 'quarter' ? Math.floor(d.getMonth() / 3) * 3 + 2 : 11;
  const last = new Date(d.getFullYear(), m + 1, 0);
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
};
const niceDate = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
const KIND_ICON: Record<string, string> = { todo: 'Done', session: 'Locked in', meeting: 'Meeting', you: 'You' };

export interface GoalsCtx {
  view: HTMLElement;
  current: () => boolean;
}

export async function renderGoals(ctx: GoalsCtx): Promise<void> {
  let v = await api.invoke<GoalsView>('goals:get');
  const settings = await api.invoke<Settings>('settings:get');
  if (!ctx.current()) return;
  const page = h('section', { class: 'page goals-page' });
  const nowBox = h('div', { class: 'goal-now' });
  const listBox = h('div', { class: 'habit-list', id: 'goals-sec' });
  const noticedBox = h('div', { class: 'section', id: 'noticed-sec' });
  const addBox = h('div', { class: 'section', id: 'add-goal-sec' });
  const settingsBox = h('div', { class: 'section' });
  const offBox = h('div');
  const bigBox = h('div', { class: 'section big-sec', id: 'big-sec' });
  const askBox = h('div', { class: 'section', id: 'ask-sec' });
  let editing = '';
  let composing = false;

  const set = (next: GoalsView) => {
    v = next;
    drawOff();
    drawBig();
    drawAsk();
    drawNow();
    drawList();
    drawNoticed();
  };

  // ---- Goals switched off: say so, and one button turns it back on ----
  const drawOff = () => {
    clear(offBox);
    if (v.enabled) return;
    offBox.append(
      h(
        'div',
        { class: 'goal-off' },
        h('p', null, 'Goals is off, so there are no nudges or suggestions, and it’s hidden from the side menu. Your goals and rhythm are kept.'),
        h('button', { class: 'btn btn-small btn-ink', type: 'button', onclick: async () => {
          const r = await api.invoke<{ settings: Settings['goals']; view: GoalsView }>('goals:settings', { enabled: true });
          settings.goals = r.settings;
          clear(settingsBox);
          drawSettings();
          set(r.view);
        } }, 'Turn Goals on'),
      ),
    );
  };

  // ---- right now: the stretch since your last break, and water ----
  const drawNow = () => {
    clear(nowBox);
    nowBox.append(
      h('div', { class: 'goal-now-item' }, h('span', null, 'Since your last break'), h('b', null, v.now.stretchMin ? dur(v.now.stretchMin) : 'Just back')),
      h('div', { class: 'goal-now-item' }, h('span', null, 'Water today'), h('b', null, `${v.now.water} ${v.now.water === 1 ? 'glass' : 'glasses'}`)),
      h('button', { class: 'btn btn-small', type: 'button', onclick: async () => set(await api.invoke<GoalsView>('goals:water')) }, '💧 Drank a glass'),
    );
  };

  // ---- your goals ----
  const marks = (g: GoalView) =>
    h(
      'div',
      { class: 'goal-week', 'aria-label': `Hit on ${g.hits} of the last ${g.of} goal days` },
      ...g.week.map((w) => h('span', { class: `gw ${w.hit === true ? 'hit' : w.hit === false ? 'miss' : 'none'}`, title: `${w.label}: ${w.hit === true ? 'hit' : w.hit === false ? 'missed' : 'not counted'}` }, h('i'), h('small', null, w.label))),
      g.of ? h('span', { class: 'gw-sum' }, `${g.hits} of ${g.of} days`) : null,
    );

  const editor = (g: GoalView) => {
    const spec = KINDS.find((k) => k.kind === g.kind)!;
    const target = spec.unit === 'time' ? h('input', { type: 'time', value: minToTime(g.target) }) : spec.unit === 'text' ? h('input', { type: 'text', value: g.title ?? '' }) : h('input', { type: 'number', value: String(g.target), step: String(spec.step ?? 1), min: String(spec.min ?? 1), max: String(spec.max ?? 99) });
    const why = h('input', { type: 'text', value: g.why ?? '', placeholder: 'Why it matters (optional)' });
    const days = h('select', null, h('option', { value: 'every', selected: g.days === 'every' }, 'Every day'), h('option', { value: 'weekdays', selected: g.days === 'weekdays' }, 'Weekdays only'));
    const save = async () => {
      const patch: Record<string, unknown> = { why: why.value, days: days.value };
      if (spec.unit === 'time') patch.target = timeToMin((target as HTMLInputElement).value);
      else if (spec.unit === 'text') patch.title = (target as HTMLInputElement).value;
      else patch.target = Number((target as HTMLInputElement).value);
      editing = '';
      set(await api.invoke<GoalsView>('goals:update', g.id, patch));
    };
    return h(
      'div',
      { class: 'goal-edit' },
      h('label', null, spec.unit === 'text' ? 'Goal' : spec.before || 'Target', h('span', { class: 'goal-edit-row' }, target, spec.after ? h('span', { class: 'muted' }, spec.after) : null)),
      h('label', null, 'Counts on', days),
      h('label', { class: 'wide' }, 'Why', why),
      h(
        'div',
        { class: 'inline' },
        h('button', { class: 'btn btn-small btn-ink', type: 'button', onclick: () => void save() }, 'Save'),
        h('button', { class: 'btn btn-small', type: 'button', onclick: async () => { editing = ''; set(await api.invoke<GoalsView>('goals:update', g.id, { paused: !g.paused })); } }, g.paused ? 'Resume' : 'Pause'),
        h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: async () => { editing = ''; set(await api.invoke<GoalsView>('goals:remove', g.id)); } }, 'Delete'),
        h('button', { class: 'link-btn', type: 'button', onclick: () => { editing = ''; drawList(); } }, 'Cancel'),
      ),
    );
  };

  const drawList = () => {
    clear(listBox);
    const habits = v.goals.filter((g) => g.kind !== 'custom');
    if (!habits.length) {
      listBox.append(h('p', { class: 'empty' }, 'No habits yet. Take one Lock In noticed below, or add one.'));
      return;
    }
    for (const g of habits) {
      const card = h(
        'article',
        { class: `goal-card tone-${g.tone}${g.paused ? ' paused' : ''}` },
        h(
          'div',
          { class: 'goal-top' },
          h('h3', null, g.name),
          g.source !== 'you' ? h('span', { class: 'vc-tag quiet' }, g.source === 'coach' ? 'From the coach' : 'Lock In noticed') : null,
          h('button', { class: 'link-btn goal-edit-btn', type: 'button', onclick: () => { editing = editing === g.id ? '' : g.id; drawList(); } }, editing === g.id ? 'Close' : 'Edit'),
        ),
        g.why ? h('p', { class: 'goal-why' }, g.why) : null,
        h(
          'div',
          { class: 'goal-progress' },
          g.pct !== null ? h('div', { class: 'goal-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(g.pct * 100) }, h('i', { style: `width:${Math.max(2, Math.round(g.pct * 100))}%` })) : null,
          h('p', null, h('b', null, g.progress), h('span', null, g.status)),
        ),
        marks(g),
      );
      if (editing === g.id) card.append(editor(g));
      listBox.append(card);
    }
  };

  // ---- big goals ----
  const bigEditor = (g: GoalView) => {
    const title = h('input', { type: 'text', value: g.title ?? '', 'aria-label': 'Goal' });
    const why = h('input', { type: 'text', value: g.why ?? '', placeholder: 'Why it matters (optional)' });
    const until = h('input', { type: 'date', value: g.until ?? '', 'aria-label': 'Until' });
    const counts = h('input', { type: 'text', value: (g.terms ?? []).join(', '), placeholder: 'investors, pitch deck, Sequoia' });
    const daily = h('input', { type: 'checkbox', checked: g.daily !== false, 'aria-label': 'Check in once a day' });
    const save = async () => {
      editing = '';
      set(await api.invoke<GoalsView>('goals:update', g.id, { title: title.value, why: why.value, until: until.value || '', counts: counts.value.split(',').map((x) => x.trim()).filter(Boolean), daily: daily.checked }));
    };
    return h(
      'div',
      { class: 'goal-edit' },
      h('label', { class: 'wide' }, 'Goal', title),
      h('label', { class: 'wide' }, 'Why', why),
      h('label', null, 'Until', until),
      h('label', { class: 'check' }, daily, 'Check in once a day if nothing has happened yet'),
      h('label', { class: 'wide' }, 'What counts toward it', counts, h('span', { class: 'help' }, 'Words and names that show up in your to-dos, sessions and meetings when you work on it. Separate them with commas.')),
      h(
        'div',
        { class: 'inline' },
        h('button', { class: 'btn btn-small btn-ink', type: 'button', onclick: () => void save() }, 'Save'),
        h('button', { class: 'btn btn-small', type: 'button', onclick: async () => { editing = ''; set(await api.invoke<GoalsView>('goals:update', g.id, { paused: !g.paused })); } }, g.paused ? 'Resume' : 'Pause'),
        h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: async () => { editing = ''; set(await api.invoke<GoalsView>('goals:remove', g.id)); } }, 'Delete'),
        h('button', { class: 'link-btn', type: 'button', onclick: () => { editing = ''; drawBig(); } }, 'Cancel'),
      ),
    );
  };

  const bigComposer = () => {
    const title = h('input', { type: 'text', placeholder: 'Fundraise well', 'aria-label': 'What are you going after?' });
    const why = h('input', { type: 'text', placeholder: 'Why it matters, in a few words (optional)', 'aria-label': 'Why it matters' });
    const date = h('input', { type: 'date', hidden: true, 'aria-label': 'Until' });
    const until = h('select', { 'aria-label': 'Until' }, h('option', { value: '' }, 'No end date'), h('option', { value: 'month' }, `End of this month (${niceDate(endOf('month'))})`), h('option', { value: 'quarter', selected: true }, `End of this quarter (${niceDate(endOf('quarter'))})`), h('option', { value: 'year' }, `End of the year (${niceDate(endOf('year'))})`), h('option', { value: 'date' }, 'Pick a date…'));
    until.addEventListener('change', () => {
      date.hidden = until.value !== 'date';
      if (!date.hidden) date.focus();
    });
    const note = h('p', { class: 'muted', 'aria-live': 'polite' });
    const add = h('button', { class: 'btn btn-small btn-ink', type: 'button' }, 'Add goal');
    add.addEventListener('click', async () => {
      if (!title.value.trim()) {
        note.textContent = 'Write what you’re going after first.';
        title.focus();
        return;
      }
      const u = until.value === 'date' ? date.value : until.value ? endOf(until.value as 'month' | 'quarter' | 'year') : '';
      add.disabled = true;
      note.textContent = v.canAskCoach ? 'Working out what counts toward it…' : '';
      const r = await api.invoke<{ ok: boolean; view: GoalsView }>('goals:add', { kind: 'custom', title: title.value, why: why.value, until: u, days: 'every' });
      add.disabled = false;
      if (!r.ok) {
        note.textContent = 'That didn’t work. Try again.';
        return;
      }
      composing = false;
      set(r.view);
    });
    const examples = ['Fundraise well', 'Launch cool side products', 'Get our first 100 users'].map((x) => h('button', { class: 'chip pick', type: 'button', onclick: () => { title.value = x; title.focus(); } }, x));
    return h(
      'div',
      { class: 'goal-composer big-composer' },
      h('label', { class: 'big-q' }, 'What are you going after?', title),
      h('div', { class: 'goal-kinds' }, ...examples),
      why,
      h('div', { class: 'inline' }, until, date),
      h('p', { class: 'muted' }, 'Lock In counts the to-dos you finish, what you lock in on and your meetings toward it. Once a day, at a natural pause, it checks in if nothing has happened yet, and it asks when something you keep working on might be part of it.'),
      h('div', { class: 'inline' }, add, v.goals.some((g) => g.kind === 'custom') ? h('button', { class: 'link-btn', type: 'button', onclick: () => { composing = false; drawBig(); } }, 'Cancel') : null),
      note,
    );
  };

  const bigCard = (g: GoalView) => {
    const card = h(
      'article',
      { class: `goal-card big-card tone-${g.tone}${g.paused ? ' paused' : ''}` },
      h(
        'div',
        { class: 'goal-top' },
        h('h3', null, g.title ?? g.name),
        g.daysLeft !== undefined ? h('span', { class: `vc-tag${g.daysLeft <= 7 ? '' : ' quiet'}` }, g.daysLeft < 0 ? 'Ended' : g.daysLeft === 0 ? 'Last day' : `${g.daysLeft} days left`) : null,
        h('button', { class: 'link-btn goal-edit-btn', type: 'button', onclick: () => { editing = editing === g.id ? '' : g.id; drawBig(); } }, editing === g.id ? 'Close' : 'Edit'),
      ),
      g.why ? h('p', { class: 'goal-why' }, g.why) : null,
      h(
        'div',
        { class: 'goal-progress' },
        h('p', null, h('b', null, g.progress)),
        !g.paused
          ? h('button', { class: `btn btn-small${g.tone === 'done' ? ' btn-on' : ' btn-ink'}`, type: 'button', onclick: async () => set(await api.invoke<GoalsView>('goals:check', g.id, g.tone !== 'done')) }, g.tone === 'done' ? '✓ Moved it forward today' : 'I moved it forward today')
          : null,
      ),
      marks(g),
      g.nextStep && !g.paused
        ? h('div', { class: 'big-next' }, h('span', null, 'Next on your list: ', h('b', null, `“${g.nextStep}”`)), h('button', { class: 'btn btn-small', type: 'button', onclick: () => void api.invoke('session:start', { goal: g.nextStep, minutes: 50, pomodoro: false }) }, 'Lock in on it'))
        : null,
      g.moved?.length
        ? h('div', { class: 'big-moved' }, h('h4', null, 'What moved it'), h('ul', null, g.moved.slice(0, 4).map((m) => h('li', null, h('span', { class: 'muted' }, `${m.label} · ${KIND_ICON[m.kind]}`), ' ', m.text))))
        : null,
      h('p', { class: 'big-terms muted' }, g.terms?.length ? `Counts: ${g.terms.join(' · ')}` : 'Nothing listed as counting yet: Edit to add words and names.'),
    );
    if (editing === g.id) card.append(bigEditor(g));
    return card;
  };

  const drawBig = () => {
    clear(bigBox);
    const big = v.goals.filter((g) => g.kind === 'custom');
    bigBox.append(h('h2', null, 'What you’re going after'), h('p', { class: 'sub' }, 'The big things for this stretch of your life. Lock In keeps them in view: it notices what you do for them, and checks in once a day when nothing has happened yet.'));
    if (!big.length || composing) bigBox.append(bigComposer());
    for (const g of big) bigBox.append(bigCard(g));
    if (big.length && !composing) bigBox.append(h('button', { class: 'btn btn-small big-add', type: 'button', onclick: () => { composing = true; drawBig(); bigBox.querySelector<HTMLInputElement>('.big-q input')?.focus(); } }, '+ Add a big goal'));
  };

  // ---- "Is Lock In one of your cool side products?" ----
  const question = (q: GoalQuestion) => {
    const goals = q.goalIds.map((id) => v.goals.find((g) => g.id === id)).filter(Boolean) as GoalView[];
    const answer = async (goalId: string | null) => set((await api.invoke<{ ok: boolean; view: GoalsView }>('goals:answer', q.id, goalId)).view);
    return h(
      'article',
      { class: 'goal-sug ask-card' },
      h('h3', null, q.text),
      h('p', { class: 'goal-evidence' }, q.evidence),
      h(
        'div',
        { class: 'inline' },
        goals.length === 1
          ? [h('button', { class: 'btn btn-small btn-ink', type: 'button', onclick: () => void answer(goals[0].id) }, 'Yes, it counts'), h('button', { class: 'btn btn-small', type: 'button', onclick: () => void answer(null) }, 'No')]
          : [...goals.map((g) => h('button', { class: 'btn btn-small', type: 'button', onclick: () => void answer(g.id) }, `Part of “${g.title}”`)), h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => void answer(null) }, 'None of them')],
      ),
    );
  };
  const drawAsk = () => {
    clear(askBox);
    askBox.hidden = !v.questions.length;
    if (!v.questions.length) return;
    askBox.append(h('h2', null, 'Lock In is asking'), h('p', { class: 'sub' }, 'Things you keep coming back to. Tell Lock In whether they count, and it will notice them from now on.'), ...v.questions.map(question));
  };

  // ---- what Lock In noticed ----
  const ideasNote = h('p', { class: 'muted', 'aria-live': 'polite' });
  const drawNoticed = () => {
    clear(noticedBox);
    noticedBox.append(h('h3', { class: 'habits-sub' }, 'Lock In noticed'));
    if (!settings.goals.suggest) {
      noticedBox.append(h('p', { class: 'muted' }, 'Suggestions are off (below).'));
      return;
    }
    if (!v.suggestions.length) {
      noticedBox.append(
        h(
          'p',
          { class: 'empty' },
          v.daysSeen < 3
            ? 'Lock In is learning your rhythm: when you start and stop, how long you go without a break, and how much you focus. Suggestions start after about three days at the computer.'
            : 'Nothing stands out right now. Your days look like your goals.',
        ),
      );
    }
    for (const s of v.suggestions) noticedBox.append(suggestion(s));
    if (v.canAskCoach) {
      const btn = h('button', { class: 'btn btn-small', type: 'button' }, 'Ask the coach for ideas');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        ideasNote.textContent = 'The coach is looking at your last two weeks…';
        const r = await api.invoke<{ ok: boolean; error?: string; view: GoalsView }>('goals:ideas');
        btn.disabled = false;
        ideasNote.textContent = r.ok ? '' : r.error ?? '';
        set(r.view);
      });
      noticedBox.append(h('div', { class: 'inline goal-ideas' }, btn, ideasNote));
    }
  };

  const suggestion = (s: GoalSuggestion) =>
    h(
      'article',
      { class: 'goal-sug' },
      h('div', { class: 'goal-top' }, h('h3', null, s.name), h('span', { class: 'vc-tag quiet' }, s.goalId ? (s.change === 'raise' ? 'A step up' : 'A step you can hit') : s.source === 'coach' ? 'From the coach' : 'From your patterns')),
      s.evidence ? h('p', { class: 'goal-evidence' }, s.evidence) : null,
      s.why ? h('p', { class: 'goal-why' }, s.why) : null,
      h(
        'div',
        { class: 'inline' },
        h('button', { class: 'btn btn-small btn-ink', type: 'button', onclick: async () => {
          const r = await api.invoke<{ ok: boolean; view: GoalsView }>('goals:accept', s.id);
          set(r.view);
        } }, s.goalId ? 'Change it' : 'Make it a goal'),
        h('button', { class: 'btn btn-small', type: 'button', onclick: () => openComposer(s.kind, s.target, s.days) }, 'Change the target'),
        h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: async () => set(await api.invoke<GoalsView>('goals:later', s.id)) }, 'Not now'),
        h('button', { class: 'link-btn', type: 'button', onclick: async () => set(await api.invoke<GoalsView>('goals:never', s.id)) }, "Don't suggest this"),
      ),
    );

  // ---- add a goal ----
  const kindRow = h('div', { class: 'goal-kinds' });
  const composer = h('div', { class: 'goal-composer' });
  let chosen: GoalKind | null = null;
  const openComposer = (kind: GoalKind, target?: number, daysVal?: 'every' | 'weekdays') => {
    chosen = kind;
    drawKinds();
    const spec = KINDS.find((k) => k.kind === kind)!;
    clear(composer);
    const value = spec.unit === 'time' ? h('input', { type: 'time', value: minToTime(target ?? spec.start), 'aria-label': spec.before }) : spec.unit === 'text' ? h('input', { type: 'text', placeholder: 'Ship the Captain launch', 'aria-label': 'Your goal' }) : h('input', { type: 'number', value: String(target ?? spec.start), step: String(spec.step ?? 1), min: String(spec.min ?? 1), max: String(spec.max ?? 99), 'aria-label': spec.before });
    const days = h('select', { 'aria-label': 'Counts on' }, h('option', { value: 'every', selected: (daysVal ?? (spec.weekdays ? 'weekdays' : 'every')) === 'every' }, 'every day'), h('option', { value: 'weekdays', selected: (daysVal ?? (spec.weekdays ? 'weekdays' : 'every')) === 'weekdays' }, 'on weekdays'));
    const why = h('input', { type: 'text', placeholder: 'Why it matters, in a few words (optional)', 'aria-label': 'Why it matters' });
    const note = h('p', { class: 'sheet-error', hidden: true });
    const add = async () => {
      const p: Record<string, unknown> = { kind, why: why.value, days: days.value };
      if (spec.unit === 'time') p.target = timeToMin((value as HTMLInputElement).value);
      else if (spec.unit === 'text') p.title = (value as HTMLInputElement).value;
      else p.target = Number((value as HTMLInputElement).value);
      const r = await api.invoke<{ ok: boolean; view: GoalsView }>('goals:add', p);
      if (!r.ok) {
        note.hidden = false;
        note.textContent = spec.unit === 'text' ? 'Write the goal first.' : 'That target doesn’t work. Try another number.';
        return;
      }
      chosen = null;
      clear(composer);
      drawKinds();
      set(r.view);
      document.getElementById('goals-sec')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };
    composer.append(
      h('div', { class: 'goal-sentence' }, spec.before ? h('span', null, spec.before) : null, value, spec.after ? h('span', null, spec.after) : null, spec.unit !== 'text' ? days : null),
      h('p', { class: 'muted' }, spec.help),
      why,
      h('div', { class: 'inline' }, h('button', { class: 'btn btn-small btn-ink', type: 'button', onclick: () => void add() }, 'Add goal'), h('button', { class: 'link-btn', type: 'button', onclick: () => { chosen = null; clear(composer); drawKinds(); } }, 'Cancel')),
      note,
    );
    addBox.scrollIntoView({ block: 'start', behavior: 'smooth' });
    (value as HTMLInputElement).focus();
  };
  const drawKinds = () => {
    clear(kindRow);
    for (const k of KINDS) kindRow.append(h('button', { class: 'chip pick', type: 'button', 'aria-pressed': String(chosen === k.kind), onclick: () => openComposer(k.kind) }, k.label));
  };
  drawKinds();
  addBox.append(h('h3', { class: 'habits-sub' }, 'Add a habit'), h('p', { class: 'sub' }, 'Pick one. Lock In measures it for you from what it already sees.'), kindRow, composer);

  // ---- settings ----
  const sw = (on: boolean, label: string, key: keyof Settings['goals']) => {
    const input = h('input', { type: 'checkbox', checked: on, 'aria-label': label });
    input.addEventListener('change', async () => {
      const r = await api.invoke<{ settings: Settings['goals']; view: GoalsView }>('goals:settings', { [key]: input.checked });
      settings.goals = r.settings;
      set(r.view);
    });
    return h('label', { class: 'switch' }, input, h('span'));
  };
  const row = (label: string, help: string, control: Node) => h('div', { class: 'field' }, h('label', null, label, h('span', { class: 'help' }, help)), h('div', { class: 'inline' }, control));
  const drawSettings = () => settingsBox.append(
    h('h2', null, 'Goals settings'),
    row('Suggest goals from my patterns', 'At most one “Lock In noticed something” a day, at a natural pause. It also suggests raising a goal you keep hitting, or easing one that keeps being out of reach.', sw(settings.goals.suggest, 'Suggest goals from my patterns', 'suggest')),
    row('Nudge me toward my goals', 'A break reminder when a stretch runs long, focus time offered at a natural pause when you’re behind and your calendar has room, and a heads-up before your stop time.', sw(settings.goals.nudges, 'Nudge me toward my goals', 'nudges')),
    row('Goals is on', 'Turn the whole beta off. Your goals and rhythm are kept, and you can turn it back on in Settings.', sw(settings.goals.enabled, 'Goals is on', 'enabled')),
  );
  drawSettings();


  page.append(
    h('div', { class: 'goals-head' }, h('h1', { class: 'display' }, 'Goals'), h('span', { class: 'beta-tag' }, 'Beta')),
    h('p', { class: 'lede' }, 'What you’re going after, kept in view every day, and the small habits that get you there.'),
    offBox,
    bigBox,
    askBox,
    h('div', { class: 'section habits-head' }, h('h2', null, 'Daily habits'), h('p', { class: 'sub' }, 'Small things Lock In measures for you: focus time, breaks, water, a stop time. It also suggests habits from your patterns, with the numbers behind them.')),
    nowBox,
    listBox,
    noticedBox,
    addBox,
    settingsBox,
  );
  set(v);
  if (!ctx.current()) return;
  clear(ctx.view);
  ctx.view.append(page);
}

/** A line of today's goals for the Lock in page. */
export function goalStrip(v: GoalsView, open: () => void): HTMLElement | null {
  const live = v.goals.filter((g) => !g.paused && g.tone !== 'idle');
  if (!v.enabled || (!live.length && !v.suggestions.length)) return null;
  return h(
    'div',
    { class: 'goal-strip' },
    h('span', { class: 'muted' }, 'Today’s goals'),
    // A stop time is about tonight, so it shows tonight's status rather than last night's.
    ...live.slice(0, 4).map((g) => h('button', { class: `goal-chip tone-${g.tone}`, type: 'button', title: `${g.name}: ${g.status}`, onclick: open }, g.kind === 'bedtime' ? h('b', null, g.status) : [h('b', null, g.progress), h('span', null, g.name)])),
    !live.length && v.suggestions.length ? h('button', { class: 'link-btn', type: 'button', onclick: open }, `Lock In noticed something: ${v.suggestions[0].name}`) : null,
  );
}

/** Your week in numbers (Progress page): what habits are measured from. Only times and totals. */
export function rhythmSection(v: GoalsView): HTMLElement {
  const box = h('div', { class: 'section', id: 'rhythm-sec' });
  box.append(h('h2', null, 'Your week'), h('p', { class: 'sub' }, 'When you were at the computer, how long you went without a break, and water you logged. Only times and totals: no apps, sites or titles.'));
  const tbl = h(
    'table',
    { class: 'table goal-table' },
    h('thead', null, h('tr', null, h('th', null, 'Day'), h('th', null, 'At the computer'), h('th', null, 'Focused'), h('th', null, 'Longest without a break'), h('th', null, 'Water'), h('th', null, 'Last active'))),
    h(
      'tbody',
      null,
      v.week.map((d) =>
        h('tr', null, h('td', null, d.label), h('td', null, d.activeMin ? dur(d.activeMin) : '–'), h('td', null, d.focusMin ? dur(d.focusMin) : '–'), h('td', null, d.longestMin ? dur(d.longestMin) : '–'), h('td', null, d.water ? String(d.water) : '–'), h('td', null, d.lastAt ? clockAt(d.lastAt) : '–')),
      ),
    ),
  );
  box.append(h('div', { class: 'goal-table-wrap' }, tbl));
  return box;
}

/** Settings → How Lock In reaches out: natural pauses, the daily budget, and what it learned (attention.ts). */
export function reachSection(): HTMLElement {
  const reachBox = h('div', { class: 'section', id: 'reach-sec' });
  const row = (label: string, help: string, control: Node) => h('div', { class: 'field' }, h('label', null, label, h('span', { class: 'help' }, help)), h('div', { class: 'inline' }, control));
  const drawReach = (a: AttentionView) => {
    clear(reachBox);
    const setA = async (patch: Partial<AttentionView['settings']>) => drawReach(await api.invoke<AttentionView>('attention:set', patch));
    const pauses = h('input', { type: 'checkbox', checked: a.settings.pauses, 'aria-label': 'Wait for a natural pause' });
    pauses.addEventListener('change', () => void setA({ pauses: pauses.checked }));
    const pick = (value: number, options: number[], label: (n: number) => string, aria: string, key: 'maxPerDay' | 'minGapMin') => {
      const sel = h('select', { 'aria-label': aria }, ...[...new Set([...options, value])].sort((x, y) => x - y).map((n) => h('option', { value: String(n), selected: n === value }, label(n))));
      sel.addEventListener('change', () => void setA({ [key]: Number(sel.value) }));
      return sel;
    };
    reachBox.append(
      h('h2', null, 'How Lock In reaches out'),
      h('p', { class: 'sub' }, 'Reminders that can wait (water, stretching, lunch, goal check-ins, “Lock In noticed something”) wait for a natural pause: when you’re back from a break, a session or meeting ends, or you finish a to-do. Meetings, deadlines, roasts and bedtime still come when they need to.'),
      row('Wait for a natural pause', 'If no pause comes, a reminder goes out anyway after a while, or is dropped once it no longer applies.', h('label', { class: 'switch' }, pauses, h('span'))),
      row('Cards a day, at most', `For the reminders that can wait. Today so far: ${a.sentToday}${a.waiting ? `, and ${a.waiting} waiting for a pause` : ''}.`, pick(a.settings.maxPerDay, [4, 6, 8, 12, 20], (n) => `${n} a day`, 'Cards a day, at most', 'maxPerDay')),
      row('Quiet time between cards', 'After any card, even a meeting heads-up or a roast.', pick(a.settings.minGapMin, [10, 20, 30, 45, 60], (n) => `${n} minutes`, 'Quiet time between cards', 'minGapMin')),
      h('h3', { class: 'reach-head' }, 'What Lock In has learned'),
    );
    if (!a.kinds.length) {
      reachBox.append(h('p', { class: 'muted' }, 'Nothing yet. Cards you keep ignoring will come less often, and acting on one brings them back.'));
      return;
    }
    reachBox.append(
      h(
        'ul',
        { class: 'reach-list' },
        a.kinds.map((k) =>
          h(
            'li',
            null,
            h('div', null, h('b', null, k.name), h('span', { class: 'muted' }, ` · shown ${k.shown}, used ${k.acted}`)),
            k.skipEvery
              ? h(
                  'p',
                  null,
                  `You let the last ${k.streak} go by, so it now skips ${k.skipEvery === 1 ? 'every other one' : `${k.skipEvery} of every ${k.skipEvery + 1}`}. `,
                  h('button', { class: 'link-btn', type: 'button', onclick: async () => drawReach(await api.invoke<AttentionView>('attention:reset', k.kind)) }, 'Back to normal'),
                )
              : null,
          ),
        ),
      ),
    );
  };
  void api.invoke<AttentionView>('attention:get').then(drawReach);
  return reachBox;
}
