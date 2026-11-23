// Записи: лента всех документов по времени и страница одной записи.

import { $, esc, enc, icon, fmtDate, count, dateParts, TYPES } from '../util.js';
import { store, api, rowFlag, rowsOfRecord, casesForRecord, markSeen } from '../store.js';
import {
  statusPill, typeBadge, recordRow, systemsBlock, valueHtml, empty, metricLink, caseLink, internalizeLinks,
} from '../components.js';

// ---------- лента ----------

const FILTER_ORDER = ['summary', 'labs', 'visit', 'imaging', 'treatment', 'note', 'symptom'];
let view = null;
let filter = '';

function renderList() {
  const records = store.data.records;
  const present = FILTER_ORDER.filter((t) => records.some((r) => r.type === t));
  if (filter && !present.includes(filter)) filter = '';
  const list = filter ? records.filter((r) => r.type === filter) : records;

  const years = new Map();
  for (const r of list) {
    const y = dateParts(r.date)?.y ?? 'Без даты';
    if (!years.has(y)) years.set(y, []);
    years.get(y).push(r);
  }

  view.innerHTML = `
    <header class="page-head">
      <div>
        <h1>Записи <span class="muted">${list.length}</span></h1>
        <p class="sub">Анализы, визиты к врачам, сводки и заметки — по времени, свежие сверху.</p>
      </div>
    </header>
    <div class="toolbar">
      <div class="seg" id="r-filter">
        <button class="seg-btn${filter ? '' : ' on'}" type="button" data-t="">Все <span>${records.length}</span></button>
        ${present
          .map(
            (t) => `<button class="seg-btn${filter === t ? ' on' : ''}" type="button" data-t="${t}">${TYPES[t].label} <span>${records.filter((r) => r.type === t).length}</span></button>`,
          )
          .join('')}
      </div>
    </div>
    ${
      list.length
        ? [...years]
            .map(([y, items]) => `<section class="year"><h2>${y}</h2><div class="card rows">${items.map(recordRow).join('')}</div></section>`)
            .join('')
        : empty('Записей пока нет', 'Перетащи файл в окно — после разбора запись появится здесь.')
    }`;

  $('#r-filter', view).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-t]');
    if (!btn) return;
    filter = btn.dataset.t;
    history.replaceState(null, '', filter ? `#/records?t=${filter}` : '#/records');
    renderList();
  });
}

export function renderRecords(ctx) {
  view = ctx.view;
  filter = ctx.query.get('t') ?? '';
  renderList();
}

// ---------- страница записи ----------

/** Для анализов: сколько показателей и какие вне нормы — со ссылками на динамику. */
function labsStrip(id) {
  const rows = rowsOfRecord(id);
  if (!rows.length) return '';
  const flagged = rows.filter((r) => rowFlag(r));
  return `
    <section class="strip">
      <div class="strip-head">
        <b>${count(rows.length, ['показатель', 'показателя', 'показателей'])}</b>
        <span>${flagged.length ? `${flagged.length} вне нормы` : 'все в норме'}</span>
      </div>
      ${
        flagged.length
          ? `<div class="strip-items">${flagged
              .map((r) => `<a class="strip-item" href="${metricLink(r.test)}"><span>${esc(r.test)}</span>${valueHtml(r)}</a>`)
              .join('')}</div>`
          : ''
      }
    </section>`;
}

function filesBlock(r) {
  if (!r.files.length && !r.dicom) return '';
  const base = `/records/${r.id.split('/').map(enc).join('/')}/`;
  const isImage = (f) => /\.(png|jpe?g|webp|gif)$/i.test(f);
  return `
    <section class="files">
      <h2>Файлы</h2>
      <div class="file-grid">
        ${r.files
          .map((f) => {
            const href = base + f.split('/').map(enc).join('/');
            return isImage(f)
              ? `<a class="file file-image" href="${href}" target="_blank" rel="noopener"><img src="${href}" alt="" loading="lazy"><span>${esc(f)}</span></a>`
              : `<a class="file" href="${href}" target="_blank" rel="noopener">${icon('file', 18)}<span>${esc(f)}</span><span class="file-ext">${esc(f.split('.').pop())}</span></a>`;
          })
          .join('')}
        ${r.dicom ? `<div class="file">${icon('lock', 18)}<span>Сырые DICOM — лежат локально, не в git</span></div>` : ''}
      </div>
    </section>`;
}

export async function renderRecord({ view: root, params }) {
  const r = await api(`/api/record?id=${enc(params[0])}`);
  markSeen(r.id);
  const cases = casesForRecord(r.id);

  root.innerHTML = `
    <nav class="crumbs"><a href="#/records">Записи</a>${icon('chevron', 14)}<span>${esc(r.title)}</span></nav>
    <article class="doc">
      <header class="doc-head">
        <div class="doc-badges">${typeBadge(r.type)}<time>${esc(fmtDate(r.date))}</time>${statusPill(r.status)}</div>
        <h1>${esc(r.title)}</h1>
        ${r.summary ? `<p class="lead">${esc(r.summary)}</p>` : ''}
        <div class="doc-facts">
          ${r.source ? `<span>Источник: <b>${esc(r.source)}</b></span>` : ''}
          ${cases.map((c) => `<a class="chip chip-link" href="${caseLink(c.id)}">Кейс: ${esc(c.title)}</a>`).join('')}
          ${r.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}
        </div>
      </header>
      ${r.type === 'labs' ? labsStrip(r.id) : ''}
      ${r.systems?.length ? `<section class="doc-systems"><h2>По системам</h2>${systemsBlock(r.systems)}</section>` : ''}
      <div class="prose">${r.html}</div>
      ${filesBlock(r)}
    </article>`;
  internalizeLinks(root);
}
