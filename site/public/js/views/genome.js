// Геном: что известно о вариантах в генах владельца.
// Геном не меняется, меняются знания о нём — поэтому страница устроена как справочник:
// таблица генов и тем по разделам, по клику — боковая панель с разбором и маркерами.
// Знания (что делает вариант) — общие; генотипы и оценки — из карты владельца.

import { $, $$, esc, icon, statusIcon, fmtDate, count, plural } from '../util.js';
import { store, who, caseById, genomeSeen, markGenomeSeen } from '../store.js';
import { empty, recordLink, caseLink, metricLink, genomeLink } from '../components.js';
import { hideTip } from '../charts.js';

const state = { f: 'main', q: '', g: '', s: false };
let view = null;
let openedHere = false; // панель открыта кликом на этой странице → закрываем через «назад»
let seenBefore = ''; // когда страницу открывали в прошлый раз — для отметки «новое»

const FILTERS = { main: 'Надёжные', all: 'Все', watch: 'На заметку' };
const GENOME_STATUS = { ok: 'без особенностей', watch: 'на заметку', action: 'нужно действие' };
const EVIDENCE = { высокая: 3, средняя: 2, низкая: 1 };
const DRUGS = 'Лекарства';

const genome = () => store.data.genome ?? { available: false, groups: [], findings: [] };

function readQuery(query) {
  state.f = FILTERS[query.get('f')] ? query.get('f') : 'main';
  state.q = query.get('q') ?? '';
  state.g = query.get('g') ?? '';
  state.s = query.get('s') === '1';
}

function hashFor(overrides = {}) {
  const s = { ...state, ...overrides };
  const params = new URLSearchParams();
  if (s.f !== 'main') params.set('f', s.f);
  if (s.q) params.set('q', s.q);
  if (s.s) params.set('s', '1');
  if (s.g) params.set('g', s.g);
  const qs = params.toString();
  return `#/genome${qs ? `?${qs}` : ''}`;
}

// ---------- кирпичики ----------

const statusPill = (status) =>
  GENOME_STATUS[status] ? `<span class="status">${statusIcon(status)}<span>${GENOME_STATUS[status]}</span></span>` : '';

/** Надёжность данных: три точки и слово — читается и без цвета. */
function evidenceMark(level) {
  const n = EVIDENCE[level] ?? 0;
  if (!n) return '';
  return `<span class="ev" title="Надёжность данных: ${esc(level)}"><span class="ev-dots" aria-hidden="true">${[1, 2, 3]
    .map((i) => `<i${i <= n ? ' class="on"' : ''}></i>`)
    .join('')}</span><span>${esc(level)}</span></span>`;
}

/** Генотип для чтения: «A/G»; одна буква — у маркеров на X, Y и митохондриальной ДНК. */
function genotypeText(gt) {
  if (!gt) return 'нет на чипе';
  if (gt.includes('-')) return 'не определён';
  return gt.length === 2 ? `${gt[0]}/${gt[1]}` : gt;
}

function copiesText(m) {
  const gt = m.genotype;
  if (!gt || gt.includes('-')) return '—';
  if (!m.effect_allele) {
    // Вставки и делеции читаются только в гетерозиготе: по сырому файлу нельзя понять, какая буква — норма.
    if (/^[DI]{2}$/.test(gt)) return gt[0] === gt[1] ? 'не найден' : 'одна';
    return gt.length === 2 && gt[0] !== gt[1] ? 'одна' : '—';
  }
  const n = Number(m.copies);
  if (gt.length === 1) return n ? 'есть' : 'нет';
  return ['нет', 'одна', 'две'][n] ?? '—';
}

/** Итог по группе: из оценки, а если её нет — по генотипам. */
function resultText(g) {
  if (g.note?.result) return g.note.result;
  if (g.markers.every((m) => !m.genotype)) return 'нет данных';
  const found = g.markers.some((m) => ['одна', 'две', 'есть'].includes(copiesText(m)));
  return found ? 'есть варианты — оценки пока нет' : 'вариантов нет — оценки пока нет';
}

const isStale = (g) => Boolean(g.note?.as_of && g.updated > g.note.as_of);
const isFresh = (g) => Boolean(seenBefore && g.updated > seenBefore);

