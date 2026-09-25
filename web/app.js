'use strict';

const H = 3600e3, D = 24 * H;
const STORE_KEY = 'aniimo-checklist-v1';
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const SOURCES = [
  ['Game8', 'https://game8.co/games/Aniimo'],
  ['AniimoGuide', 'https://aniimoguide.com/events'],
  ['AniimoTools', 'https://aniimotools.dev/guides/event-calendar/'],
  ['Официальный сайт', 'https://www.aniimo.com/newslist'],
];

const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  chevron: '<svg class="event-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
};
const CLOUD = '<path d="M6.5 15h10a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 7.2 7.6 3.8 3.8 0 0 0 6.5 15Z"/>';
const WX_ICON = {
  rain: `<svg viewBox="0 0 24 24">${CLOUD}<path d="M8.5 18l-1 2.5M12.5 18l-1 2.5M16.5 18l-1 2.5"/></svg>`,
  storm: `<svg viewBox="0 0 24 24">${CLOUD}<path d="M12.5 15.5l-2 3.5h3l-2 3.5"/></svg>`,
  snow: '<svg viewBox="0 0 24 24"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 6l2.5-1.5M9.5 19.5 12 18l2.5 1.5"/></svg>',
  prismana: '<svg viewBox="0 0 24 24"><path d="M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8Z"/><path d="M18 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z"/></svg>',
};
const LEADS = [0, 5, 10, 15];
const EVENT_THRESHOLDS = [24, 6, 3, 1];

const host = window.chrome && window.chrome.webview;
const send = (msg) => host && host.postMessage(msg);
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let data = null;
let state = null;
let hostSettings = null;
let updateInfo = null;
let sheetMode = null;
let changelog = [];
let evFilter = 'active';
let statusSignature = '';
const expanded = new Set();

// ---------- Состояние ----------

function loadState() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { }
  return {
    server: s.server || 'eu',
    tab: s.tab || 'daily',
    daily: s.daily || { key: '', done: {} },
    weekly: s.weekly || { key: '', done: {} },
    ev: s.ev || {},
    hidden: s.hidden || [],
    custom: s.custom || [],
    weather: s.weather || [],
    wxLast: s.wxLast || { region: '', kind: 'rain', lead: 10 },
    remind: s.remind || { events: [24, 3] },
    fired: s.fired || {},
    seenVersion: s.seenVersion || '',
    names: s.names || 'en',
  };
}

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { }
}

// ---------- Время сервера ----------
// Все даты в data.json — даты сервера; день начинается в resetHour по времени сервера.

const server = () => data.servers.find((s) => s.id === state.server) || data.servers[0];
const offsetMs = () => server().offset * H;
const resetMs = () => data.resetHour * H;

function dayKey(t = Date.now()) {
  return new Date(t + offsetMs() - resetMs()).toISOString().slice(0, 10);
}
function dayStart(key) {
  return Date.parse(key + 'T00:00:00Z') + resetMs() - offsetMs();
}
function addDays(key, n) {
  return new Date(Date.parse(key + 'T00:00:00Z') + n * D).toISOString().slice(0, 10);
}
function weekKey(t = Date.now()) {
  const k = dayKey(t);
  const dow = (new Date(k + 'T00:00:00Z').getUTCDay() + 6) % 7;
  return addDays(k, -dow);
}
const nextDailyReset = () => dayStart(dayKey()) + D;
const nextWeeklyReset = () => dayStart(weekKey()) + 7 * D;

function fmtDate(key) {
  const [, m, d] = key.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}
function fmtRange(w) {
  if (!w.end) return `с ${fmtDate(w.start)}`;
  if (w.start === w.end) return fmtDate(w.start);
  const [, m1, d1] = w.start.split('-').map(Number);
  const [, m2] = w.end.split('-').map(Number);
  return m1 === m2 ? `${d1}–${fmtDate(w.end)}` : `${fmtDate(w.start)} – ${fmtDate(w.end)}`;
}
function fmtLeft(ms, clock = false) {
  if (ms <= 0) return '0м';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  if (clock && d === 0) return `${p(h)}:${p(m)}:${p(sec)}`;
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${p(m)}м`;
  return `${m}м ${p(sec)}с`;
}
function localTime(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- Ивенты ----------

function windowsOf(ev) {
  if (ev.weekly) {
    const out = [];
    for (let i = 0; i < 52; i++) {
      const start = addDays(ev.weekly.from, i * 7);
      out.push({ start, end: addDays(start, ev.weekly.days - 1) });
    }
    return out;
  }
  return ev.windows || [];
}
function boundsOf(w) {
  return { s: dayStart(w.start), e: w.end ? dayStart(w.end) + D : Infinity };
}
function eventStatus(ev, now = Date.now()) {
  const ws = windowsOf(ev).map((w) => ({ w, ...boundsOf(w) }));
  const cur = ws.find((x) => now >= x.s && now < x.e);
  if (cur) return { state: 'active', ...cur };
  const next = ws.filter((x) => x.s > now).sort((a, b) => a.s - b.s)[0];
  if (next) return { state: 'upcoming', ...next };
  const last = ws.sort((a, b) => b.e - a.e)[0];
  return { state: 'ended', ...(last || { w: {}, s: 0, e: 0 }) };
}
const eventById = (id) => data.events.find((e) => e.id === id);

// ---------- Названия: английские (как в данных) или официальные русские ----------
// Тексты в data.json написаны с английскими названиями; в режиме «ru» они заменяются
// по словарю data.i18n.ru. Чего нет в словаре — остаётся по-английски.

let glossary = { map: {}, re: null };

function buildGlossary() {
  const map = data.i18n?.ru || {};
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  glossary = {
    map,
    re: keys.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${keys.map(escRe).join('|')})(?![\\p{L}\\p{N}])`, 'gu') : null,
  };
}

