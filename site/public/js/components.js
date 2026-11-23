// Общие кирпичики интерфейса — строки HTML, которые используют несколько страниц.

import {
  esc, enc, icon, statusIcon, priorityIcon, fmtDate, relTime, relPeriod, fmtDelta, dateParts, endOfPeriod, toDate, count,
  TYPES, STATUS, FLAGS, PLAN_KINDS, CASE_KINDS, PRIORITY, MONTHS_SHORT, fmtNum,
} from './util.js';
import { store, rowFlag, isNew, rowsOfRecord, episodesOf, goalFor, goalState, post, refresh } from './store.js';
import { sparkline } from './charts.js';

export const statusPill = (status) =>
  STATUS[status] ? `<span class="status">${statusIcon(status)}<span>${STATUS[status]}</span></span>` : '';

/** Приоритет кейса: столбики + слово. У закрытых — насколько кейс был значим. */
export const priorityTag = (c) =>
  PRIORITY[c.priority]
    ? `<span class="prio prio-${c.priority}" title="Приоритет: ${PRIORITY[c.priority].toLowerCase()}">${priorityIcon(c.priority)}<span>${PRIORITY[c.priority]}</span></span>`
    : '';

/** Отметка «вне нормы»: стрелка в цветной плашке; текст рядом остаётся обычным цветом. */
export function flagBadge(flag, withLabel = false) {
  const f = FLAGS[flag];
  if (!f) return '';
  return `<span class="flag" title="${f.label}"><span class="flag-mark">${f.mark}</span>${withLabel ? `<span>${f.label}</span>` : ''}</span>`;
}

export const valueHtml = (row) =>
  `<span class="val"><b>${esc(row.value)}</b>${row.unit ? ` <span class="unit">${esc(row.unit)}</span>` : ''}</span>${flagBadge(rowFlag(row))}`;

export const typeBadge = (type) => {
  const t = TYPES[type] ?? { one: type, icon: 'note' };
  return `<span class="type type-${esc(type)}">${icon(t.icon, 14)}<span>${esc(t.one)}</span></span>`;
};

export const empty = (title, text = '') =>
  `<div class="empty"><h3>${title}</h3>${text ? `<p>${text}</p>` : ''}</div>`;

export const metricLink = (name) => `#/metrics?m=${enc(name)}`;
export const recordLink = (id) => `#/r/${enc(id)}`;
export const caseLink = (id) => `#/case/${enc(id)}`;

/** Изменение к прошлому замеру: «−17 к 17 окт 2025». Без оценки «хорошо/плохо» — она зависит от показателя. */
export function deltaText(test) {
  if (test.delta == null) return '';
  const d = fmtDelta(test.delta);
  return d === '0' ? `без изменений к ${fmtDate(test.prev.row.date, 'short')}` : `${d} к ${fmtDate(test.prev.row.date, 'short')}`;
}

/** Коротко о цели: «до цели 78 кг — 4 кг» или «цель 78 кг достигнута». */
export function goalLine(g) {
  if (!g || g.current == null) return '';
  const unit = g.unit ? ` ${g.unit}` : '';
  return g.reached ? `цель ${fmtNum(g.target)}${unit} достигнута` : `до цели ${fmtNum(g.target)}${unit} — ${fmtNum(g.remaining, 1)}${unit}`;
}

/** Карточка цели на странице кейса: где сейчас, шкала прогресса от старта до цели. */
export function goalBlock(g) {
  if (!g) return '';
  const unit = g.unit ? ` ${esc(g.unit)}` : '';
  if (g.current == null) {
    return `<section class="card"><div class="card-head">${icon('target', 18)}<h2>Цель: ${fmtNum(g.target)}</h2></div><p class="card-note">По показателю «${esc(g.metric)}» пока нет замеров.</p></section>`;
  }
  const pct = Math.round(g.pct * 100);
  return `
    <section class="card goal">
      <div class="card-head">${icon('target', 18)}<h2>Цель: ${fmtNum(g.target)}${unit}</h2><a class="card-end" href="${metricLink(g.metric)}">График</a></div>
      <div class="goal-top">
        <div class="goal-now"><b>${fmtNum(g.current)}</b><span class="unit">${esc(g.unit)}</span><small>сейчас · ${esc(fmtDate(g.date, 'short'))}</small></div>
        <div class="goal-text">
          ${g.reached ? '<b>Цель достигнута</b>' : `Осталось <b>${fmtNum(g.remaining, 1)}${unit}</b>`}
          <small>пройдено ${fmtNum(g.done, 1)} из ${fmtNum(g.total, 1)}${unit}</small>
        </div>
      </div>
      <div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Прогресс к цели: ${pct}%"><span style="width:${pct}%"></span></div>
      <div class="goal-scale">
        <span>${fmtNum(g.start)}${unit} — старт${g.start_date ? `, ${esc(fmtDate(g.start_date, 'short'))}` : ''}</span>
        <span>цель ${fmtNum(g.target)}${unit}</span>
      </div>
    </section>`;
}