function matches(g) {
  if (state.f === 'main' && g.evidence !== 'высокая') return false;
  if (state.f === 'watch' && !['watch', 'action'].includes(g.note?.status)) return false;
  const q = state.q.trim().toLowerCase();
  if (!q) return true;
  const hay = [g.title, g.group, g.section, g.drugs, g.note?.result, ...g.markers.flatMap((m) => [m.gene, m.rsid, m.variant])];
  return hay.join(' ').toLowerCase().includes(q);
}

const shown = () => genome().groups.filter((g) => matches(g) && (state.s || !g.sensitive));
const hiddenSensitive = () => genome().groups.filter((g) => g.sensitive && matches(g));

// ---------- страница ----------

function summaryCard() {
  const g = genome();
  const s = g.summary;
  const cv = s?.clinvar;
  const facts = [
    s?.markers ? `<span><b>${s.markers.toLocaleString('ru')}</b> маркеров${s.tests?.length > 1 ? ` в ${s.tests.length} тестах (${esc(s.tests.join(', '))})` : ' на чипе'}, определено ${((100 * s.called) / s.markers).toFixed(1)} %</span>` : '',
    s?.agreement?.compared ? `<span>тесты совпали на <b>${((100 * s.agreement.same) / s.agreement.compared).toFixed(2)} %</b> общих маркеров</span>` : '',
    cv?.plp ? `<span>чип видит <b>${((100 * cv.called) / cv.plp).toFixed(1)} %</b> известных патогенных вариантов</span>` : '',
    cv?.date ? `<span>ClinVar от ${esc(fmtDate(cv.date, 'short'))}</span>` : '',
    g.record ? `<a href="${recordLink(g.record)}">Полный отчёт</a>` : '',
  ].filter(Boolean);
  if (!g.text && !facts.length) return '';
  return `
    <section class="card g-summary">
      ${g.text ? `<p class="lead">${esc(g.text)}</p>` : ''}
      ${facts.length ? `<div class="g-facts">${facts.join('')}</div>` : ''}
    </section>`;
}

const REGION_NAMES = { EUR: 'Европа', EAS: 'Восточная Азия', SAS: 'Южная Азия', AFR: 'Африка южнее Сахары', AMR: 'Америка' };

/** Одна линия предков: гаплогруппа, оценка и рассказ о ветви от общего к частному. */
function lineBlock(title, hint, big, sub, line) {
  return `
    <div class="g-line">
      <div class="eyebrow">${title}</div>
      <div class="g-hg">${esc(big)}</div>
      <div class="hero-sub">${sub}</div>
      ${line.note ? `<p class="g-text g-line-note">${esc(line.note)}</p>` : ''}
      ${
        line.stories.length
          ? `<ol class="g-story">${line.stories.map((s) => `<li><b>${esc(s.name)}</b><span>${esc(s.story)}</span></li>`).join('')}</ol>`
          : ''
      }
      <p class="chart-note">${hint}</p>
    </div>`;
}

/** Происхождение: отцовская и материнская линии и грубая оценка по континентам. */
function originsCard() {
  const o = genome().origins;
  if (!o) return '';
  const y = o.y;
  const mt = o.mt;
  const c = o.continents;
  const pct = (v) => `${Math.round(100 * (v ?? 0))}`;
  const regions = c ? Object.keys(REGION_NAMES).filter((r) => (c.shares[r] ?? 0) >= 0.03 || (c.high[r] ?? 0) >= 0.25) : [];
  return `
    <section class="card g-origins">
      <div class="card-head">${icon('user', 18)}<h2>Происхождение</h2><span class="card-meta">две линии предков и грубая оценка по континентам</span></div>
      <div class="g-lines">
        ${
          y
            ? lineBlock(
                'Отцовская линия · Y-хромосома',
                `Передаётся от отца к сыну почти без изменений. Проверено маркеров: ${y.tested.toLocaleString('ru')}; на пути от корня ${y.derived} своих вариантов и ${y.conflicts} противоречий. Дерево — ${esc(y.tree)}.`,
                y.label,
                `${y.solid && y.solid.label !== y.label ? `надёжно до ${esc(y.solid.label)}, дальше — вероятная ветвь · ` : ''}полное имя ${esc(y.haplogroup)}`,
                y,
              )
            : ''
        }
        ${
          mt
            ? lineBlock(
                'Материнская линия · митохондриальная ДНК',
                `Передаётся от матери всем детям. Проверено позиций: ${mt.tested.toLocaleString('ru')}; найдено ${mt.found} из ${mt.expected} мутаций, ожидаемых для этой ветви. Дерево — ${esc(mt.tree)}.`,
                mt.haplogroup,
                'ветвь, к которой сходятся проверенные мутации',
                mt,
              )
            : ''
        }
      </div>
      ${
        c
          ? `<div class="g-continents">
              <div class="eyebrow">По континентам · ${c.markers} ${plural(c.markers, ['маркер', 'маркера', 'маркеров'])}</div>
              ${regions
                .map(
                  (r) => `<div class="g-region">
                    <span class="g-region-name">${REGION_NAMES[r]}</span>
                    <span class="meter" role="img" aria-label="${REGION_NAMES[r]}: ${pct(c.shares[r])} %"><span style="width:${pct(c.shares[r])}%"></span></span>
                    <span class="g-region-val"><b>${pct(c.shares[r])} %</b> <span class="muted">от ${pct(c.low[r])} до ${pct(c.high[r])}</span></span>
                  </div>`,
                )
                .join('')}
              ${c.note ? `<p class="g-text g-line-note">${esc(c.note)}</p>` : ''}
              <p class="chart-note">Оценка грубая: ${c.markers} маркеров различают только континенты, а диапазон показывает, насколько результат меняется от набора маркеров. У сервиса, где вы сдавали тест, оценка точнее — он использует сотни тысяч маркеров.</p>
            </div>`
          : ''
      }
      <p class="card-note">Гаплогруппа — это одна линия из тысяч ваших предков: отец отца отца… или мать матери матери… Она рассказывает о путях этой линии за тысячи лет, но не о том, «кто вы по происхождению».</p>
    </section>`;
}

