// Показатели: последние значения и динамика всех анализов в одном месте.
// Два вида — список со спарклайнами и таблица «по датам»; клик по строке открывает
// боковую панель с графиком, зоной нормы и полной историей.

import { $, $$, esc, enc, icon, fmtDate, relTime, num, count, fmtNum, FLAGS } from '../util.js';
import { store, post, rowFlag, refText, categories, isPinned, casesForTest, goalFor } from '../store.js';
import { valueHtml, flagBadge, empty, deltaText, recordLink, caseLink, toast, goalLine, statusPill } from '../components.js';
import { sparkline, lineChart, hideTip } from '../charts.js';

const state = { f: 'all', v: 'list', q: '', m: '' };
let view = null;
let openedHere = false; // панель открыта кликом на этой странице → закрываем через «назад»

const FILTERS = { all: 'Все', flagged: 'Вне нормы', pinned: 'Закреплённые' };
const BP = ['АД систолическое', 'АД диастолическое'];

function readQuery(query) {
  state.f = FILTERS[query.get('f')] ? query.get('f') : 'all';
  state.v = query.get('v') === 'matrix' ? 'matrix' : 'list';
  state.q = query.get('q') ?? '';
  state.m = query.get('m') ?? '';
}

function hashFor(overrides = {}) {
  const s = { ...state, ...overrides };
  const params = new URLSearchParams();
  if (s.f !== 'all') params.set('f', s.f);
  if (s.v !== 'list') params.set('v', s.v);
  if (s.q) params.set('q', s.q);
  if (s.m) params.set('m', s.m);
  const qs = params.toString();
  return `#/metrics${qs ? `?${qs}` : ''}`;
}

