// Кейсы: то, за чем наблюдаем. Список (активные / закрытые) и страница кейса
// с эпизодами, связанными показателями и записями. Кейс можно закрыть и открыть снова.

import { $, esc, enc, icon, statusIcon, priorityIcon, fmtDate, relTime, count, plural, dateParts, STATUS, PRIORITY } from '../util.js';
import { store, api, post, refresh, sortedCases, episodesOf, recordById, goalState, who, genomeForCase } from '../store.js';
import {
  statusPill, valueHtml, typeBadge, empty, metricLink, recordLink, caseLink, kindLabel, internalizeLinks, toast,
  goalLine, goalBlock, priorityTag, genomeRows,
} from '../components.js';
import { sparkline, monthColumns } from '../charts.js';

const EPISODE_FORMS = ['эпизод', 'эпизода', 'эпизодов'];

// ---------- список ----------

function caseCard(c) {
  const closed = c.state === 'closed';
  const eps = episodesOf(c.id);
  const tests = c.metrics.map((n) => store.tests.get(n)).filter(Boolean).slice(0, 3);
  const dates = closed
    ? `${esc(fmtDate(c.opened, 'short'))} — ${c.closed ? esc(fmtDate(c.closed, 'short')) : 'закрыт'}`
    : `с ${esc(fmtDate(c.opened, 'short'))}`;
  return `
    <a class="case-card" href="${caseLink(c.id)}">
      <div class="case-card-head">
        ${!closed && c.kind === 'goal' ? icon('target', 20, 'goal-icon') : statusIcon(closed ? 'closed' : c.status, 20)}
        <h3>${esc(c.title)}</h3>
        ${priorityTag(c)}
      </div>
      <p class="case-card-summary">${esc(c.summary)}</p>
      ${
        tests.length
          ? `<div class="case-card-metrics">${tests
              .map((t) => `<span class="mini-val"><span class="mini-name">${esc(t.name)}</span>${valueHtml(t.last)}</span>`)
              .join('')}</div>`
          : ''
      }
      <div class="case-card-foot">
        <span>${esc(kindLabel(c.kind))}</span>
        <span>· ${dates}</span>
        ${eps.length ? `<span>· ${count(eps.length, EPISODE_FORMS)}</span>` : ''}
        ${!closed && c.kind !== 'goal' ? `<span>· ${STATUS[c.status]}</span>` : ''}
        ${!closed && c.goal ? `<span class="goal-chip">· ${esc(goalLine(goalState(c)))}</span>` : ''}
      </div>
      ${
        closed
          ? c.resolution ? `<div class="case-card-next">${icon('check', 15)}<span>${esc(c.resolution)}</span></div>` : ''
          : c.next ? `<div class="case-card-next">${icon('arrow-right', 15)}<span>${esc(c.next)}</span></div>` : ''
      }
    </a>`;
}

export function renderList({ view, query }) {
  const tab = query.get('s') === 'closed' ? 'closed' : 'open';
  const open = sortedCases('open');
  const closed = sortedCases('closed');
  const list = tab === 'open' ? open : closed;
  view.innerHTML = `
    <header class="page-head">
      <div>
        <h1>Кейсы</h1>
        <p class="sub">Симптомы, состояния и отклонения в анализах, за которыми наблюдаем. Прошло или показатель пришёл в норму — закрываем кейс.</p>
      </div>
    </header>
    <div class="toolbar">
      <div class="seg">
        <a class="seg-btn${tab === 'open' ? ' on' : ''}" href="#/cases">Активные <span>${open.length}</span></a>
        <a class="seg-btn${tab === 'closed' ? ' on' : ''}" href="#/cases?s=closed">Закрытые <span>${closed.length}</span></a>
      </div>
      <span class="toolbar-hint">Новый симптом? Нажми «Заметка» вверху или расскажи ${esc(who('dat'))} — он заведёт кейс.</span>
    </div>
    ${
      list.length
        ? `<div class="case-cards">${list.map(caseCard).join('')}</div>`
        : tab === 'open'
          ? empty('Активных кейсов нет', closed.length ? 'Всё, за чем наблюдали, закрыто.' : `Расскажи ${esc(who('dat'))}, что беспокоит, — он заведёт кейс.`)
          : empty('Закрытых кейсов пока нет')
    }`;
}

// ---------- страница кейса ----------

/** Последние 12 месяцев, включая текущий: [{ key: 'YYYY-MM', count }]. */
function lastMonths(episodes, today) {
  const t = dateParts(today);
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(t.y, t.m - 1 - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({ key, count: episodes.filter((e) => e.date.startsWith(key)).length });
  }
  return months;
}

