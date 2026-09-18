import {
  DAY, weekendPlan, weekendWindow, personName, otherPerson,
  completeTask, undoTask, assignments, startOfDay, ownerOf, upNext,
} from './schedule.js';
import { celebrate } from './animations.js';

const CFG = window.CLEANIT_CONFIG;
const API = CFG.apiBase ?? 'https://api.github.com';

/* ---------- device-local settings ---------- */

const local = {
  get me() { return localStorage.getItem('cl.me'); },
  set me(v) { localStorage.setItem('cl.me', v); },
  get token() { return localStorage.getItem('cl.token') || ''; },
  set token(v) { v ? localStorage.setItem('cl.token', v) : localStorage.removeItem('cl.token'); },
};

let state = null;
let stateSha = null;
let busy = false;

/* ---------- small helpers ---------- */

const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of kids.flat()) {
    if (kid != null) node.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return node;
}

const b64encode = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const b64decode = (b64) => {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

function banner(msg, ok = false) {
  const b = $('#banner');
  b.textContent = msg;
  b.className = ok ? 'banner ok' : 'banner';
  b.hidden = !msg;
}

function fmtDate(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function relative(due, now = new Date()) {
  if (!due) return 'never done';
  const days = Math.round((due - now) / DAY);
  if (days < -1) return `${-days} days overdue`;
  if (days <= 0) return 'due now';
  if (days === 1) return 'due tomorrow';
  if (days <= 13) return `due in ${days} days`;
  return `due ${fmtDate(due)}`;
}

/* ---------- GitHub storage ---------- */

async function gh(path, options = {}) {
  const headers = { Accept: 'application/vnd.github+json', ...options.headers };
  if (local.token) headers.Authorization = `Bearer ${local.token}`;
  const res = await fetch(`${API}/repos/${CFG.repo}/contents/${path}`, { ...options, headers });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    err.conflict = res.status === 409 || res.status === 422;
    throw err;
  }
  return res.json();
}

async function loadFile(path) {
  const json = await gh(`${path}?ref=${CFG.branch}&t=${Date.now()}`);
  return { data: JSON.parse(b64decode(json.content)), sha: json.sha };
}

async function putFile(path, data, sha, message) {
  return gh(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: b64encode(JSON.stringify(data, null, 2) + '\n'),
      sha,
      branch: CFG.branch,
    }),
  });
}

/**
 * Apply `change` to the freshest copy of the state and commit it.
 * If the other person committed in between, re-fetch and replay rather than
 * clobbering their edit.
 */
async function mutate(change, message) {
  if (!local.token) {
    banner('Add a GitHub token in Settings before making changes.');
    return false;
  }
  if (busy) return false;
  busy = true;
  render();
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const fresh = await loadFile(CFG.dataPath);
      change(fresh.data);
      try {
        const res = await putFile(CFG.dataPath, fresh.data, fresh.sha, message);
        state = fresh.data;
        stateSha = res.content.sha;
        banner('');
        return true;
      } catch (e) {
        if (!e.conflict || attempt === 3) throw e;
      }
    }
  } catch (e) {
    banner(e.message);
    return false;
  } finally {
    busy = false;
    render();
  }
}

async function refresh() {
  try {
    const fresh = await loadFile(CFG.dataPath);
    state = fresh.data;
    stateSha = fresh.sha;
    banner('');
  } catch (e) {
    if (!local.token) {
      banner('Welcome. Add your GitHub token below to get started.');
    } else if (e.status === 403) {
      banner(`That token is not allowed to read ${CFG.repo}. It needs Contents: Read and write.`);
    } else if (e.status === 404) {
      banner(
        `Could not find ${CFG.dataPath} in ${CFG.repo}. ` +
        `Either the file is not there, or the token has no access to that repo.`
      );
    } else {
      banner(`Couldn't load data. ${e.message}`);
    }
  }
  render();
}

/* ---------- weekend view ---------- */