function N(s) {
  if (!s || state.names !== 'ru' || !glossary.re) return s ?? '';
  return String(s).replace(glossary.re, (m) => glossary.map[m]);
}

// Этапы (главы) внутри одного непрерывного ивента: открытые остаются доступны.
function currentStage(ev, now = Date.now()) {
  if (!ev.stages) return -1;
  let idx = -1;
  ev.stages.forEach((sg, i) => { if (now >= dayStart(sg.start)) idx = i; });
  return idx;
}
function eventNote(ev, st, now = Date.now()) {
  const i = currentStage(ev, now);
  if (i >= 0 && st.state === 'active') return `Глава ${i + 1}: ${N(ev.stages[i].name)}`;
  return N(st.w.note || '');
}
const evDoneKey = (ev, st) => `${ev.id}@${st.w.start}`;

// ---------- Задачи ----------

function isDone(task, val) {
  return task.max ? (val || 0) >= task.max : !!val;
}
function taskVisible(task) {
  if (state.hidden.includes(task.id)) return false;
  if (!task.event) return true;
  const ev = eventById(task.event);
  return !!ev && eventStatus(ev).state === 'active';
}
function visibleTasks(scope) {
  const groups = data[scope].map((g) => ({ ...g, tasks: g.tasks.filter(taskVisible) })).filter((g) => g.tasks.length);
  const custom = state.custom.filter((c) => c.scope === scope).map((c) => ({ ...c, custom: true }));
  if (custom.length) groups.push({ id: 'custom-' + scope, title: 'Мои задачи', tasks: custom });
  return groups;
}
function scopeProgress(scope) {
  const all = visibleTasks(scope).flatMap((g) => g.tasks);
  const done = all.filter((t) => isDone(t, state[scope].done[t.id])).length;
  return { done, total: all.length };
}

function rollover() {
  let changed = false;
  const dk = dayKey(), wk = weekKey();
  if (state.daily.key !== dk) { state.daily = { key: dk, done: {} }; changed = true; }
  if (state.weekly.key !== wk) { state.weekly = { key: wk, done: {} }; changed = true; }
  if (changed) saveState();
  return changed;
}

function findTask(id) {
  for (const scope of ['daily', 'weekly']) {
    for (const g of data[scope]) {
      const t = g.tasks.find((x) => x.id === id);
      if (t) return t;
    }
  }
  return state.custom.find((c) => c.id === id);
}

// ---------- Рендер ----------

function render() {
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));

  for (const scope of ['daily', 'weekly']) {
    const { done, total } = scopeProgress(scope);
    const el = $('#count-' + scope);
    el.textContent = `${done}/${total}`;
    el.classList.toggle('complete', total > 0 && done === total);
  }
  $('#count-events').textContent = data.events.filter((e) => eventStatus(e).state === 'active').length;
  $('#count-weather').textContent = state.weather.length || '';
  $('#count-weather').hidden = !state.weather.length;

  const content = $('#content');
  const scroll = content.scrollTop;
  content.innerHTML = state.tab === 'events' ? renderEvents()
    : state.tab === 'weather' ? renderWeather()
    : renderTasks(state.tab);
  content.scrollTop = scroll;
  if (state.tab === 'weather') updateWxPreview();
  syncReminders();
  tick();
}

function renderTasks(scope) {
  const bucket = state[scope];
  const groups = visibleTasks(scope);
  const { done, total } = scopeProgress(scope);
  let html = '';

  if (total > 0 && done === total) {
    html += `<div class="all-done"><img src="img/buddy.webp" alt="">${scope === 'daily' ? 'Все дейли закрыты — до завтра!' : 'Неделя закрыта полностью!'}</div>`;
  }

  for (const g of groups) {
    const gDone = g.tasks.filter((t) => isDone(t, bucket.done[t.id])).length;
    html += `<section class="group">
      <header class="group-head">
        <div><h2>${esc(N(g.title))}</h2>${g.subtitle ? `<p>${esc(N(g.subtitle))}</p>` : ''}</div>
        <span class="group-count ${gDone === g.tasks.length ? 'complete' : ''}">${gDone}/${g.tasks.length}</span>
      </header>
      ${g.meter ? renderMeter(g, bucket) : ''}
      <ul class="tasks">${g.tasks.map((t) => renderTask(t, bucket.done[t.id], scope)).join('')}</ul>
    </section>`;
  }

  html += `<form class="add-task" data-scope="${scope}">
    <input type="text" maxlength="80" placeholder="+ Своя ${scope === 'daily' ? 'ежедневная' : 'еженедельная'} задача, Enter — добавить">
  </form>`;
  return html;
}