/** Плитка показателя: название, значение, изменение (или путь до цели), линия динамики. */
export function metricTile(test) {
  const today = store.data.today;
  const goal = goalLine(goalFor(test.name));
  return `
    <a class="tile" href="${metricLink(test.name)}">
      <div class="tile-label">${esc(test.name)}</div>
      <div class="tile-value">${esc(test.last.value)}${test.unit ? `<span class="unit">${esc(test.unit)}</span>` : ''}${flagBadge(test.flag)}</div>
      <div class="tile-delta">${esc(goal || deltaText(test)) || '&nbsp;'}</div>
      <div class="tile-foot">
        <span class="tile-date" title="${esc(relTime(test.last.date, today))}">${esc(fmtDate(test.last.date, 'short'))}</span>
        ${sparkline(test.points, { w: 84, h: 26, flag: test.flag })}
      </div>
    </a>`;
}

/** Строка записи в ленте: дата, тип, заголовок, краткое содержание. */
export function recordRow(r) {
  const p = dateParts(r.date);
  const rows = r.type === 'labs' ? rowsOfRecord(r.id) : [];
  const flagged = rows.filter((row) => rowFlag(row)).length;
  const labsMeta = rows.length
    ? `<span class="row-meta">${count(rows.length, ['показатель', 'показателя', 'показателей'])}${flagged ? ` · <span class="flag-inline">${flagged} вне нормы</span>` : ' · все в норме'}</span>`
    : '';
  return `
    <a class="rec-row" href="${recordLink(r.id)}">
      <div class="rec-date"><b>${p?.d ?? ''}</b><span>${p?.m ? MONTHS_SHORT[p.m - 1] : ''}</span></div>
      <div class="rec-main">
        <div class="rec-top">${typeBadge(r.type)}${isNew(r.id) ? '<span class="new">новое</span>' : ''}${labsMeta}</div>
        <div class="rec-title">${esc(r.title)}</div>
        ${r.summary ? `<div class="rec-sub">${esc(r.summary)}</div>` : ''}
      </div>
      <div class="rec-status">${statusPill(r.status)}</div>
    </a>`;
}

/** Строка кейса: статус, название, следующий шаг. */
export function caseRow(c) {
  const eps = episodesOf(c.id);
  const closed = c.state === 'closed';
  const sub = closed ? c.resolution || c.summary : c.next || c.summary;
  const goal = closed ? '' : goalLine(goalState(c));
  return `
    <a class="case-row" href="${caseLink(c.id)}">
      ${!closed && c.kind === 'goal' ? icon('target', 18, 'goal-icon') : statusIcon(closed ? 'closed' : c.status, 18)}
      <div class="case-row-main">
        <div class="case-row-title">${esc(c.title)}</div>
        <div class="case-row-sub">${esc(sub)}</div>
      </div>
      <div class="case-row-meta">
        ${priorityTag(c)}
        ${eps.length ? `<span>${count(eps.length, ['эпизод', 'эпизода', 'эпизодов'])}</span>` : ''}
        ${goal ? `<span class="goal-chip">${esc(goal)}</span>` : ''}
        <span>${closed ? (c.closed ? `закрыт ${esc(fmtDate(c.closed, 'short'))}` : 'закрыт') : `с ${esc(fmtDate(c.opened, 'short'))}`}</span>
      </div>
      ${icon('chevron', 16, 'row-chevron')}
    </a>`;
}

/** Блок «дата» для плана: день и месяц крупно, либо месяц и год для неточных дат. */
function planDate(date) {
  const p = dateParts(date);
  if (!p) return '<div class="plan-date"><b>—</b></div>';
  if (p.d) return `<div class="plan-date"><b>${p.d}</b><span>${MONTHS_SHORT[p.m - 1]} ${p.y}</span></div>`;
  if (p.m) return `<div class="plan-date"><b>${MONTHS_SHORT[p.m - 1]}</b><span>${p.y}</span></div>`;
  return `<div class="plan-date"><b>${p.y}</b></div>`;
}