function weekendRows(now) {
  const { window, byPerson } = weekendPlan(state, now);

  // Mon-Thu the window points at the *coming* weekend, so a chore knocked out
  // early would otherwise vanish instead of showing as done. Always look back
  // at least to the start of today.
  const since = new Date(
    Math.min(window.start.getTime(), startOfDay(now, state.timezone || 'UTC').getTime())
  );
  const inWindow = state.log.filter((e) => {
    const t = new Date(e.at);
    return t >= since && t <= window.end;
  });

  const rows = {};
  for (const person of state.people) {
    const pending = (byPerson[person.id] || []).map((a) => ({
      taskId: a.task.id,
      task: a.task,
      personId: person.id,
      done: false,
      dueAt: a.dueAt,
      lastDone: a.lastDone,
    }));
    const finished = inWindow
      .filter((e) => e.by === person.id)
      .map((e) => {
        const task = state.tasks.find((t) => t.id === e.taskId);
        return task && {
          taskId: task.id, task, personId: person.id,
          done: true, at: new Date(e.at),
        };
      })
      .filter(Boolean);
    rows[person.id] = [...pending, ...finished];
  }
  return { window, rows };
}

function taskCard(row, interactive) {
  const check = el('button', {
    type: 'button',
    className: row.done ? 'check done' : 'check',
    textContent: '✓',
    disabled: busy || !interactive,
    ariaLabel: row.done ? `Undo ${row.task.name}` : `Mark ${row.task.name} done`,
  });

  check.addEventListener('click', async () => {
    const name = personName(state, row.personId);
    if (row.done) {
      await mutate(
        (s) => undoTask(s, row.taskId, row.personId),
        `Undo: ${row.task.name} (${name})`
      );
      return;
    }
    // Start the celebration immediately — waiting on the round trip to GitHub
    // would put it a second after the tap, long past feeling like a response.
    celebrate(row.task);
    await mutate(
      (s) => completeTask(s, row.taskId, row.personId, new Date()),
      `Done: ${row.task.name} (${name})`
    );
  });

  // Build the meta line as parts so the overdue span can be styled without
  // having to pick the sentence back apart.
  const parts = [];
  if (row.done) {
    const next = new Date(row.at.getTime() + row.task.frequencyDays * DAY);
    const who = row.task.mode === 'each'
      ? personName(state, row.personId)
      : personName(state, otherPerson(state, row.personId));
    parts.push(`Done ${fmtDate(row.at)}`, `next ${fmtDate(next)}, ${who}`);
  } else if (!row.lastDone) {
    parts.push('Never done yet');
  } else {
    const overdue = row.dueAt < new Date(Date.now() - DAY);
    parts.push(
      overdue
        ? el('span', { className: 'overdue', textContent: relative(row.dueAt) })
        : relative(row.dueAt),
      `last done ${fmtDate(row.lastDone.at)} by ${personName(state, row.lastDone.by)}`
    );
  }

  const meta = el('div', { className: 'meta' });
  parts.forEach((part, i) => {
    if (i) meta.append(' · ');
    meta.append(part.nodeType ? part : document.createTextNode(part));
  });

  const body = el('div', { className: 'body' },
    el('div', { className: 'name', textContent: row.task.name }),
    meta
  );

  if (row.task.instructions?.trim()) {
    body.append(el('details', { className: 'how' },
      el('summary', { textContent: 'How to do it' }),
      el('div', { className: 'text', textContent: row.task.instructions })
    ));
  }

  return el('div', { className: row.done ? 'card task done' : 'card task' }, check, body);
}

function renderWeekend() {
  const now = new Date();
  const { window, rows } = weekendRows(now);
  const me = local.me || state.people[0].id;
  const them = otherPerson(state, me);

  $('#window-label').textContent =
    `Weekend of ${fmtDate(window.start)} – ${fmtDate(window.end)}`;

  for (const [container, personId, label, mine] of [
    [$('#mine'), me, 'Your tasks', true],
    [$('#theirs'), them, `${personName(state, them)}'s tasks`, false],
  ]) {
    container.replaceChildren();
    container.className = mine ? '' : 'theirs';
    const list = rows[personId] || [];
    const remaining = list.filter((r) => !r.done).length;

    container.append(el('h2', { className: 'group' },
      el('span', { textContent: label }),
      el('span', {
        className: 'count',
        textContent: remaining ? `${remaining} to go` : 'all clear',
      })
    ));

    if (!list.length) {
      container.append(el('p', { className: 'empty', textContent: 'Nothing due this weekend.' }));
      continue;
    }
    for (const row of list.sort((a, b) => a.done - b.done)) {
      container.append(taskCard(row, true));
    }
  }
}

/* ---------- all tasks ---------- */

/** Hand the task (or its whole linked group) to the other person. */
function swapOwner(task) {
  mutate((s) => {
    const t = s.tasks.find((x) => x.id === task.id);
    if (t.group) {
      const g = s.groups[t.group];
      g.nextOwner = otherPerson(s, g.nextOwner ?? s.people[0].id);
    } else {
      t.nextOwner = otherPerson(s, t.nextOwner ?? s.people[0].id);
    }
  }, `Swap who's up: ${task.group ? state.groups?.[task.group]?.name ?? task.name : task.name}`);
}