function renderMeter(g, bucket) {
  const pts = g.tasks.reduce((sum, t) => sum + (t.pts && isDone(t, bucket.done[t.id]) ? t.pts : 0), 0);
  const { target, max, reward } = g.meter;
  const ready = pts >= target;
  return `<div class="meter ${ready ? 'ready' : ''}">
    <img class="meter-eggs" src="img/eggs.webp" alt="">
    <div class="meter-top">
      <span class="meter-val"><b>${pts}</b> / ${target} очков</span>
      <span class="meter-reward">${ready ? 'Награды доступны — забирай!' : esc(N(reward))}</span>
    </div>
    <div class="meter-bar"><i style="width:${Math.min(100, pts / max * 100)}%"></i><span class="meter-mark" style="left:${target / max * 100}%"></span></div>
  </div>`;
}

function renderTask(t, val, scope) {
  const done = isDone(t, val);
  const partial = !done && t.max && val > 0;
  let now = '';
  if (t.event) {
    const ev = eventById(t.event);
    const st = eventStatus(ev);
    const note = eventNote(ev, st);
    now = `<div class="task-now">${note ? `<span>${esc(note)}</span>` : ''}<span data-until="${st.e}" data-tpl="ещё {t}"></span></div>`;
  }
  const counter = t.max ? `<div class="counter">
      <button data-act="dec" aria-label="Меньше">−</button>
      <span>${(val || 0)}/${t.max}</span>
      <button data-act="inc" aria-label="Больше">+</button>
    </div>` : '';
  const pts = t.pts ? `<span class="pts">+${t.pts}</span>` : '';
  const x = t.custom
    ? `<button class="task-x" data-act="delete" title="Удалить">${ICON.x}</button>`
    : `<button class="task-x" data-act="hide" title="Скрыть задачу (вернуть можно в настройках)">${ICON.x}</button>`;

  return `<li class="task ${done ? 'done' : ''} ${partial ? 'partial' : ''}" data-id="${esc(t.id)}" data-scope="${scope}">
    <button class="check" data-act="toggle" aria-pressed="${done}" aria-label="Отметить">${ICON.check}</button>
    <div class="task-body" data-act="toggle">
      <div class="task-title">${esc(N(t.title))}</div>
      ${t.hint ? `<div class="task-hint">${esc(N(t.hint))}</div>` : ''}
      ${now}
    </div>
    ${counter}${pts}${x}
  </li>`;
}

function renderEvents() {
  const now = Date.now();
  const items = data.events.map((ev) => ({ ev, st: eventStatus(ev, now) }));
  const counts = { active: 0, upcoming: 0, all: items.length };
  items.forEach((x) => { if (counts[x.st.state] !== undefined) counts[x.st.state]++; });

  const shown = items
    .filter((x) => evFilter === 'all' || x.st.state === evFilter)
    .sort((a, b) => {
      const order = { active: 0, upcoming: 1, ended: 2 };
      if (a.st.state !== b.st.state) return order[a.st.state] - order[b.st.state];
      if (a.st.state === 'active') return a.st.e - b.st.e;
      if (a.st.state === 'upcoming') return a.st.s - b.st.s;
      return b.st.e - a.st.e;
    });

  const chip = (id, label) =>
    `<button class="chip" data-act="filter" data-filter="${id}" aria-pressed="${evFilter === id}">${label} <b>${counts[id]}</b></button>`;

  let html = `<div class="filters">${chip('active', 'Идут')}${chip('upcoming', 'Скоро')}${chip('all', 'Все')}</div>`;
  html += shown.length
    ? `<div class="events">${shown.map((x) => renderEvent(x.ev, x.st, now)).join('')}</div>`
    : `<div class="empty">Здесь пока пусто</div>`;
  html += `<p class="data-note">Время — сервер «${esc(server().name)}». Данные от ${fmtDate(data.updated)} ${data.updated.slice(0, 4)}.</p>`;
  return html;
}