export function planRow(item) {
  const today = toDate(store.data.today);
  const overdue = !item.done && endOfPeriod(item.date) < today;
  const kind = PLAN_KINDS[item.kind] ?? PLAN_KINDS.task;
  const href = item.record ? recordLink(item.record) : item.case ? caseLink(item.case) : '';
  const title = href ? `<a href="${href}">${esc(item.title)}</a>` : esc(item.title);
  return `
    <div class="plan-row${item.done ? ' done' : ''}">
      ${planDate(item.date)}
      <div class="plan-main">
        <div class="plan-title">${title}</div>
        ${item.note ? `<div class="plan-note">${esc(item.note)}</div>` : ''}
        <div class="plan-meta">${icon(kind.icon, 13)}<span>${kind.label}</span>
          ${item.done ? `<span>· сделано${item.done_date ? ` ${esc(fmtDate(item.done_date, 'short'))}` : ''}</span>` : overdue ? '<span class="overdue">· срок прошёл</span>' : `<span>· ${esc(relPeriod(item.date, store.data.today))}</span>`}
        </div>
      </div>
      <button class="check-btn${item.done ? ' checked' : ''}" type="button" data-plan="${esc(item.id)}" data-done="${item.done ? '0' : '1'}"
        aria-label="${item.done ? 'Вернуть в план' : 'Отметить как сделанное'}: ${esc(item.title)}" title="${item.done ? 'Вернуть в план' : 'Отметить как сделанное'}">${icon('check', 15)}</button>
    </div>`;
}

/** Состояние по системам из свежей сводки: сначала то, что требует внимания, норма — компактно. */
export function systemsBlock(systems) {
  if (!systems?.length) return '';
  const href = (s) => (s.case ? caseLink(s.case) : s.record ? recordLink(s.record) : '');
  const attention = systems.filter((s) => s.status !== 'ok');
  const fine = systems.filter((s) => s.status === 'ok');
  const row = (s) => {
    const inner = `${statusIcon(s.status, 18)}<div><div class="sys-name">${esc(s.name)}<span class="sys-status">${STATUS[s.status]}</span></div><div class="sys-note">${esc(s.note)}</div></div>${href(s) ? icon('chevron', 16, 'row-chevron') : ''}`;
    return href(s) ? `<a class="sys-row" href="${href(s)}">${inner}</a>` : `<div class="sys-row">${inner}</div>`;
  };
  const chip = (s) => {
    const inner = `${statusIcon('ok', 14)}<span>${esc(s.name)}</span>`;
    return href(s)
      ? `<a class="sys-chip" href="${href(s)}" title="${esc(s.note)}">${inner}</a>`
      : `<span class="sys-chip" title="${esc(s.note)}">${inner}</span>`;
  };
  return `
    <div class="systems">
      ${attention.length ? `<div class="sys-list">${attention.map(row).join('')}</div>` : ''}
      ${fine.length ? `<div class="sys-fine"><div class="sys-fine-title">В норме — ${fine.length}</div><div class="sys-chips">${fine.map(chip).join('')}</div></div>` : ''}
    </div>`;
}

export const kindLabel = (kind) => CASE_KINDS[kind] ?? kind;

/** Ссылки внутри отрендеренного markdown: записи и кейсы открываем на сайте, файлы — в новой вкладке. */
export function internalizeLinks(root) {
  for (const a of root.querySelectorAll('a[href]')) {
    const url = new URL(a.href, location.origin);
    if (url.origin !== location.origin) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      continue;
    }
    const path = decodeURIComponent(url.pathname);
    let m;
    if ((m = path.match(/^\/records\/(.+)\/report\.md$/))) a.href = recordLink(m[1]);
    else if ((m = path.match(/^\/cases\/([^/]+)\.md$/))) a.href = caseLink(m[1]);
    else if (path.startsWith('/records/')) a.target = '_blank';
  }
}

// ---------- уведомление и общие действия ----------

let toastTimer;
export function toast(text, isError = false) {
  const node = document.getElementById('toast');
  node.textContent = text;
  node.classList.toggle('error', isError);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 4000);
}

/** Кнопки «сделано» в строках плана. root — элемент, который перерисовывается целиком. */
export function bindPlan(root, onChange) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-plan]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await post('/api/plan/done', { id: btn.dataset.plan, done: btn.dataset.done === '1' });
      await refresh();
      onChange();
    } catch (err) {
      btn.disabled = false;
      toast(`Не сохранилось: ${err.message}`, true);
    }
  });
}
