// Медкарта — оболочка: навигация, роутер, общий поиск, загрузка файлов, заметки, тема.
// Страницы лежат в js/views/, данные и модель — в js/store.js. Внешних запросов нет.

import { $, $$, esc, icon, statusIcon, fmtDate, count, TYPES } from './js/util.js';
import { store, refresh, post, sortedCases, isNew, who, genomeGroups, genomeNewCount } from './js/store.js';
import { toast, empty, metricLink, recordLink, caseLink, genomeLink } from './js/components.js';
import { hideTip } from './js/charts.js';
import * as home from './js/views/home.js';
import * as cases from './js/views/cases.js';
import * as metrics from './js/views/metrics.js';
import * as genome from './js/views/genome.js';
import * as records from './js/views/records.js';
import * as misc from './js/views/misc.js';

const view = $('#view');

const ROUTES = [
  { re: /^\/$/, nav: 'home', title: 'Обзор', render: home.render },
  { re: /^\/cases$/, nav: 'cases', title: 'Кейсы', render: cases.renderList },
  { re: /^\/case\/(.+)$/, nav: 'cases', title: 'Кейс', render: cases.renderCase },
  { re: /^\/metrics$/, nav: 'metrics', title: 'Показатели', render: metrics.render, update: metrics.update, leave: metrics.leave },
  { re: /^\/genome$/, nav: 'genome', title: 'Геном', render: genome.render, update: genome.update, leave: genome.leave },
  { re: /^\/records$/, nav: 'records', title: 'Записи', render: records.renderRecords },
  { re: /^\/r\/(.+)$/, nav: 'records', title: 'Запись', render: records.renderRecord },
  { re: /^\/plan$/, nav: 'plan', title: 'План', render: misc.renderPlan },
  { re: /^\/profile$/, nav: 'profile', title: 'Обо мне', render: misc.renderProfile },
  { re: /^\/inbox$/, nav: 'inbox', title: 'Входящие', render: misc.renderInbox },
];

// ---------- навигация ----------

function renderNav(active) {
  const d = store.data;
  const fresh = d ? d.records.filter((r) => isNew(r.id)).length : 0;
  const items = [
    ['home', '#/', 'home', 'Обзор'],
    ['cases', '#/cases', 'cases', 'Кейсы', d ? sortedCases('open').length : 0, ''],
    ['metrics', '#/metrics', 'pulse', 'Показатели'],
    // «Геном» появляется в меню, когда геном разобран; число — сколько генов обновилось с прошлого визита.
    d?.genome?.available ? ['genome', '#/genome', 'dna', 'Геном', genomeNewCount(), 'accent'] : false,
    ['records', '#/records', 'records', 'Записи', fresh, 'accent'],
    ['plan', '#/plan', 'calendar', 'План'],
    null,
    ['profile', '#/profile', 'user', 'Обо мне'],
    ['inbox', '#/inbox', 'inbox', 'Входящие', d ? d.inbox.length : 0, 'accent'],
  ];
  $('#nav').innerHTML = items
    .filter((item) => item !== false)
    .map((item) => {
      if (!item) return '<div class="nav-sep"></div>';
      const [key, href, ic, label, n, tone] = item;
      return `<a href="${href}" class="nav-item${active === key ? ' active' : ''}"${active === key ? ' aria-current="page"' : ''}>${icon(ic, 18)}<span>${label}</span>${
        n ? `<span class="count ${tone ?? ''}">${n}</span>` : ''
      }</a>`;
    })
    .join('');
}

// ---------- роутер ----------

function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const cut = raw.indexOf('?');
  return {
    path: (cut < 0 ? raw : raw.slice(0, cut)) || '/',
    query: new URLSearchParams(cut < 0 ? '' : raw.slice(cut + 1)),
  };
}

let currentPath = null;
let currentRoute = null;
let navToken = 0;