function episodesCard(c, eps) {
  const table = eps.length
    ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Дата</th><th>Сколько длилось</th><th>Сила</th><th>Перед этим</th><th>Что помогло</th><th>Заметка</th></tr></thead>
        <tbody>${eps
          .map(
            (e) => `<tr>
              <td class="nowrap">${esc(fmtDate(e.date, 'short'))}</td>
              <td>${esc(e.duration) || '<span class="muted">—</span>'}</td>
              <td class="nowrap">${e.severity !== '' ? `<b>${esc(e.severity)}</b><span class="muted"> / 10</span>` : '<span class="muted">—</span>'}</td>
              <td>${esc(e.before) || '<span class="muted">—</span>'}</td>
              <td>${esc(e.helped) || '<span class="muted">—</span>'}</td>
              <td class="muted">${esc(e.note)}</td>
            </tr>`,
          )
          .join('')}</tbody></table></div>`
    : `<p class="card-note">Эпизодов пока не записано. Когда случится — нажми «Записать эпизод»: дата, сколько длилось, сила, что было перед этим. Через несколько эпизодов станет видна картина.</p>`;
  return `
    <section class="card">
      <div class="card-head">
        <h2>Эпизоды</h2><span class="card-count">${eps.length}</span>
        ${eps.length ? `<span class="card-meta">последний записанный — ${esc(fmtDate(eps[0].date, 'short'))}</span>` : ''}
        ${c.state === 'open' ? `<button class="btn btn-sm card-end" type="button" data-act="episode">${icon('plus', 15)}Записать эпизод</button>` : ''}
      </div>
      ${eps.length ? '<figure class="chart-card"><figcaption>По месяцам, последние 12 месяцев</figcaption><div id="episodes-chart"></div></figure>' : ''}
      ${table}
    </section>`;
}

function sideMetrics(tests) {
  if (!tests.length) return '';
  return `
    <section class="card">
      <div class="card-head"><h2>Показатели</h2></div>
      <div class="rows">${tests
        .map(
          (t) => `
          <a class="mini-metric" href="${metricLink(t.name)}">
            <div>
              <div class="mini-metric-name">${esc(t.name)}</div>
              <div class="mini-metric-val">${valueHtml(t.last)}</div>
              <div class="mini-metric-date">${esc(fmtDate(t.last.date, 'short'))}</div>
            </div>
            ${sparkline(t.points, { w: 72, h: 26, flag: t.flag })}
          </a>`,
        )
        .join('')}</div>
    </section>`;
}

function sideGenome(groups) {
  if (!groups.length) return '';
  return `
    <section class="card">
      <div class="card-head"><h2>В геноме</h2></div>
      <div class="rows">${genomeRows(groups)}</div>
    </section>`;
}

function sideRecords(records) {
  if (!records.length) return '';
  return `
    <section class="card">
      <div class="card-head"><h2>Связанные записи</h2></div>
      <div class="rows">${records
        .map(
          (r) => `
          <a class="mini-record" href="${recordLink(r.id)}">
            <div class="mini-record-top">${typeBadge(r.type)}<span>${esc(fmtDate(r.date, 'short'))}</span></div>
            <div class="mini-record-title">${esc(r.title)}</div>
          </a>`,
        )
        .join('')}</div>
    </section>`;
}

/** Переключатель приоритета — меняется сразу, без кнопки «сохранить». */
function priorityControl(c) {
  const option = (p) =>
    `<label><input type="radio" name="priority" value="${p}"${c.priority === p ? ' checked' : ''}><span>${priorityIcon(p)}${PRIORITY[p]}</span></label>`;
  return `
    <div class="prio-control">
      <span class="prio-control-label" id="prio-label">Приоритет</span>
      <div class="segmented prio-seg" role="radiogroup" aria-labelledby="prio-label">${Object.keys(PRIORITY).map(option).join('')}</div>
    </div>`;
}

let current = null; // кейс, открытый сейчас, — для диалогов
let rerender = () => {};

export async function renderCase({ view, params }) {
  const id = params[0];
  const c = await api(`/api/case?id=${enc(id)}`);
  current = c;
  const today = store.data.today;
  const closed = c.state === 'closed';
  const eps = episodesOf(id);
  const tests = c.metrics.map((n) => store.tests.get(n)).filter(Boolean);
  const records = c.records.map(recordById).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date));
  const showEpisodes = c.kind === 'symptom' || eps.length > 0;

  view.innerHTML = `
    <nav class="crumbs"><a href="#/cases${closed ? '?s=closed' : ''}">Кейсы</a>${icon('chevron', 14)}<span>${esc(c.title)}</span></nav>
    <header class="case-head">
      <div class="case-head-main">
        <div class="case-badges">
          <span class="state state-${c.state}">${closed ? `${icon('check', 14)}Закрыт` : 'Открыт'}</span>
          ${closed || c.kind === 'goal' ? '' : statusPill(c.status)}
          <span class="chip">${esc(kindLabel(c.kind))}</span>
        </div>
        <h1>${esc(c.title)}</h1>
        <p class="lead">${esc(c.summary)}</p>
        <div class="case-dates">
          Начало — ${esc(fmtDate(c.opened))}${dateParts(c.opened)?.d ? ` (${esc(relTime(c.opened, today))})` : ''}${closed && c.closed ? ` · закрыт ${esc(fmtDate(c.closed))}` : ''}
        </div>
        ${priorityControl(c)}
      </div>
      <div class="case-actions">
        ${
          closed
            ? `<button class="btn" type="button" data-act="reopen">Открыть снова</button>`
            : `<button class="btn" type="button" data-act="close">${icon('check', 16)}Закрыть кейс</button>`
        }
      </div>
    </header>
    ${
      closed
        ? c.resolution ? `<div class="callout callout-done">${icon('check', 18)}<div><b>Чем закончилось</b><p>${esc(c.resolution)}</p></div></div>` : ''
        : c.next ? `<div class="callout">${icon('arrow-right', 18)}<div><b>Следующий шаг</b><p>${esc(c.next)}</p></div></div>` : ''
    }
    <div class="split">
      <div class="split-main">
        ${closed ? '' : goalBlock(goalState(c))}
        ${showEpisodes ? episodesCard(c, eps) : ''}
        <article class="doc"><div class="prose">${c.html}</div></article>
      </div>
      <aside class="split-side">
        ${sideMetrics(tests)}
        ${sideGenome(genomeForCase(c.id))}
        ${sideRecords(records)}
      </aside>
    </div>`;

  internalizeLinks(view);
  if (eps.length) monthColumns($('#episodes-chart', view), lastMonths(eps, today), (n) => plural(n, EPISODE_FORMS));

  $('.case-head', view).addEventListener('click', onAction);
  $('.split-main', view).addEventListener('click', onAction);
  $('.prio-seg', view)?.addEventListener('change', onPriority);
}

async function onPriority(e) {
  const group = e.currentTarget;
  const priority = e.target.value;
  const before = current.priority;
  try {
    await post('/api/case/priority', { id: current.id, priority });
    current.priority = priority;
    toast(`Приоритет — ${PRIORITY[priority].toLowerCase()}.`);
    await refresh();
  } catch (err) {
    const back = group.querySelector(`input[value="${before}"]`);
    if (back) back.checked = true;
    toast(`Не сохранилось: ${err.message}`, true);
  }
}

async function onAction(e) {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !current) return;
  if (act === 'episode') openEpisodeDialog();
  if (act === 'close') openCloseDialog();
  if (act === 'reopen') {
    try {
      await post('/api/case/state', { id: current.id, state: 'open' });
      toast('Кейс снова открыт.');
      await refresh();
      rerender();
    } catch (err) {
      toast(`Не получилось: ${err.message}`, true);
    }
  }
}

// ---------- диалоги: закрыть кейс, записать эпизод ----------

const todayInput = () => store.data.today;

function openCloseDialog() {
  const form = $('#close-form');
  form.reset();
  form.date.value = todayInput();
  form.date.max = todayInput();
  $('#close-title').textContent = current.title;
  $('#close-dialog').showModal();
  form.note.focus();
}

function openEpisodeDialog() {
  const form = $('#episode-form');
  form.reset();
  form.date.value = todayInput();
  form.date.max = todayInput();
  $('#episode-title').textContent = current.title;
  $('#episode-severity').textContent = form.severity.value;
  $('#episode-dialog').showModal();
  form.duration.focus();
}

/** Вызывается один раз при старте: диалоги живут в index.html. */
export function init(options) {
  rerender = options.rerender;

  for (const dialog of [$('#close-dialog'), $('#episode-dialog')]) {
    dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
  }

  $('#close-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await post('/api/case/state', { id: current.id, state: 'closed', date: form.date.value, note: form.note.value });
      $('#close-dialog').close();
      toast('Кейс закрыт. Он остаётся в «Закрытых» как история.');
      await refresh();
      rerender();
    } catch (err) {
      toast(`Не получилось: ${err.message}`, true);
    }
  });

  const episodeForm = $('#episode-form');
  episodeForm.severity.addEventListener('input', () => ($('#episode-severity').textContent = episodeForm.severity.value));
  episodeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await post('/api/case/episode', {
        id: current.id,
        date: episodeForm.date.value,
        duration: episodeForm.duration.value,
        severity: episodeForm.severity.value,
        before: episodeForm.before.value,
        helped: episodeForm.helped.value,
        note: episodeForm.note.value,
      });
      $('#episode-dialog').close();
      toast('Эпизод записан.');
      await refresh();
      rerender();
    } catch (err) {
      toast(`Не сохранилось: ${err.message}`, true);
    }
  });
}