function visibleTests() {
  const q = state.q.trim().toLowerCase();
  return [...store.tests.values()].filter((t) => {
    if (state.f === 'flagged' && !t.flag) return false;
    if (state.f === 'pinned' && !isPinned(t.name)) return false;
    if (q && !`${t.name} ${t.list.map((r) => r.test_original).join(' ')} ${t.category}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

const starBtn = (name) =>
  `<button class="star${isPinned(name) ? ' on' : ''}" type="button" data-pin="${esc(name)}" aria-pressed="${isPinned(name)}"
    aria-label="${isPinned(name) ? 'Убрать с главной' : 'Закрепить на главной'}: ${esc(name)}" title="${isPinned(name) ? 'Убрать с главной' : 'Закрепить на главной'}">${icon('star', 16)}</button>`;

// ---------- вид «список» ----------

/** Норма последнего замера; если лаборатория её не дала — последняя известная, с пометкой чья. */
function normCell(test) {
  const own = refText(test.last);
  if (own) return esc(own);
  const band = bandFor(test);
  return band ? `${esc(refText(band.row))}<small>по ${esc(labShort(band.row.lab))}, ${esc(fmtDate(band.row.date, 'short'))}</small>` : '—';
}

function listSection(cat, tests) {
  const today = store.data.today;
  tests.sort((a, b) => (b.flag ? 1 : 0) - (a.flag ? 1 : 0) || a.name.localeCompare(b.name, 'ru'));
  return `
    <section class="m-section" data-cat="${esc(cat)}">
      <h2>${esc(cat)} <span>${tests.length}</span></h2>
      <div class="table-wrap"><table class="data m-table">
        <thead><tr><th class="col-star"></th><th>Показатель</th><th>Значение</th><th>Норма</th><th>Изменение</th><th>Динамика</th><th>Когда</th></tr></thead>
        <tbody>${tests
          .map(
            (t) => `
            <tr class="m-row" data-test="${esc(t.name)}" tabindex="0" role="button" aria-label="${esc(t.name)} — открыть историю">
              <td class="col-star">${starBtn(t.name)}</td>
              <td class="m-name">${esc(t.name)}</td>
              <td class="nowrap">${valueHtml(t.last)}</td>
              <td class="muted nowrap">${normCell(t)}</td>
              <td class="muted nowrap">${t.delta == null ? '—' : esc(deltaText(t).replace(/ к .*/, ''))}</td>
              <td>${sparkline(t.points, { flag: t.flag }) || `<span class="muted small">${t.list.length === 1 ? 'один замер' : ''}</span>`}</td>
              <td class="muted nowrap">${esc(fmtDate(t.last.date, 'short'))}<span class="m-age">${esc(relTime(t.last.date, today))}</span></td>
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </section>`;
}

// ---------- вид «по датам» ----------

// Короткое имя лаборатории для шапки таблицы — первое слово: «Альфа-Лаб (филиал)» → «Альфа-Лаб».
const labShort = (lab) => String(lab ?? '').trim().split(/[\s(,]/)[0] || lab;

function matrixSection(cat, tests) {
  tests.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const dates = [...new Set(tests.flatMap((t) => t.list.map((r) => r.date)))].sort().reverse();
  const labOf = (date) => labShort(tests.flatMap((t) => t.list).find((r) => r.date === date)?.lab ?? '');
  return `
    <section class="m-section" data-cat="${esc(cat)}">
      <h2>${esc(cat)} <span>${tests.length}</span></h2>
      <div class="table-wrap"><table class="data m-matrix">
        <thead><tr><th class="sticky-col">Показатель</th>${dates
          .map((d) => `<th class="num">${esc(fmtDate(d, 'short'))}<small>${esc(labOf(d))}</small></th>`)
          .join('')}</tr></thead>
        <tbody>${tests
          .map(
            (t) => `
            <tr class="m-row" data-test="${esc(t.name)}" tabindex="0" role="button" aria-label="${esc(t.name)} — открыть историю">
              <td class="sticky-col m-name">${esc(t.name)}${t.unit ? `<small>${esc(t.unit)}</small>` : ''}</td>
              ${dates
                .map((d) => {
                  const r = t.list.find((row) => row.date === d);
                  return r
                    ? `<td class="num"><b>${esc(r.value)}</b>${flagBadge(rowFlag(r)) || '<span class="flag ghost"><span class="flag-mark"></span></span>'}</td>`
                    : '<td class="num muted">·<span class="flag ghost"><span class="flag-mark"></span></span></td>';
                })
                .join('')}
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </section>`;
}

function renderBody() {
  const tests = visibleTests();
  const cats = categories(tests);
  const body = $('#m-body', view);
  $('#m-count', view).textContent = tests.length;
  $('#m-cats', view).innerHTML =
    cats.length > 1 ? cats.map((c) => `<button class="cat-chip" type="button" data-jump="${esc(c)}">${esc(c)}</button>`).join('') : '';
  if (!tests.length) {
    body.innerHTML =
      state.f === 'pinned' && !state.q
        ? empty('Ничего не закреплено', 'Нажми звёздочку у показателя — он появится здесь и на главной.')
        : store.tests.size
          ? empty('Ничего не нашлось', state.q ? `По запросу «${esc(state.q)}» показателей нет.` : 'Под этот фильтр ничего не подходит.')
          : empty('Показателей пока нет', 'Они появятся после разбора первых анализов и замеров.');
    return;
  }
  const section = state.v === 'matrix' ? matrixSection : listSection;
  body.innerHTML = cats.map((c) => section(c, tests.filter((t) => t.category === c))).join('');
}

function renderToolbar() {
  const all = [...store.tests.values()];
  const counts = { all: all.length, flagged: all.filter((t) => t.flag).length, pinned: all.filter((t) => isPinned(t.name)).length };
  $('#m-filter', view).innerHTML = Object.entries(FILTERS)
    .map(([key, label]) => `<button class="seg-btn${state.f === key ? ' on' : ''}" type="button" data-f="${key}">${label} <span>${counts[key]}</span></button>`)
    .join('');
  $('#m-view', view).innerHTML = [
    ['list', 'list', 'Список'],
    ['matrix', 'table', 'По датам'],
  ]
    .map(([key, ic, label]) => `<button class="seg-btn${state.v === key ? ' on' : ''}" type="button" data-v="${key}">${icon(ic, 15)}${label}</button>`)
    .join('');
}

// ---------- боковая панель показателя ----------

const drawer = () => document.getElementById('drawer');
const backdrop = () => document.getElementById('drawer-backdrop');

/** Зона нормы — из самого свежего замера, где лаборатория дала числовой референс. */
function bandFor(test) {
  const row = [...test.list].reverse().find((r) => Number.isFinite(num(r.ref_low)) || Number.isFinite(num(r.ref_high)));
  return row ? { low: num(row.ref_low), high: num(row.ref_high), row } : null;
}

/** «Что это» и оценка ассистента из metrics/descriptions.yaml. */
function aboutBlocks(test) {
  const d = store.data.descriptions?.[test.name];
  if (!d || (!d.about && !d.assessment)) {
    return '<p class="chart-note">Описания пока нет — ассистент добавит его при следующем разборе.</p>';
  }
  const stale = d.as_of && test.last.date > d.as_of;
  return `
    ${d.about ? `<div class="about"><h3>Что это</h3><p>${esc(d.about)}</p></div>` : ''}
    ${
      d.assessment
        ? `<div class="assess${d.status ? ` assess-${d.status}` : ''}">
            <div class="assess-head"><h3>Оценка ассистента</h3>${statusPill(d.status)}</div>
            <p>${esc(d.assessment)}</p>
            <div class="assess-foot">${
              stale
                ? `${icon('clock', 13)}<span>Оценка сделана по данным на ${esc(fmtDate(d.as_of, 'short'))} — с тех пор есть новый замер. Попроси ассистента обновить.</span>`
                : `<span>${d.as_of ? `По данным на ${esc(fmtDate(d.as_of, 'short'))} · ` : ''}толкование, не диагноз</span>`
            }</div>
          </div>`
        : ''
    }`;
}

function renderDrawer(test) {
  const today = store.data.today;
  const isBp = BP.includes(test.name);
  const band = isBp ? null : bandFor(test);
  const cases = casesForTest(test.name);
  const goal = goalFor(test.name);
  const aliases = [...new Set(test.list.map((r) => r.test_original).filter(Boolean))];
  const hasChart = test.points.length >= 2;
  // Давление показываем парой «118/84»: систолическое и диастолическое с одного приёма.
  const [sysTest, diaTest] = BP.map((name) => store.tests.get(name));
  const pair = (date) => {
    const s = sysTest?.list.find((r) => r.date === date);
    const d = diaTest?.list.find((r) => r.date === date);
    return s && d ? `${s.value}/${d.value}` : null;
  };
  const heroValue = (isBp && pair(test.last.date)) || test.last.value;
  const histValue = (r) => (isBp && pair(r.date) ? `<span class="val"><b>${esc(pair(r.date))}</b> <span class="unit">${esc(r.unit)}</span></span>` : valueHtml(r));

  drawer().innerHTML = `
    <header class="drawer-head">
      <div>
        <div class="eyebrow">${esc(test.category)}</div>
        <h2 id="drawer-title">${isBp ? 'Артериальное давление' : esc(test.name)}</h2>
      </div>
      <div class="drawer-actions">
        ${isBp ? '' : starBtn(test.name)}
        <button class="icon-btn" type="button" data-close aria-label="Закрыть">${icon('x', 18)}</button>
      </div>
    </header>
    <div class="drawer-body">
      <div class="hero">
        <div class="hero-value">${esc(heroValue)}${test.unit ? `<span class="unit">${esc(test.unit)}</span>` : ''}</div>
        ${flagBadge(test.flag, true)}
      </div>
      <div class="hero-sub">${esc(fmtDate(test.last.date))} · ${esc(relTime(test.last.date, today))}${test.last.lab ? ` · ${esc(test.last.lab)}` : ''}</div>
      ${test.delta != null && !isBp ? `<div class="hero-delta">${esc(deltaText(test))}</div>` : ''}
      ${goal ? `<a class="hero-goal" href="${caseLink(goal.case.id)}">${icon('target', 15)}<span>${esc(goalLine(goal))}</span></a>` : ''}

      ${aboutBlocks(test)}

      ${
        hasChart
          ? `<figure class="chart-card">
              <figcaption>${isBp ? `Давление на приёмах${test.unit ? `, ${esc(test.unit)}` : ''}` : `Все замеры${test.unit ? `, ${esc(test.unit)}` : ''}`}</figcaption>
              <div id="drawer-chart"></div>
              ${
                band
                  ? `<p class="chart-note">Зона нормы ${esc(refText(band.row))} — из бланка: ${esc(band.row.lab)}, ${esc(fmtDate(band.row.date, 'short'))}. У разных лабораторий нормы могут отличаться.</p>`
                  : isBp
                    ? ''
                    : '<p class="chart-note">Числовой нормы в бланках нет — показана только динамика.</p>'
              }
            </figure>`
          : `<p class="chart-note">${test.list.length === 1 ? 'Один замер — график появится после следующего.' : 'Значения не числовые — графика нет.'}</p>`
      }

      ${
        cases.length
          ? `<div class="drawer-block"><h3>Относится к кейсам</h3><div class="chips">${cases
              .map((c) => `<a class="chip chip-link" href="${caseLink(c.id)}">${esc(c.title)}</a>`)
              .join('')}</div></div>`
          : ''
      }

      <div class="drawer-block">
        <h3>История <span class="muted">${count(test.list.length, ['замер', 'замера', 'замеров'])}</span></h3>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Дата</th><th>Значение</th><th>Норма</th><th>Источник</th></tr></thead>
          <tbody>${[...test.list]
            .reverse()
            .map(
              (r) => `<tr>
                <td class="nowrap">${r.record ? `<a href="${recordLink(r.record)}">${esc(fmtDate(r.date, 'short'))}</a>` : esc(fmtDate(r.date, 'short'))}</td>
                <td class="nowrap">${histValue(r)}</td>
                <td class="muted nowrap">${esc(refText(r)) || '—'}</td>
                <td class="muted">${esc(r.lab)}${r.comment ? `<div class="small">${esc(r.comment)}</div>` : ''}</td>
              </tr>`,
            )
            .join('')}</tbody>
        </table></div>
      </div>
      ${aliases.length && !isBp ? `<p class="chart-note">В бланках: ${aliases.map(esc).join('; ')}</p>` : ''}
    </div>`;

  if (hasChart) {
    const series = isBp
      ? BP.map((name, i) => ({
          name: i ? 'Диастолическое' : 'Систолическое',
          short: i ? 'диаст.' : 'сист.',
          color: `var(--series-${i + 1})`,
          points: store.tests.get(name)?.points ?? [],
        }))
      : [{ name: test.name, color: 'var(--series-1)', points: test.points }];
    lineChart($('#drawer-chart'), {
      series,
      band,
      target: goal ? { value: goal.target, label: `цель ${fmtNum(goal.target)}` } : null,
      unit: test.unit,
      title: `График: ${test.name}, ${count(test.points.length, ['замер', 'замера', 'замеров'])}`,
    });
  }
}

function syncDrawer() {
  const test = state.m ? store.tests.get(state.m) : null;
  const el = drawer();
  hideTip();
  if (!test) {
    el.hidden = true;
    backdrop().hidden = true;
    document.body.classList.remove('drawer-open');
    return;
  }
  renderDrawer(test);
  const wasHidden = el.hidden;
  el.hidden = false;
  backdrop().hidden = false;
  document.body.classList.add('drawer-open');
  if (wasHidden) $('[data-close]', el).focus({ preventScroll: true });
  for (const row of $$('.m-row', view)) row.classList.toggle('selected', row.dataset.test === state.m);
}

function closeDrawer() {
  if (!state.m) return;
  if (openedHere) {
    openedHere = false;
    history.back();
  } else {
    location.replace(hashFor({ m: '' }));
  }
}

async function togglePin(name) {
  try {
    store.data.pinned = await post('/api/pin', { test: name, pinned: !isPinned(name) });
    toast(isPinned(name) ? 'Закреплено на главной.' : 'Убрано с главной.');
    renderToolbar();
    if (state.f === 'pinned') renderBody();
    for (const btn of $$(`[data-pin="${CSS.escape(name)}"]`)) {
      btn.classList.toggle('on', isPinned(name));
      btn.setAttribute('aria-pressed', isPinned(name));
    }
  } catch (err) {
    toast(`Не сохранилось: ${err.message}`, true);
  }
}

// ---------- сборка страницы ----------

export function render(ctx) {
  view = ctx.view;
  readQuery(ctx.query);
  openedHere = false;
  view.innerHTML = `
    <header class="page-head">
      <div>
        <h1>Показатели <span class="muted" id="m-count"></span></h1>
        <p class="sub">Последние значения и динамика всех анализов и замеров. Нажми на строку — откроется график и история.</p>
      </div>
    </header>
    <div class="toolbar">
      <div class="seg" id="m-filter"></div>
      <label class="search-inline">${icon('search', 16)}<input id="m-q" type="search" placeholder="Найти показатель…" autocomplete="off" value="${esc(state.q)}"></label>
      <div class="seg toolbar-end" id="m-view"></div>
    </div>
    <div class="cat-nav" id="m-cats"></div>
    <div id="m-body"></div>
    <p class="page-note">${FLAGS.H.mark} выше нормы · ${FLAGS.L.mark} ниже · ${FLAGS.A.mark} отклонение. Нормы — из бланков лабораторий. Если лаборатория даёт только оценку «в норме / вне нормы», чисел нормы нет.</p>`;

  renderToolbar();
  renderBody();
  syncDrawer();

  $('.toolbar', view).addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]')?.dataset.f;
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (!f && !v) return;
    if (f) state.f = f;
    if (v) state.v = v;
    history.replaceState(null, '', hashFor());
    renderToolbar();
    renderBody();
  });
  $('#m-q', view).addEventListener('input', (e) => {
    state.q = e.target.value;
    history.replaceState(null, '', hashFor());
    renderBody();
  });
  $('#m-cats', view).addEventListener('click', (e) => {
    const cat = e.target.closest('[data-jump]')?.dataset.jump;
    if (cat) $(`.m-section[data-cat="${CSS.escape(cat)}"]`, view)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const body = $('#m-body', view);
  const open = (row) => {
    openedHere = !state.m;
    location.hash = hashFor({ m: row.dataset.test });
  };
  body.addEventListener('click', (e) => {
    const pin = e.target.closest('[data-pin]');
    if (pin) return void togglePin(pin.dataset.pin);
    const row = e.target.closest('.m-row');
    if (row) open(row);
  });
  body.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('m-row')) {
      e.preventDefault();
      open(e.target);
    }
  });
}

/** Тот же путь, поменялись только параметры (например, открыли другой показатель). */
export function update(ctx) {
  const before = { ...state };
  readQuery(ctx.query);
  if (before.f !== state.f || before.v !== state.v || before.q !== state.q) {
    renderToolbar();
    renderBody();
    $('#m-q', view).value = state.q;
  }
  syncDrawer();
}

export function leave() {
  state.m = '';
  syncDrawer();
}

/** Один раз при старте: панель и подложка живут в index.html. */
export function init() {
  drawer().addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return closeDrawer();
    const pin = e.target.closest('[data-pin]');
    if (pin) togglePin(pin.dataset.pin);
  });
  backdrop().addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.m && !document.querySelector('dialog[open]')) closeDrawer();
  });
}
