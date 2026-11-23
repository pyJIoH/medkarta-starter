// План, профиль, входящие.

import { $, esc, icon, fmtDate, age, count, fmtNum, num, toDate, endOfPeriod } from '../util.js';
import { store, api, who } from '../store.js';
import { planRow, empty, bindPlan, internalizeLinks, metricLink } from '../components.js';

// ---------- план ----------

export function renderPlan({ view }) {
  const today = toDate(store.data.today);
  const horizon = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate());
  const byDate = (a, b) => a.date.localeCompare(b.date);
  const open = store.data.plan.filter((p) => !p.done).sort(byDate);
  const soon = open.filter((p) => endOfPeriod(p.date) <= horizon);
  const later = open.filter((p) => endOfPeriod(p.date) > horizon);
  const done = store.data.plan.filter((p) => p.done).sort((a, b) => (b.done_date || b.date).localeCompare(a.done_date || a.date));
  const section = (title, items, hint = '') =>
    items.length
      ? `<section class="year"><h2>${title} <span>${items.length}</span></h2>${hint ? `<p class="sub">${hint}</p>` : ''}<div class="card plan-list">${items.map(planRow).join('')}</div></section>`
      : '';

  view.innerHTML = `
    <header class="page-head">
      <div>
        <h1>План</h1>
        <p class="sub">Что предстоит: анализы, визиты, прививки, скрининги. Сделал — отметь галочкой.</p>
      </div>
    </header>
    <div id="plan-page">
      ${open.length || done.length ? '' : empty('План пуст', `Скажи ${esc(who('dat'))}, что запланировано, — он добавит.`)}
      ${section('Ближайший год', soon)}
      ${section('Позже', later)}
      ${section('Сделано', done)}
    </div>
    <p class="page-note">Новый пункт — расскажи ${esc(who('dat'))} («в марте иду к стоматологу») или добавь в <code>plan.yaml</code>.</p>`;
  bindPlan($('#plan-page', view), () => renderPlan({ view }));
}

// ---------- профиль ----------

function profileStats(m) {
  const today = store.data.today;
  const weightRow = store.tests.get('Вес')?.last;
  const h = num(m.height_cm);
  const w = weightRow ? num(weightRow.value) : num(m.weight_kg);
  const bmi = h && w ? w / (h / 100) ** 2 : null;
  const years = age(m.born, today);
  const tile = (label, value, hint, href) => {
    const inner = `<div class="tile-label">${label}</div><div class="tile-value">${value}</div><div class="tile-date">${hint || '&nbsp;'}</div>`;
    return href ? `<a class="tile" href="${href}">${inner}</a>` : `<div class="tile">${inner}</div>`;
  };
  const tiles = [
    years != null && tile('Возраст', count(years, ['год', 'года', 'лет']), `с ${esc(fmtDate(m.born))}`),
    h && tile('Рост', `${fmtNum(h, 1)}<span class="unit">см</span>`, ''),
    w && tile('Вес', `${fmtNum(w, 1)}<span class="unit">кг</span>`, weightRow ? `на ${esc(fmtDate(weightRow.date, 'short'))}` : '', metricLink('Вес')),
    bmi && tile('ИМТ', fmtNum(bmi, 1), 'расчётный: вес / рост²', metricLink('ИМТ')),
    m.blood_type && tile('Группа крови', esc(m.blood_type), ''),
  ].filter(Boolean);
  return tiles.length ? `<div class="tiles profile-tiles">${tiles.join('')}</div>` : '';
}

export async function renderProfile({ view }) {
  const p = await api('/api/profile');
  view.innerHTML = p.html
    ? `${profileStats(p.meta)}<article class="doc"><div class="prose">${p.html}</div></article>`
    : `<header class="page-head"><h1>Обо мне</h1></header>${empty('Профиль не заполнен', `Расскажи ${esc(who('dat'))} о себе — он заполнит <code>profile.md</code>.`)}`;
  internalizeLinks(view);
}

// ---------- входящие ----------

function fmtSize(bytes) {
  if (bytes == null) return 'папка';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) (bytes /= 1024), i++;
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function renderInbox({ view }) {
  const items = store.data.inbox;
  view.innerHTML = `
    <header class="page-head">
      <div>
        <h1>Входящие <span class="muted">${items.length}</span></h1>
        <p class="sub">Сюда падает всё новое: файлы с сайта, заметки или то, что лежит в папке <code>inbox/</code>. Чтобы разобрать, скажи ${esc(who('dat'))}: <code>разбери inbox</code>.</p>
      </div>
    </header>
    <button class="dropzone" type="button" id="inbox-drop">
      ${icon('upload', 22)}
      <b>Перетащи файлы сюда или нажми</b>
      <span>PDF анализов, фото бланков, заключения МРТ, скриншоты</span>
    </button>
    ${
      items.length
        ? `<div class="card rows">${items
            .map(
              (i) => `<div class="inbox-row">${icon(i.dir ? 'cases' : 'file', 18)}
                <span class="inbox-name">${esc(i.name)}</span>
                <span class="muted nowrap">${fmtSize(i.size)} · ${new Date(i.mtime).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' })}</span></div>`,
            )
            .join('')}</div>`
        : empty('Входящие пусты', 'Всё разобрано.')
    }`;
  $('#inbox-drop', view).addEventListener('click', () => document.getElementById('file-input').click());
}