function personPill(personId, task = null) {
  if (!personId) return el('span', { className: 'pill both', textContent: 'Each of us' });
  const idx = state.people.findIndex((p) => p.id === personId);
  const cls = `pill person-${idx === 1 ? 'b' : 'a'}`;
  if (!task) return el('span', { className: cls, textContent: personName(state, personId) });

  const pill = el('button', {
    type: 'button',
    className: `${cls} swap`,
    disabled: busy,
    ariaLabel: `${personName(state, personId)} is up. Tap to give it to ${personName(state, otherPerson(state, personId))}.`,
  }, personName(state, personId), el('span', { className: 'swap-icon', textContent: '⇄' }));
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    swapOwner(task);
  });
  return pill;
}

function dueLine(task) {
  const now = new Date();
  const mine = assignments(state).filter((a) => a.task.id === task.id);
  const soonest = mine
    .map((a) => a.dueAt)
    .sort((x, y) => (x?.getTime() ?? 0) - (y?.getTime() ?? 0))[0];
  const last = mine
    .map((a) => a.lastDone)
    .filter(Boolean)
    .sort((x, y) => y.at - x.at)[0];
  if (!last) return 'Not done yet';
  return `${relative(soonest, now)} · last done ${fmtDate(last.at)} by ${personName(state, last.by)}`;
}

function taskRow(task, { pill = true, step = null } = {}) {
  const row = el('div', { className: 'trow', tabIndex: 0, role: 'button' });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(task); }
  });
  if (step) row.append(el('span', { className: 'step', textContent: step }));
  row.append(
    el('span', { className: 'tmain' },
      el('span', { className: 'tname', textContent: task.name }),
      el('span', { className: 'meta', textContent: dueLine(task) })
    )
  );
  if (pill) row.append(task.mode === 'each' ? personPill(null) : personPill(upNext(state, task), task));
  row.addEventListener('click', () => openEditor(task));
  return row;
}

function renderDaily() {
  const host = $('#daily');
  host.replaceChildren();
  const items = state.daily || [];
  if (!items.length) return;

  host.append(
    el('div', { className: 'section-head' },
      el('h2', { textContent: 'Daily / after use' }),
      el('span', { className: 'hint', textContent: 'No reminders — just the house rules.' })
    ),
    el('ul', { className: 'card daily' },
      items.map((item) =>
        el('li', {},
          el('span', { className: 'dicon', textContent: item.icon || '•' }),
          el('span', { textContent: item.text ?? item })
        )
      )
    )
  );
}

function cadenceLabel(days) {
  if (days === 1) return 'Daily';
  if (days === 7) return 'Weekly';
  if (days % 7 === 0) return `Every ${days / 7} weeks`;
  if (days === 30 || days === 31) return 'Monthly';
  return `Every ${days} days`;
}

function groupCard(groupId, members) {
  const g = state.groups?.[groupId] ?? {};
  const same = members.filter((t) => !t.opposite);
  const opposite = members.filter((t) => t.opposite);
  const owner = ownerOf(state, same[0] ?? members[0]);

  const card = el('div', { className: 'card group' },
    el('div', { className: 'group-head' },
      el('span', { className: 'group-name', textContent: g.name || 'Linked tasks' }),
      g.note ? el('p', { className: 'hint', textContent: g.note }) : null
    )
  );
  const lane = (label, personId, tasks, numbered) => card.append(
    el('div', { className: 'lane-head' },
      el('span', { className: 'lane-label', textContent: label }),
      personPill(personId, tasks[0])
    ),
    ...tasks.map((t, i) => taskRow(t, { pill: false, step: numbered ? String(i + 1) : null }))
  );
  lane('Upstairs', owner, same, same.length > 1);
  if (opposite.length) lane('Downstairs', otherPerson(state, owner), opposite, false);
  return card;
}