/** Памятка по лекарствам: только гены с особенностями — то, что стоит показать врачу. */
function drugCard() {
  const drugs = genome().groups.filter((g) => g.section === DRUGS);
  if (!drugs.length) return '';
  const notable = drugs.filter((g) => ['watch', 'action'].includes(g.note?.status));
  const plain = drugs.filter((g) => g.note?.status === 'ok').length;
  return `
    <section class="card g-drugs">
      <div class="card-head">${icon('pill', 18)}<h2>Памятка по лекарствам</h2><span class="card-meta">для врача, который назначает лекарство</span></div>
      ${
        notable.length
          ? `<div class="rows">${notable
              .map(
                (g) => `
              <a class="g-drug" href="${genomeLink(g.group)}">
                <div class="g-drug-gene"><b>${esc(g.title)}</b><span>${esc(resultText(g))}</span></div>
                <div class="g-drug-text">
                  ${g.drugs ? `<div class="g-drug-list">${esc(g.drugs)}</div>` : ''}
                  ${g.note?.advice ? `<div>${esc(g.note.advice)}</div>` : ''}
                </div>
              </a>`,
              )
              .join('')}</div>`
          : '<p class="card-note">Особенностей, которые стоит учитывать при назначении лекарств, не найдено.</p>'
      }
      <p class="card-note">${plain ? `Ещё ${count(plain, ['ген', 'гена', 'генов'])} — без особенностей. ` : ''}Сами дозы не меняйте: это решает врач, а результат перед этим подтверждают клиническим тестом.</p>
    </section>`;
}