function renderEvent(ev, st, now) {
  const cat = data.categories[ev.category] || { name: '', color: '#1e8bf0' };
  const done = !!state.ev[evDoneKey(ev, st)];
  const open = expanded.has(ev.id);
  const permanent = st.e === Infinity;

  let badge, tpl, pct = 0;
  if (st.state === 'active') {
    const soon = !permanent && st.e - now < D;
    badge = permanent ? '<span class="badge active">Бессрочно</span>'
      : soon ? '<span class="badge soon-end">Скоро конец</span>' : '<span class="badge active">Идёт</span>';
    tpl = permanent ? `с ${fmtDate(st.w.start)}` : `ещё {t} · до ${fmtDate(st.w.end)}`;
    pct = permanent ? 100 : (now - st.s) / (st.e - st.s) * 100;
  } else if (st.state === 'upcoming') {
    badge = '<span class="badge upcoming">Скоро</span>';
    tpl = `через {t} · ${fmtRange(st.w)}`;
  } else {
    badge = '<span class="badge">Завершён</span>';
    tpl = `закончился ${fmtDate(st.w.end || st.w.start)}`;
    pct = 100;
  }
  const until = st.state === 'active' ? st.e : st.state === 'upcoming' ? st.s : '';
  const canCheck = st.state === 'active';
  const note = eventNote(ev, st, now);
  const stageIdx = currentStage(ev, now);

  let details = '';
  if (open) {
    const allWins = ev.weekly ? [] : windowsOf(ev);
    details = `<div class="event-details">
      <p>${esc(N(ev.desc))}</p>
      ${ev.todo?.length ? `<h4>Что делать</h4><ul>${ev.todo.map((t) => `<li>${esc(N(t))}</li>`).join('')}</ul>` : ''}
      ${ev.rewards ? `<h4>Награды</h4><div class="reward"><img src="img/cube.webp" alt=""><span>${esc(N(ev.rewards))}</span></div>` : ''}
      ${ev.stages ? `<h4>Этапы</h4><div class="stages">${ev.stages.map((sg, i) => {
        const s = dayStart(sg.start);
        const cur = i === stageIdx;
        const opened = now >= s;
        const tag = cur ? '<span class="stage-tag">сейчас</span>'
          : opened ? '<span class="stage-tag">открыта</span>'
          : `<span class="stage-tag" data-until="${s}" data-tpl="через {t}"></span>`;
        return `<div class="stage ${cur ? 'now' : opened ? 'open' : ''}">
          <span class="stage-num">${i + 1}</span>
          <div class="stage-body"><b>${esc(N(sg.name))}</b><small>с ${fmtDate(sg.start)}</small></div>${tag}
        </div>`;
      }).join('')}</div>` : ''}
      ${allWins.length > 1 ? `<h4>Расписание</h4><div class="windows">${allWins.map((w) => {
        const b = boundsOf(w);
        const cls = now >= b.e ? 'past' : now >= b.s ? 'now' : '';
        return `<span class="win ${cls}">${fmtRange(w)}${w.note ? `<small>${esc(N(w.note))}</small>` : ''}</span>`;
      }).join('')}</div>` : ''}
      ${ev.weekly ? `<h4>Расписание</h4><div class="windows"><span class="win now">каждую неделю: ${WEEKDAYS[new Date(ev.weekly.from + 'T00:00:00Z').getUTCDay()]} ${data.resetHour}:00 → ${ev.weekly.days} дн.</span></div>` : ''}
    </div>`;
  }

  return `<article class="event ${st.state} ${done ? 'done' : ''} ${open ? 'open' : ''}" style="--c:${cat.color}" data-ev="${esc(ev.id)}">
    <div class="event-head" data-act="expand">
      <div class="event-main">
        <div class="event-meta"><span class="cat">${esc(cat.name)}</span>${badge}</div>
        <h3 class="event-name">${esc(N(ev.name))}</h3>
        ${note && st.state !== 'ended' ? `<div class="event-note">${st.state === 'upcoming' ? 'Далее: ' : ''}${esc(note)}</div>` : ''}
      </div>
      ${canCheck ? `<button class="check ${done ? 'on' : ''}" data-act="evdone" title="Отметить выполненным" aria-pressed="${done}">${ICON.check}</button>` : ''}
    </div>
    <div class="event-time" data-act="expand">
      <div class="event-bar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>
      <span class="event-left" ${until !== '' ? `data-until="${until}"` : ''} data-tpl="${esc(tpl)}">${esc(tpl.replace('{t}', ''))}</span>
      ${ICON.chevron}
    </div>
    ${details}
  </article>`;
}

// ---------- Погода ----------

const wxType = (id) => data.weather.types.find((t) => t.id === id) || data.weather.types[0];