/** full — перерисовать страницу целиком, даже если путь тот же (после изменений данных). */
async function route({ full = false } = {}) {
  const { path, query } = parseHash();
  const legacy = path.match(/^\/t\/(\w+)$/); // ссылки из первой версии сайта
  if (legacy) return void location.replace(`#/records?t=${legacy[1]}`);

  const token = ++navToken;
  const samePath = path === currentPath;
  hideTip();
  closeSearch();

  try {
    await refresh(samePath && !full ? 3000 : 0);
  } catch (err) {
    view.innerHTML = empty('Сервер не отвечает', `Запусти его в папке проекта: <code>npm start</code>. (${esc(err.message)})`);
    return;
  }
  if (token !== navToken) return; // пока грузились, пользователь ушёл дальше
  // Имя ассистента в статичной разметке (диалог заметки) — из настроек карты.
  for (const el of document.querySelectorAll('[data-who]')) el.textContent = who(el.dataset.who, 'capital' in el.dataset);

  let found = null;
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) {
      found = { r, m };
      break;
    }
  }
  if (!found) {
    currentRoute?.leave?.();
    currentRoute = null;
    currentPath = path;
    view.innerHTML = empty('Такой страницы нет', '<a href="#/">Вернуться к обзору</a>');
    renderNav('');
    return;
  }

  let params;
  try {
    params = found.m.slice(1).map(decodeURIComponent);
  } catch {
    params = found.m.slice(1);
  }
  const ctx = { view, query, params };

  if (samePath && !full && found.r.update) {
    found.r.update(ctx);
    renderNav(found.r.nav);
    return;
  }
  if (currentRoute && currentRoute !== found.r) currentRoute.leave?.();
  currentRoute = found.r;
  currentPath = path;

  try {
    await found.r.render(ctx);
  } catch (err) {
    if (token !== navToken) return;
    view.innerHTML = empty('Не получилось открыть', esc(err.message));
  }
  renderNav(found.r.nav);
  document.title = `${found.r.title} · Медкарта`;
  if (!samePath) window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => route());

// Вернулись на вкладку — данные могли измениться (ассистент разобрал входящие): тихо обновляем.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (document.querySelector('dialog[open]')) return;
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  route({ full: true });
});

// ---------- общий поиск ----------

const search = $('#search');
const pop = $('#search-pop');
let hits = [];
let cursor = 0;

function searchAll(q) {
  const has = (...parts) => parts.join(' ').toLowerCase().includes(q);
  const d = store.data;
  const tests = [...store.tests.values()]
    .filter((t) => has(t.name, ...t.list.map((r) => r.test_original)))
    .slice(0, 6)
    .map((t) => ({
      group: 'Показатели',
      href: metricLink(t.name),
      icon: icon('pulse', 16),
      title: t.name,
      sub: `${t.last.value}${t.unit ? ` ${t.unit}` : ''} · ${fmtDate(t.last.date, 'short')}`,
    }));
  const caseHits = d.cases
    .filter((c) => has(c.title, c.summary))
    .slice(0, 4)
    .map((c) => ({
      group: 'Кейсы',
      href: caseLink(c.id),
      icon: statusIcon(c.state === 'closed' ? 'closed' : c.status, 16),
      title: c.title,
      sub: c.state === 'closed' ? 'закрыт' : `открыт с ${fmtDate(c.opened, 'short')}`,
    }));
  const recordHits = d.records
    .filter((r) => has(r.title, r.summary, r.source, ...r.tags))
    .slice(0, 6)
    .map((r) => ({
      group: 'Записи',
      href: recordLink(r.id),
      icon: icon(TYPES[r.type]?.icon ?? 'note', 16),
      title: r.title,
      sub: `${TYPES[r.type]?.one ?? r.type} · ${fmtDate(r.date, 'short')}`,
    }));
  // Гены: у чувствительных тем в подсказке только название — результат виден после перехода.
  const geneHits = genomeGroups()
    .filter((g) => has(g.title, g.group, g.drugs, ...g.markers.flatMap((m) => [m.gene, m.rsid])))
    .slice(0, 5)
    .map((g) => ({
      group: 'Геном',
      href: genomeLink(g.group),
      icon: icon('dna', 16),
      title: g.title,
      sub: g.sensitive ? g.section : (g.note?.result ?? g.section),
    }));
  return [...tests, ...caseHits, ...geneHits, ...recordHits];
}

function renderSearch() {
  const q = search.value.trim().toLowerCase();
  if (!q || !store.data) return closeSearch(false);
  hits = searchAll(q);
  cursor = 0;
  if (!hits.length) {
    pop.innerHTML = `<div class="sr-empty">По запросу «${esc(search.value.trim())}» ничего не нашлось</div>`;
  } else {
    let group = '';
    pop.innerHTML = hits
      .map((h, i) => {
        const head = h.group !== group ? `<div class="sr-group">${h.group}</div>` : '';
        group = h.group;
        return `${head}<a class="sr${i === 0 ? ' active' : ''}" href="${h.href}" data-i="${i}">${h.icon}<span class="sr-title">${esc(h.title)}</span><span class="sr-sub">${esc(h.sub)}</span></a>`;
      })
      .join('');
  }
  pop.hidden = false;
}