function renderAllTasks() {
  renderDaily();
  const host = $('#all-tasks');
  host.replaceChildren();

  // One section per cadence, most frequent first. Each linked group lands in
  // the section of its most frequent member, as a single card.
  const active = state.tasks.filter((t) => t.active !== false);
  const cadenceOf = (t) => t.group
    ? Math.min(...active.filter((m) => m.group === t.group).map((m) => m.frequencyDays))
    : t.frequencyDays;
  const cadences = [...new Set(active.map(cadenceOf))].sort((a, b) => a - b);

  cadences.forEach((days, i) => {
    host.append(
      el('div', { className: 'section-head' },
        el('h2', { textContent: cadenceLabel(days) }),
        i === 0
          ? el('span', { className: 'hint', textContent: 'Tap a task to edit it. Tap a name to swap who’s up.' })
          : null
      )
    );

    const here = active.filter((t) => cadenceOf(t) === days);
    const drawn = new Set();
    for (const t of here) {
      if (!t.group || drawn.has(t.group)) continue;
      drawn.add(t.group);
      host.append(groupCard(t.group, here.filter((m) => m.group === t.group)));
    }
    const loose = here.filter((t) => !t.group);
    if (loose.length) host.append(el('div', { className: 'card list' }, loose.map((t) => taskRow(t))));
  });
}

/* ---------- history ---------- */

function renderHistory() {
  const host = $('#history');
  host.replaceChildren();
  const entries = [...state.log].sort((a, b) => new Date(b.at) - new Date(a.at));

  if (!entries.length) {
    host.append(el('p', { className: 'empty', textContent: 'Nothing logged yet.' }));
    return;
  }

  let lastDay = null;
  for (const e of entries.slice(0, 300)) {
    const at = new Date(e.at);
    const day = at.toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
    if (day !== lastDay) {
      host.append(el('div', { className: 'log-day', textContent: day }));
      lastDay = day;
    }
    const task = state.tasks.find((t) => t.id === e.taskId);
    host.append(el('div', { className: 'log-row' },
      el('span', { textContent: task ? task.name : e.taskId }),
      el('span', { className: 'by', textContent: personName(state, e.by) })
    ));
  }
}

/* ---------- task editor ---------- */

let editing = null;

function openEditor(task) {
  editing = task;
  $('#editor-title').textContent = task.name;
  $('#e-name').value = task.name;
  $('#e-freq').value = task.frequencyDays;
  $('#e-mode').value = task.mode || 'alternate';
  $('#e-instructions').value = task.instructions || '';

  const owner = $('#e-owner');
  owner.replaceChildren(
    ...state.people.map((p) => el('option', { value: p.id, textContent: p.name }))
  );
  owner.value = task.mode === 'each' ? state.people[0].id : ownerOf(state, task);
  // A linked task has to alternate with its group; its mode is not a free choice.
  $('#e-mode').disabled = Boolean(task.group);
  $('#e-group-note').hidden = !task.group;
  $('#e-group-note').textContent = task.group
    ? `Linked with the rest of "${state.groups?.[task.group]?.name ?? task.group}" — changing who's up moves the whole group.`
    : '';
  syncOwnerVisibility();
  $('#editor').showModal();
}

function syncOwnerVisibility() {
  $('#e-owner-wrap').hidden = $('#e-mode').value === 'each';
}

/* ---------- push notifications ---------- */

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function urlB64ToUint8(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function enablePush() {
  try {
    if (!local.token) { banner('Save your GitHub token first.'); return; }
    if (!state) { banner('Your data has not loaded yet — check the token above.'); return; }
    if (!local.me) { banner('Pick who you are first.'); return; }

    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { banner('Notifications were not allowed.'); return; }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8(CFG.vapidPublicKey),
    });

    for (let attempt = 0; attempt < 4; attempt++) {
      const fresh = await loadFile(CFG.subsPath);
      fresh.data[local.me] = { ...sub.toJSON(), updatedAt: new Date().toISOString() };
      try {
        await putFile(CFG.subsPath, fresh.data, fresh.sha,
          `Register reminders for ${personName(state, local.me)}`);
        break;
      } catch (e) {
        if (!e.conflict || attempt === 3) throw e;
      }
    }
    banner('Reminders on. You will get a push Friday afternoon.', true);
  } catch (e) {
    banner(`Could not turn on reminders: ${e.message}`);
  }
  renderSettings();
}