function nextOccurrence(hhmm, now = Date.now()) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() < now - 60e3) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function dayWord(t) {
  const day = (x) => new Date(x).toDateString();
  if (day(t) === day(Date.now())) return 'сегодня';
  if (day(t) === day(Date.now() + D)) return 'завтра';
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function renderWeather() {
  const now = Date.now();
  const last = state.wxLast;
  const items = [...state.weather].sort((a, b) => a.start - b.start);

  return `<section class="group">
      <header class="group-head"><div><h2>Напомнить о погоде</h2><p>Прогноз в игре: карта → регион → вкладка с солнцем</p></div></header>
      <form class="wx-form" id="wx-form" autocomplete="off">
        <label class="wx-field"><span>Регион</span>
          <input type="text" name="region" list="wx-regions" maxlength="40" placeholder="Например, Nimbus Fields" value="${esc(last.region)}" required>
        </label>
        <datalist id="wx-regions">${data.weather.regions.map((r) => `<option value="${esc(N(r))}">`).join('')}</datalist>
        <div class="wx-field"><span>Погода</span>
          <div class="seg wx-kinds">${data.weather.types.map((t) =>
            `<button type="button" data-act="wx-kind" data-kind="${t.id}" aria-pressed="${t.id === last.kind}" style="--c:${t.color}">${WX_ICON[t.id] || ''}${esc(t.name)}</button>`).join('')}
          </div>
        </div>
        <div class="wx-row">
          <label class="wx-field"><span>Начало</span><input type="time" name="time" required></label>
          <div class="wx-field"><span>Напомнить</span>
            <div class="seg">${LEADS.map((l) =>
              `<button type="button" data-act="wx-lead" data-lead="${l}" aria-pressed="${l === last.lead}">${l ? `за ${l} мин` : 'в начале'}</button>`).join('')}
            </div>
          </div>
        </div>
        <div class="wx-submit"><span class="wx-preview" id="wx-preview"></span><button class="btn primary" type="submit">Добавить</button></div>
      </form>
    </section>
    <section class="group">
      <header class="group-head"><div><h2>Запланировано</h2></div><span class="group-count">${items.length || ''}</span></header>
      ${items.length
        ? `<ul class="tasks">${items.map((w) => renderWx(w, now)).join('')}</ul>`
        : '<div class="empty" style="padding:18px 12px"><img src="img/buddy.webp" alt="">Пока пусто. Глянь прогноз в игре и добавь нужную погоду.</div>'}
    </section>
    <p class="data-note">Напоминание всплывёт в правом нижнем углу поверх игры, не забирая фокус.</p>`;
}

function renderWx(w, now) {
  const t = wxType(w.kind);
  const live = now >= w.start;
  return `<li class="task wx-item ${live ? 'live' : ''}" style="--c:${t.color}">
    <span class="wx-icon">${WX_ICON[w.kind] || ''}</span>
    <div class="task-body">
      <div class="task-title">${esc(t.name)} · ${esc(N(w.region))}</div>
      <div class="task-hint">${dayWord(w.start)} в ${localTime(w.start)} · ${w.lead ? `напомню за ${w.lead} мин` : 'напомню в начале'}</div>
    </div>
    ${live ? '<span class="wx-when">идёт</span>' : `<span class="wx-when" data-until="${w.start}" data-tpl="через {t}"></span>`}
    <button class="task-x" data-act="wx-del" data-id="${esc(w.id)}" title="Удалить">${ICON.x}</button>
  </li>`;
}

function updateWxPreview() {
  const form = $('#wx-form');
  if (!form) return;
  const el = $('#wx-preview');
  if (!form.time.value) {
    el.textContent = 'Укажи время начала';
    return;
  }
  const start = nextOccurrence(form.time.value);
  const at = start - state.wxLast.lead * 60e3;
  el.textContent = at <= Date.now()
    ? `Начнётся ${dayWord(start)} в ${localTime(start)} — напомню сразу`
    : `Напомню ${dayWord(at)} в ${localTime(at)}`;
}

function pruneWeather() {
  const now = Date.now();
  const before = state.weather.length;
  state.weather = state.weather.filter((w) => now < w.start + 2 * H);
  return state.weather.length !== before;
}

// ---------- Напоминания ----------
// Считаем здесь, а срабатывают они в приложении: таймеры скрытой страницы браузер притормаживает.

let lastReminderPayload = '';

function syncReminders() {
  if (!host) return;
  const now = Date.now();
  const items = [];

  for (const w of state.weather) {
    const t = wxType(w.kind);
    items.push({
      id: 'wx:' + w.id, at: w.start - w.lead * 60e3, until: w.start + 15 * 60e3, end: w.start, color: t.color,
      title: `${t.name} — ${N(w.region)}`,
      text: w.lead ? `Начнётся через {left}, в ${localTime(w.start)}` : `Начинается сейчас, в ${localTime(w.start)}`,
    });
  }

  const hours = [...state.remind.events].sort((a, b) => b - a);
  for (const ev of data.events) {
    const st = eventStatus(ev, now);
    if (st.state !== 'active' || st.e === Infinity || state.ev[evDoneKey(ev, st)]) continue;
    const left = st.e - now;
    // Будущие пороги — все; из уже наступивших — только самый близкий, чтобы не прислать пачку сразу.
    const pick = hours.filter((h) => h * H < left);
    const passed = hours.filter((h) => h * H >= left);
    if (passed.length) pick.push(Math.min(...passed));
    const color = (data.categories[ev.category] || {}).color || '#1e8bf0';
    for (const h of pick) {
      items.push({
        id: `ev:${ev.id}@${st.w.start}:${h}`, at: st.e - h * H, until: st.e, end: st.e, color,
        title: `Заканчивается: ${N(ev.name)}`,
        text: `Осталось {left} — до ${fmtDate(st.w.end)}, ${localTime(st.e)}`,
      });
    }
  }

  const pending = items.filter((i) => !state.fired[i.id]);
  const payload = JSON.stringify(pending);
  if (payload !== lastReminderPayload) {
    lastReminderPayload = payload;
    send({ type: 'reminders', items: pending });
  }
}

function renderSettings() {
  const sheet = $('#sheet');
  const hs = hostSettings;
  const reset = dayStart(dayKey());
  const weekDay = WEEKDAYS[new Date(nextWeeklyReset()).getDay()];

  const hiddenTasks = state.hidden.map(findTask).filter(Boolean);

  sheet.innerHTML = `
    <div class="sheet-head">
      <h2>Настройки</h2>
      <button class="icon-btn" data-act="close-settings" aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>

    <div class="field">
      <span class="field-label">Сервер</span>
      <div class="seg">${data.servers.map((s) =>
        `<button data-act="server" data-server="${s.id}" aria-pressed="${s.id === state.server}">${esc(s.name)} <span style="opacity:.6">UTC${s.offset >= 0 ? '+' : '−'}${Math.abs(s.offset)}</span></button>`).join('')}
      </div>
      <p class="field-hint">Сброс в ${String(data.resetHour).padStart(2, '0')}:00 по серверу — у тебя это ${localTime(reset)}. Викли — ${weekDay} ${localTime(nextWeeklyReset())}.</p>
    </div>

    <div class="field">
      <span class="field-label">Названия ивентов, анимо и мест</span>
      <div class="seg">
        <button data-act="names" data-names="en" aria-pressed="${state.names !== 'ru'}">English</button>
        <button data-act="names" data-names="ru" aria-pressed="${state.names === 'ru'}">Русские</button>
      </div>
      <p class="field-hint">${state.names === 'ru'
        ? 'Как в русском клиенте: Изобилие энергии жил, Ирисалис, Танцомон. Где официального перевода пока нет — остаётся английское.'
        : 'Как в английском клиенте: Vein Abundance, Irisalis, Dazmand.'} Описания в обоих вариантах на русском.</p>
    </div>

    ${hs ? `
    <div class="field">
      <span class="field-label">Горячая клавиша</span>
      <div class="seg">${hs.hotkeys.map((k) =>
        `<button data-act="hotkey" data-hotkey="${esc(k.spec)}" aria-pressed="${k.spec === hs.hotkey}">${esc(k.label)}</button>`).join('')}
      </div>
      ${hs.hotkeyOk
        ? `<p class="field-hint">Работает в любом окне. Игра должна быть в режиме «окно без рамки», поверх полноэкранного режима оверлеи не видны.</p>`
        : `<p class="field-hint warn">Клавиша занята другой программой — выбери другую.</p>`}
    </div>

    <div class="field field-row">
      <span class="field-label">Запускать вместе с Windows</span>
      <button class="switch" role="switch" data-act="autostart" aria-checked="${hs.autostart}" aria-label="Автозапуск"></button>
    </div>

    <div class="field">
      <span class="field-label">Непрозрачность окна · <span id="opacity-val">${Math.round(hs.opacity * 100)}%</span></span>
      <input type="range" min="50" max="100" step="5" value="${Math.round(hs.opacity * 100)}" data-act="opacity">
    </div>` : ''}

    <div class="field">
      <span class="field-label">Напоминать о конце ивентов</span>
      <div class="seg">${EVENT_THRESHOLDS.map((h) =>
        `<button data-act="ev-remind" data-h="${h}" aria-pressed="${state.remind.events.includes(h)}">за ${h} ч</button>`).join('')}
      </div>
      <p class="field-hint">Можно выбрать несколько или ни одного. Про ивенты, отмеченные выполненными, не напоминаю.</p>
      ${hs ? `
      <span class="field-label" style="margin-top:14px">Громкость колокольчика · <span id="volume-val">${volumeLabel(hs.volume * 100)}</span></span>
      <input type="range" min="0" max="100" step="5" value="${Math.round(hs.volume * 100)}" data-act="volume">
      <div class="btn-row" style="margin-top:10px"><button class="btn" data-act="test-notify">Показать пример напоминания</button></div>` : ''}
    </div>

    <div class="field">
      <span class="field-label">Скрытые задачи</span>
      ${hiddenTasks.length
        ? `<div class="hidden-list">${hiddenTasks.map((t) =>
            `<div class="hidden-item"><span>${esc(N(t.title))}</span><button class="link" data-act="unhide" data-id="${esc(t.id)}">Вернуть</button></div>`).join('')}</div>`
        : `<p class="field-hint" style="margin:0">Нет. Наведи на задачу и нажми ×, чтобы убрать ненужную.</p>`}
    </div>

    <div class="field">
      <span class="field-label">Прогресс</span>
      <div class="btn-row">
        <button class="btn" data-act="reset-daily">Снять отметки дейли</button>
        <button class="btn" data-act="reset-weekly">Снять отметки викли</button>
      </div>
      <p class="field-hint">Отметки и так сбрасываются сами по таймеру сервера.</p>
    </div>

    ${updateInfo ? `
    <div class="field">
      <span class="field-label">Обновления</span>
      <p class="field-hint ${updateInfo.state === 'error' ? 'warn' : ''}" style="margin-top:0">Версия ${esc(updateInfo.current)}. ${esc(updateStatusText(updateInfo))}</p>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn" data-act="check-update" ${updateInfo.state === 'checking' || updateInfo.state === 'downloading' ? 'disabled' : ''}>Проверить сейчас</button>
        ${updateInfo.latest ? `<button class="btn primary" data-act="do-update" ${updateInfo.state === 'downloading' ? 'disabled' : ''}>${updateInfo.state === 'downloading' ? 'Скачиваю…' : `Обновить до ${esc(updateInfo.latest)}`}</button>` : ''}
      </div>
      <p class="field-hint">Проверяю сам раз в 3 часа через GitHub — работает из любой сети.</p>
    </div>` : ''}

    <div class="field">
      <span class="field-label">Данные</span>
      <p class="sources">Задачи и ивенты — из фан-гайдов, актуально на ${fmtDate(data.updated)} ${data.updated.slice(0, 4)}
        (ревизия ${data.revision ?? 0}). Новые ивенты приходят с GitHub сами.<br>
        Источники: ${SOURCES.map(([n, u]) => `<a href="#" data-act="url" data-url="${u}">${n}</a>`).join(' · ')}</p>
      ${host ? `<div class="btn-row" style="margin-top:10px">
        <button class="btn" data-act="open-data">Открыть папку с данными</button>
        <button class="btn danger" data-act="quit">Выйти из приложения</button>
      </div>` : ''}
    </div>`;
}

function updateStatusText(u) {
  switch (u.state) {
    case 'checking': return 'Проверяю обновления…';
    case 'downloading': return `Скачиваю версию ${u.latest}…`;
    case 'available': return `Доступна версия ${u.latest}.`;
    case 'latest': return `Установлена последняя версия${u.checkedAt ? `, проверено в ${u.checkedAt}` : ''}.`;
    case 'error': return u.error || 'Не удалось проверить обновления.';
    default: return 'Первая проверка — через несколько секунд после запуска.';
  }
}

function renderUpdateBanner() {
  const el = $('#update-banner');
  const u = updateInfo;
  const show = u && u.latest && ['available', 'downloading', 'error'].includes(u.state);
  el.hidden = !show;
  if (!show) return;
  const downloading = u.state === 'downloading';
  const sub = u.state === 'error' ? u.error : (u.notes || '').split('\n')[0] || `Сейчас установлена ${u.current}`;
  el.innerHTML = `<img src="img/buddy.webp" alt="">
    <div class="update-text"><b>Доступна версия ${esc(u.latest)}</b><small>${esc(sub)}</small></div>
    <button class="btn primary" data-act="do-update" ${downloading ? 'disabled' : ''}>${downloading ? 'Скачиваю…' : 'Обновить'}</button>`;
}

function volumeLabel(percent) {
  return Number(percent) > 0 ? `${Math.round(percent)}%` : 'без звука';
}

// Шторка снизу: настройки или патчлог. null — закрыта.
function openSheet(mode) {
  sheetMode = mode;
  $('#sheet').hidden = !mode;
  $('#sheet-backdrop').hidden = !mode;
  if (mode === 'settings') { send({ type: 'get-settings' }); renderSettings(); }
  if (mode === 'changelog') {
    renderChangelog();
    state.seenVersion = appVersion();
    saveState();
    renderVersionChip();
  }
}

const appVersion = () => updateInfo?.current || changelog[0]?.version || '';

function renderVersionChip() {
  const chip = $('#btn-changelog');
  const v = appVersion();
  chip.hidden = !v;
  chip.textContent = 'v' + v;
  chip.classList.toggle('new', !!v && state.seenVersion !== v);
}

function renderChangelog() {
  const current = appVersion();
  $('#sheet').innerHTML = `
    <div class="sheet-head">
      <h2>Что нового</h2>
      <button class="icon-btn" data-act="close-settings" aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="changelog">${changelog.map((r) => `
      <section class="release ${r.version === current ? 'current' : ''}">
        <div class="release-head"><b>v${esc(r.version)}</b><small>${fmtDate(r.date)} ${r.date.slice(0, 4)}${r.version === current ? ' · установлена' : ''}</small></div>
        <ul>${r.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
      </section>`).join('')}
    </div>`;
}

// ---------- Живые таймеры ----------

function tick() {
  const now = Date.now();
  const rolled = rollover();
  const pruned = pruneWeather();
  if (rolled || pruned) { saveState(); render(); return; }

  const sig = data.events.map((e) => { const st = eventStatus(e, now); return st.state + st.s; }).join();
  if (sig !== statusSignature) {
    const first = !statusSignature;
    statusSignature = sig;
    if (!first) { render(); return; }
  }

  $('#reset-daily').textContent = fmtLeft(nextDailyReset() - now, true);
  $('#reset-weekly').textContent = fmtLeft(nextWeeklyReset() - now);
  document.querySelectorAll('[data-until]').forEach((el) => {
    el.textContent = el.dataset.tpl.replace('{t}', fmtLeft(Number(el.dataset.until) - now));
  });
}

// ---------- События UI ----------

function onContentClick(e) {
  const actEl = e.target.closest('[data-act]');
  if (!actEl) return;
  const act = actEl.dataset.act;

  if (act === 'wx-kind' || act === 'wx-lead') {
    // Без перерисовки, чтобы не сбросить введённые регион и время.
    actEl.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === actEl)));
    if (act === 'wx-kind') state.wxLast.kind = actEl.dataset.kind;
    else state.wxLast.lead = Number(actEl.dataset.lead);
    saveState();
    updateWxPreview();
    return;
  }
  if (act === 'wx-del') {
    state.weather = state.weather.filter((w) => w.id !== actEl.dataset.id);
    saveState();
    render();
    return;
  }

  const taskEl = actEl.closest('.task');
  if (taskEl) {
    const { id, scope } = taskEl.dataset;
    const task = findTask(id);
    const done = state[scope].done;
    if (act === 'toggle') {
      done[id] = task.max ? (isDone(task, done[id]) ? 0 : task.max) : !done[id];
    } else if (act === 'inc' || act === 'dec') {
      const step = task.step || 1;
      done[id] = Math.max(0, Math.min(task.max, (done[id] || 0) + (act === 'inc' ? step : -step)));
    } else if (act === 'hide') {
      state.hidden.push(id);
    } else if (act === 'delete') {
      state.custom = state.custom.filter((c) => c.id !== id);
      delete done[id];
    }
    saveState();
    render();
    return;
  }

  const evEl = actEl.closest('.event');
  if (act === 'expand' && evEl) {
    const id = evEl.dataset.ev;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    render();
  } else if (act === 'evdone' && evEl) {
    e.stopPropagation();
    const ev = eventById(evEl.dataset.ev);
    const key = evDoneKey(ev, eventStatus(ev));
    state.ev[key] ? delete state.ev[key] : (state.ev[key] = true);
    saveState();
    render();
  } else if (act === 'filter') {
    evFilter = actEl.dataset.filter;
    render();
  }
}

function onSheetClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  switch (el.dataset.act) {
    case 'close-settings': openSheet(null); return;
    case 'server': state.server = el.dataset.server; rollover(); break;
    case 'names': state.names = el.dataset.names; break;
    case 'hotkey': send({ type: 'set-hotkey', value: el.dataset.hotkey }); return;
    case 'autostart': send({ type: 'set-autostart', value: el.getAttribute('aria-checked') !== 'true' }); return;
    case 'ev-remind': {
      const h = Number(el.dataset.h);
      const list = state.remind.events;
      state.remind.events = list.includes(h) ? list.filter((x) => x !== h) : [...list, h];
      break;
    }
    case 'test-notify': send({ type: 'test-notify' }); return;
    case 'unhide': state.hidden = state.hidden.filter((id) => id !== el.dataset.id); break;
    case 'reset-daily': state.daily.done = {}; break;
    case 'reset-weekly': state.weekly.done = {}; break;
    case 'open-data': send({ type: 'open-data' }); return;
    case 'quit': send({ type: 'quit' }); return;
    case 'check-update': send({ type: 'check-update' }); return;
    case 'do-update': send({ type: 'do-update' }); return;
    case 'url': e.preventDefault(); send({ type: 'open-url', url: el.dataset.url }); return;
    default: return;
  }
  saveState();
  render();
  renderSettings();
}