function closeSearch(clear = true) {
  pop.hidden = true;
  hits = [];
  if (clear) search.value = '';
}

function moveCursor(step) {
  if (!hits.length) return;
  cursor = (cursor + step + hits.length) % hits.length;
  for (const a of $$('.sr', pop)) a.classList.toggle('active', Number(a.dataset.i) === cursor);
  $('.sr.active', pop)?.scrollIntoView({ block: 'nearest' });
}

search.addEventListener('input', renderSearch);
search.addEventListener('focus', renderSearch);
search.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') (e.preventDefault(), moveCursor(1));
  else if (e.key === 'ArrowUp') (e.preventDefault(), moveCursor(-1));
  else if (e.key === 'Enter' && hits[cursor]) {
    e.preventDefault();
    location.hash = hits[cursor].href;
    search.blur();
  } else if (e.key === 'Escape') {
    closeSearch();
    search.blur();
  }
});
pop.addEventListener('click', () => search.blur());
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.search-box')) closeSearch(false);
});
document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    search.focus();
  }
});

// ---------- загрузка файлов ----------

async function upload(files) {
  files = [...files];
  if (!files.length) return;
  let ok = 0;
  for (const [i, f] of files.entries()) {
    toast(`Загружаю ${i + 1} из ${files.length}: ${f.name}`);
    try {
      const res = await fetch(`/api/inbox?name=${encodeURIComponent(f.name)}`, {
        method: 'POST',
        headers: { 'X-Medkarta': '1', 'Content-Type': 'application/octet-stream' },
        body: f,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      ok++;
    } catch (err) {
      toast(`Не загрузился ${f.name}: ${err.message}`, true);
      break;
    }
  }
  if (ok) toast(`Во входящих: +${count(ok, ['файл', 'файла', 'файлов'])}. Скажи ${who('dat')} «разбери inbox».`);
  route({ full: true });
}

$('#btn-upload').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  upload(e.target.files);
  e.target.value = '';
});

// Перетаскивание файлов в любое место окна.
const overlay = $('#drop-overlay');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  overlay.hidden = false;
});
window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) overlay.hidden = true;
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  upload(e.dataTransfer.files);
});

// ---------- быстрая заметка ----------

const noteDialog = $('#note-dialog');
const noteForm = $('#note-form');

function syncSeverity() {
  $('#severity-field').hidden = noteForm.kind.value !== 'symptom';
  $('#severity-value').textContent = noteForm.severity.value;
}

$('#btn-note').addEventListener('click', () => {
  noteForm.reset();
  noteForm.date.value = store.data?.today ?? '';
  syncSeverity();
  noteDialog.showModal();
  noteForm.text.focus();
});
$('[data-cancel]', noteDialog).addEventListener('click', () => noteDialog.close());
noteForm.addEventListener('input', syncSeverity);
noteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = noteForm.kind.value;
  try {
    await post('/api/note', {
      kind,
      date: noteForm.date.value,
      severity: kind === 'symptom' ? noteForm.severity.value : '',
      text: noteForm.text.value,
    });
    noteDialog.close();
    toast(`Заметка во входящих. Скажи ${who('dat')} «разбери inbox».`);
    route({ full: true });
  } catch (err) {
    toast(`Не сохранилось: ${err.message}`, true);
  }
});

// ---------- тема: системная → светлая → тёмная ----------

const THEMES = ['system', 'light', 'dark'];
const THEME_LABELS = { system: 'Тема: как в системе', light: 'Тема: светлая', dark: 'Тема: тёмная' };

function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}

function applyTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === 'system') localStorage.removeItem('medkarta.theme');
    else localStorage.setItem('medkarta.theme', theme);
  } catch {
    // приватный режим — тема просто не запомнится
  }
  $('#theme-label').textContent = THEME_LABELS[theme];
}

$('#theme-btn').addEventListener('click', () => applyTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]));

// ---------- старт ----------

for (const node of $$('[data-icon]')) {
  node.insertAdjacentHTML('afterbegin', icon(node.dataset.icon, Number(node.dataset.iconSize) || 16));
}
$('#theme-label').textContent = THEME_LABELS[currentTheme()];
cases.init({ rerender: () => route({ full: true }) });
metrics.init();
genome.init();
renderNav('');
route();