function renderPushState() {
  const host = $('#push-state');
  host.replaceChildren();

  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent);

  if (iOS && !isStandalone()) {
    host.append(el('p', { className: 'hint' },
      'iPhones only allow reminders once this is on your Home Screen. ' +
      'Tap the Share button in Safari, choose "Add to Home Screen", ' +
      'then open CleanIt from the icon and come back here.'
    ));
    return;
  }

  if (!pushSupported()) {
    host.append(el('p', { className: 'hint', textContent: 'This browser cannot receive push reminders.' }));
    return;
  }

  const granted = Notification.permission === 'granted';
  host.append(el('p', {
    className: 'hint',
    textContent: granted
      ? 'Notifications are allowed on this device.'
      : 'Not set up on this device yet.',
  }));

  const btn = el('button', {
    type: 'button',
    className: 'primary',
    textContent: granted ? 'Re-register this device' : 'Turn on reminders',
  });
  btn.addEventListener('click', enablePush);
  host.append(btn);
}

/* ---------- settings ---------- */

function renderSettings() {
  const people = state?.people ?? PLACEHOLDER_PEOPLE;
  const choices = $('#identity-choices');
  choices.replaceChildren();
  for (const p of people) {
    const b = el('button', {
      type: 'button',
      textContent: p.name,
      className: local.me === p.id ? 'active' : '',
    });
    b.addEventListener('click', () => { local.me = p.id; render(); });
    choices.append(b);
  }

  $('#name-a').value = people[0].name;
  $('#name-b').value = people[1].name;
  $('#tz').value = state?.timezone || 'America/New_York';
  $('#save-settings').disabled = !state;
  $('#repo-label').textContent = CFG.repo;
  $('#token').value = local.token;
  $('#token-state').textContent = local.token
    ? 'A token is saved on this device.'
    : 'No token saved — the app is read-only until you add one.';

  renderPushState();
}

/* ---------- render / routing ---------- */

// Fallback identities for the very first launch, before any data has loaded.
const PLACEHOLDER_PEOPLE = [{ id: 'a', name: 'Person A' }, { id: 'b', name: 'Person B' }];

function render() {
  $('#whoami').textContent =
    state && local.me ? personName(state, local.me) : 'Who are you?';
  const view = document.body.dataset.view || 'weekend';
  // Settings must work with no state at all — it is where the token goes.
  if (view === 'settings') { renderSettings(); return; }
  if (!state) return;
  if (view === 'weekend') renderWeekend();
  if (view === 'tasks') renderAllTasks();
  if (view === 'history') renderHistory();
}

function show(view) {
  document.body.dataset.view = view;
  for (const section of document.querySelectorAll('.view')) {
    section.hidden = section.id !== `view-${view}`;
  }
  for (const tab of document.querySelectorAll('.tabs button')) {
    tab.classList.toggle('active', tab.dataset.view === view);
  }
  render();
}

/* ---------- wiring ---------- */

document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => show(b.dataset.view))
);

$('#whoami').addEventListener('click', () => show('settings'));
$('#e-mode').addEventListener('change', syncOwnerVisibility);

$('#editor').addEventListener('close', () => {
  if ($('#editor').returnValue !== 'save' || !editing) return;
  const id = editing.id;
  const patch = {
    name: $('#e-name').value.trim() || editing.name,
    frequencyDays: Math.max(1, parseInt($('#e-freq').value, 10) || editing.frequencyDays),
    mode: $('#e-mode').value,
    nextOwner: $('#e-owner').value,
    instructions: $('#e-instructions').value,
  };
  mutate((s) => {
    const t = s.tasks.find((x) => x.id === id);
    if (t.group) {
      // Picking the owner of one member picks it for the whole group.
      const { nextOwner, mode, ...rest } = patch;
      Object.assign(t, rest);
      s.groups[t.group].nextOwner = t.opposite ? otherPerson(s, nextOwner) : nextOwner;
      return;
    }
    Object.assign(t, patch);
    if (t.mode === 'each') delete t.nextOwner;
  }, `Update task: ${patch.name}`);
  editing = null;
});

$('#save-settings').addEventListener('click', () => {
  const names = [$('#name-a').value.trim(), $('#name-b').value.trim()];
  const tz = $('#tz').value.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    banner(`"${tz}" is not a valid time zone.`);
    return;
  }
  mutate((s) => {
    s.people[0].name = names[0] || s.people[0].name;
    s.people[1].name = names[1] || s.people[1].name;
    s.timezone = tz;
  }, 'Update settings');
});

$('#save-token').addEventListener('click', async () => {
  local.token = $('#token').value.trim();
  await refresh();
  show('settings');
});

$('#clear-token').addEventListener('click', () => {
  local.token = '';
  $('#token').value = '';
  renderSettings();
});

/* ---------- boot ---------- */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state) refresh();
});

show(local.token ? 'weekend' : 'settings');
refresh();