function sectionTable(section, groups) {
  const locked = groups.some((g) => g.sensitive);
  return `
    <section class="m-section" data-cat="${esc(section)}">
      <h2>${esc(section)} <span>${groups.length}</span>${locked ? ` ${icon('lock', 13, 'g-lock')}` : ''}</h2>
      <div class="table-wrap"><table class="data g-table">
        <thead><tr><th>Ген или тема</th><th>Результат</th><th>Оценка</th><th>Данные</th><th>Знания от</th></tr></thead>
        <tbody>${groups
          .map(
            (g) => `
            <tr class="m-row" data-group="${esc(g.group)}" tabindex="0" role="button" aria-label="${esc(g.title)} — открыть разбор">
              <td class="m-name">${esc(g.title)}</td>
              <td>${esc(resultText(g))}</td>
              <td class="nowrap">${statusPill(g.note?.status) || '<span class="muted small">—</span>'}</td>
              <td>${evidenceMark(g.evidence)}</td>
              <td class="muted nowrap">${esc(fmtDate(g.updated, 'short'))}${isFresh(g) ? ' <span class="new">новое</span>' : ''}${
                isStale(g) ? `<span class="m-age">оценку пора обновить</span>` : ''
              }</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </section>`;
}

/** Совпадения с ClinVar: редкие находки, каждая с оценкой правдоподобия. Показываем вместе с чувствительными темами. */
function clinvarCard() {
  const g = genome();
  const cv = g.summary?.clinvar;
  if (!cv) return '';
  const head = `
    <div class="card-head">${icon('search', 18)}<h2>Сверка с базой ClinVar</h2><span class="card-meta">все известные клинически значимые варианты</span></div>
    <p class="lead">Из ${cv.plp.toLocaleString('ru')} известных патогенных вариантов чип умеет читать ${cv.called.toLocaleString('ru')}. Совпадений с геномом — ${cv.pathogenic}.</p>`;
  const foot = '<p class="card-note">Редкие «патогенные» находки в сырых данных часто ложные: чип хуже всего читает вставки и делеции. Действовать можно только после клинического теста.</p>';
  if (!g.findings.length) return `<section class="card g-clinvar">${head}${foot}</section>`;
  if (!state.s) {
    return `<section class="card g-clinvar">${head}<p class="card-note">Совпадения скрыты вместе с чувствительными темами. <button class="link-btn" type="button" data-sensitive="1">Показать</button></p></section>`;
  }
  return `
    <section class="card g-clinvar">${head}
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Ген</th><th>Вариант</th><th>Что это по ClinVar</th><th>Оценка</th></tr></thead>
        <tbody>${g.findings
          .map(
            (f) => `<tr>
              <td class="m-name nowrap">${esc(f.gene)}</td>
              <td class="nowrap">${esc(f.marker)}<small>${esc(genotypeText(f.genotype))}</small></td>
              <td>${esc(f.condition.split('|').filter((c) => c && c !== 'not provided' && c !== 'not specified')[0] ?? '—')}</td>
              <td>${f.verdict ? `<b>${esc(f.verdict)}</b>` : '<span class="muted">не оценено</span>'}${f.note ? `<small class="g-note">${esc(f.note)}</small>` : ''}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>
      ${foot}
    </section>`;
}

function renderBody() {
  const groups = shown();
  const hidden = state.s ? [] : hiddenSensitive();
  const sections = [...new Set(groups.map((g) => g.section))];
  $('#g-count', view).textContent = groups.length;
  $('#g-cats', view).innerHTML =
    sections.length > 1 ? sections.map((c) => `<button class="cat-chip" type="button" data-jump="${esc(c)}">${esc(c)}</button>`).join('') : '';
  const lock = hidden.length
    ? `<div class="callout callout-done g-hidden">${icon('lock', 18)}<div><b>Чувствительные темы скрыты — ${hidden.length}</b>
        <p>Риск болезни Альцгеймера и Паркинсона, наследственный рак, носительство. Такое знание нельзя «раззнать», поэтому оно открывается только по вашему решению.
        <button class="link-btn" type="button" data-sensitive="1">Показать</button></p></div></div>`
    : state.s
      ? `<p class="page-note g-hidden">Чувствительные темы показаны. <button class="link-btn" type="button" data-sensitive="0">Скрыть</button></p>`
      : '';
  const body = groups.length
    ? sections.map((c) => sectionTable(c, groups.filter((g) => g.section === c))).join('')
    : empty('Ничего не нашлось', state.q ? `По запросу «${esc(state.q)}» ничего нет.` : 'Под этот фильтр ничего не подходит.');
  $('#g-body', view).innerHTML = `${body}${lock}`;
  $('#g-clinvar', view).innerHTML = clinvarCard();
}

function renderToolbar() {
  const all = genome().groups.filter((g) => state.s || !g.sensitive);
  const counts = {
    main: all.filter((g) => g.evidence === 'высокая').length,
    all: all.length,
    watch: all.filter((g) => ['watch', 'action'].includes(g.note?.status)).length,
  };
  $('#g-filter', view).innerHTML = Object.entries(FILTERS)
    .map(([key, label]) => `<button class="seg-btn${state.f === key ? ' on' : ''}" type="button" data-f="${key}">${label} <span>${counts[key]}</span></button>`)
    .join('');
}

// ---------- боковая панель ----------

const drawer = () => document.getElementById('drawer');
const backdrop = () => document.getElementById('drawer-backdrop');

function renderDrawer(g) {
  const note = g.note;
  const cases = (note?.cases ?? []).map((id) => caseById(id)).filter(Boolean);
  const metrics = (note?.metrics ?? []).filter((name) => store.tests.has(name));
  const stale = isStale(g);
  const coverage = g.coverage.filter((c) => c.known >= 20);
  drawer().innerHTML = `
    <header class="drawer-head">
      <div>
        <div class="eyebrow">${esc(g.section)}</div>
        <h2 id="drawer-title">${esc(g.title)}</h2>
      </div>
      <div class="drawer-actions">
        <button class="icon-btn" type="button" data-close aria-label="Закрыть">${icon('x', 18)}</button>
      </div>
    </header>
    <div class="drawer-body">
      <div class="g-hero">${esc(resultText(g))}</div>
      <div class="hero-sub">${evidenceMark(g.evidence)} · знания от ${esc(fmtDate(g.updated, 'short'))}</div>

      ${g.about ? `<div class="about"><h3>Что это</h3><p>${esc(g.about)}</p></div>` : ''}
      ${
        note?.assessment
          ? `<div class="assess${note.status ? ` assess-${note.status}` : ''}">
              <div class="assess-head"><h3>Оценка ${esc(who('gen'))}</h3>${statusPill(note.status)}</div>
              <p>${esc(note.assessment)}</p>
              <div class="assess-foot">${
                stale
                  ? `${icon('clock', 13)}<span>Знания об этом гене обновились ${esc(fmtDate(g.updated, 'short'))}, а оценка написана раньше. Попроси ${esc(who('gen'))} её пересмотреть.</span>`
                  : `<span>${note.as_of ? `По знаниям на ${esc(fmtDate(note.as_of, 'short'))} · ` : ''}толкование, не диагноз</span>`
              }</div>
            </div>`
          : `<p class="chart-note">Оценки пока нет — ${esc(who('nom'))} добавит её при разборе генома.</p>`
      }

      ${
        g.drugs || note?.advice
          ? `<div class="drawer-block">
              ${g.drugs ? `<h3>Каких лекарств касается</h3><p class="g-text">${esc(g.drugs)}</p>` : ''}
              ${note?.advice ? `<h3 class="g-h3">Что обычно делают врачи</h3><p class="g-text">${esc(note.advice)}</p>` : ''}
            </div>`
          : ''
      }

      <div class="drawer-block">
        <h3>Маркеры <span class="muted">${g.markers.length}</span></h3>
        <div class="table-wrap"><table class="data g-markers">
          <thead><tr><th>Вариант</th><th>Генотип</th><th>Копий</th><th>Что делает вариант</th></tr></thead>
          <tbody>${g.markers
            .map(
              (m) => `<tr>
                <td><b>${esc(m.gene)}</b> ${esc(m.variant)}<small>${esc(m.rsid)}${m.effect_allele ? ` · аллель ${esc(m.effect_allele)}` : ''}</small></td>
                <td class="nowrap">${esc(genotypeText(m.genotype))}${m.sources ? `<small>${esc(m.sources)}</small>` : ''}</td>
                <td class="nowrap">${esc(copiesText(m))}</td>
                <td>${esc(m.effect)}<small>${esc(m.source)}${m.evidence !== g.evidence ? ` · данные: ${esc(m.evidence)}` : ''}</small></td>
              </tr>`,
            )
            .join('')}</tbody>
        </table></div>
        <p class="chart-note">«Копий» — сколько копий варианта с указанным аллелем у вас. Генотип дан так, как записан в сыром файле.</p>
        ${coverage
          .map(
            (c) =>
              `<p class="chart-note">Ген ${esc(c.gene)}: чип видит ${c.onChip} из ${c.known.toLocaleString('ru')} известных патогенных ${plural(c.known, ['варианта', 'вариантов', 'вариантов'])} — «не найдено» не значит «исключено».</p>`,
          )
          .join('')}
      </div>

      ${
        metrics.length
          ? `<div class="drawer-block"><h3>Связанные показатели</h3><div class="chips">${metrics
              .map((name) => `<a class="chip chip-link" href="${metricLink(name)}">${esc(name)}</a>`)
              .join('')}</div></div>`
          : ''
      }
      ${
        cases.length
          ? `<div class="drawer-block"><h3>Относится к кейсам</h3><div class="chips">${cases
              .map((c) => `<a class="chip chip-link" href="${caseLink(c.id)}">${esc(c.title)}</a>`)
              .join('')}</div></div>`
          : ''
      }
    </div>`;
}

function syncDrawer() {
  const g = state.g ? genome().groups.find((x) => x.group === state.g) : null;
  const el = drawer();
  hideTip();
  if (!g) {
    el.hidden = true;
    backdrop().hidden = true;
    document.body.classList.remove('drawer-open');
    return;
  }
  renderDrawer(g);
  const wasHidden = el.hidden;
  el.hidden = false;
  backdrop().hidden = false;
  document.body.classList.add('drawer-open');
  if (wasHidden) $('[data-close]', el).focus({ preventScroll: true });
  for (const row of $$('.m-row', view)) row.classList.toggle('selected', row.dataset.group === state.g);
}

function closeDrawer() {
  if (!state.g) return;
  if (openedHere) {
    openedHere = false;
    history.back();
  } else {
    location.replace(hashFor({ g: '' }));
  }
}

// ---------- сборка страницы ----------

export function render(ctx) {
  view = ctx.view;
  readQuery(ctx.query);
  openedHere = false;
  seenBefore = genomeSeen();
  markGenomeSeen();

  if (!genome().available) {
    view.innerHTML = `
      <header class="page-head"><div><h1>Геном</h1></div></header>
      ${empty(
        'Генома в карте пока нет',
        `Если у вас есть сырые данные ДНК-теста (например 23andMe), положите файл во «Входящие» и скажите ${esc(who('dat'))} «разбери геном». Всё считается на этом компьютере, файл никуда не отправляется.`,
      )}`;
    syncDrawer();
    return;
  }

  view.innerHTML = `
    <header class="page-head">
      <div>
        <h1>Геном <span class="muted" id="g-count"></span></h1>
        <p class="sub">Что известно о вариантах в ваших генах. Геном не меняется — меняются знания о нём, поэтому оценки здесь со временем уточняются. Нажми на строку — откроется разбор.</p>
      </div>
    </header>
    ${summaryCard()}
    ${drugCard()}
    ${originsCard()}
    <div id="g-page">
    <div class="toolbar">
      <div class="seg" id="g-filter"></div>
      <label class="search-inline">${icon('search', 16)}<input id="g-q" type="search" placeholder="Ген, маркер, лекарство…" autocomplete="off" value="${esc(state.q)}"></label>
    </div>
    <div class="cat-nav" id="g-cats"></div>
    <div id="g-body"></div>
    <div id="g-clinvar"></div>
    </div>
    <p class="page-note">«Надёжные» — варианты из клинических рекомендаций и проверенных отчётов. Остальные сдвигают показатель или риск совсем немного. Чип — пластинка ДНК-теста: она читает не весь геном, а заранее выбранные точки, поэтому «варианта нет» не значит «риска нет». Это толкование, не диагноз и не клинический тест.</p>`;

  renderToolbar();
  renderBody();
  syncDrawer();

  $('.toolbar', view).addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (!f) return;
    state.f = f;
    history.replaceState(null, '', hashFor());
    renderToolbar();
    renderBody();
  });
  $('#g-q', view).addEventListener('input', (e) => {
    state.q = e.target.value;
    history.replaceState(null, '', hashFor());
    renderBody();
  });
  $('#g-cats', view).addEventListener('click', (e) => {
    const cat = e.target.closest('[data-jump]')?.dataset.jump;
    if (cat) $(`.m-section[data-cat="${CSS.escape(cat)}"]`, view)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const open = (row) => {
    openedHere = !state.g;
    location.hash = hashFor({ g: row.dataset.group });
  };
  // Страница перерисовывается целиком, поэтому обработчики вешаем на её собственный контейнер.
  const page = $('#g-page', view);
  page.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-sensitive]');
    if (toggle) {
      state.s = toggle.dataset.sensitive === '1';
      history.replaceState(null, '', hashFor());
      renderToolbar();
      renderBody();
      return;
    }
    const row = e.target.closest('.m-row');
    if (row) open(row);
  });
  page.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('m-row')) {
      e.preventDefault();
      open(e.target);
    }
  });
}

/** Тот же путь, поменялись только параметры (например, открыли другой ген). */
export function update(ctx) {
  const before = { ...state };
  readQuery(ctx.query);
  if (!genome().available) return;
  if (before.f !== state.f || before.q !== state.q || before.s !== state.s) {
    renderToolbar();
    renderBody();
    $('#g-q', view).value = state.q;
  }
  syncDrawer();
}

export function leave() {
  state.g = '';
  syncDrawer();
}

/** Один раз при старте: панель и подложка общие с «Показателями» и живут в index.html. */
export function init() {
  drawer().addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeDrawer();
  });
  backdrop().addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.g && !document.querySelector('dialog[open]')) closeDrawer();
  });
}