function bindUI() {
  $('#content').addEventListener('click', onContentClick);
  $('#content').addEventListener('input', (e) => {
    if (e.target.closest('#wx-form')) updateWxPreview();
  });
  $('#content').addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.id === 'wx-form') {
      const region = e.target.region.value.trim();
      const time = e.target.time.value;
      if (!region || !time) return;
      state.wxLast.region = region;
      state.weather.push({
        id: Date.now().toString(36), region, kind: state.wxLast.kind,
        start: nextOccurrence(time), lead: state.wxLast.lead,
      });
      saveState();
      render();
      return;
    }
    const form = e.target.closest('.add-task');
    const input = form.querySelector('input');
    const title = input.value.trim();
    if (!title) return;
    state.custom.push({ id: 'c_' + Date.now().toString(36), title, scope: form.dataset.scope });
    saveState();
    render();
    $('#content .add-task input').focus();
  });

  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    saveState();
    $('#content').scrollTop = 0;
    render();
  }));

  $('#btn-settings').addEventListener('click', () => openSheet(sheetMode === 'settings' ? null : 'settings'));
  $('#btn-changelog').addEventListener('click', () => openSheet(sheetMode === 'changelog' ? null : 'changelog'));
  $('#btn-hide').addEventListener('click', () => send({ type: 'hide' }));
  $('#sheet-backdrop').addEventListener('click', () => openSheet(null));
  $('#sheet').addEventListener('click', onSheetClick);
  $('#update-banner').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="do-update"]')) send({ type: 'do-update' });
  });
  $('#sheet').addEventListener('input', (e) => {
    const act = e.target.dataset.act;
    if (act === 'opacity') {
      $('#opacity-val').textContent = e.target.value + '%';
      send({ type: 'set-opacity', value: e.target.value / 100 });
    } else if (act === 'volume') {
      $('#volume-val').textContent = volumeLabel(e.target.value);
      send({ type: 'set-volume', value: e.target.value / 100 });
    }
  });
  // Отпустил ползунок громкости — прозвенеть, чтобы было слышно результат.
  $('#sheet').addEventListener('change', (e) => {
    if (e.target.dataset.act === 'volume') send({ type: 'preview-bell' });
  });

  // Перетаскивание окна за заголовок.
  $('#titlebar').addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('button')) send({ type: 'drag' });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (sheetMode) openSheet(null);
      else send({ type: 'hide' });
    } else if (!e.target.closest('input') && ['1', '2', '3', '4'].includes(e.key)) {
      state.tab = ['daily', 'weekly', 'events', 'weather'][Number(e.key) - 1];
      saveState();
      render();
    }
  });

  if (host) {
    host.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'settings') {
        hostSettings = msg;
        if (sheetMode === 'settings') renderSettings();
      } else if (msg.type === 'shown') {
        render();
      } else if (msg.type === 'update') {
        updateInfo = msg;
        renderVersionChip();
        renderUpdateBanner();
        if (sheetMode === 'settings') renderSettings();
      } else if (msg.type === 'data-updated') {
        loadData().then((fresh) => {
          data = fresh;
          buildGlossary();
          render();
          if (sheetMode === 'settings') renderSettings();
        });
      } else if (msg.type === 'fired') {
        state.fired[msg.id] = Date.now();
        saveState();
        syncReminders();
      }
    });
  }
}

async function loadData() {
  // В приложении данные отдаёт хост: встроенные или свежие с GitHub, смотря что новее.
  const res = await fetch(host ? 'https://data.local/data.json' : 'data.json', { cache: 'no-store' });
  return res.json();
}

async function init() {
  data = await loadData();
  buildGlossary();
  changelog = await fetch('changelog.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => []);
  state = loadState();
  rollover();
  pruneWeather();
  const monthAgo = Date.now() - 30 * D;
  for (const [id, t] of Object.entries(state.fired)) if (t < monthAgo) delete state.fired[id];
  saveState();
  bindUI();
  render();
  renderVersionChip();
  send({ type: 'get-update' });
  setInterval(tick, 1000);
}

init().catch((err) => {
  $('#content').innerHTML = `<div class="empty">Не удалось загрузить data.json<br><small>${esc(err.message)}</small></div>`;
});
