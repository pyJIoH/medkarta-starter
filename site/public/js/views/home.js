// Обзор: кто я, как дела сейчас, что требует внимания, что дальше.

import { $, esc, icon, fmtDate, relTime, age, count, fmtNum, num } from '../util.js';
import { store, sortedCases, flaggedTests, upcomingPlan } from '../store.js';
import {
  statusPill, valueHtml, metricTile, recordRow, caseRow, planRow, systemsBlock, empty,
  metricLink, recordLink, bindPlan,
} from '../components.js';

function lastOf(name) {
  return store.tests.get(name)?.last;
}

function header() {
  const d = store.data;
  const p = d.profile;
  const years = age(p.born, d.today);
  const weightRow = lastOf('Вес');
  const weight = weightRow ? num(weightRow.value) : num(p.weight_kg);
  const height = num(p.height_cm);
  const bmi = weight && height ? weight / (height / 100) ** 2 : null;
  const sys = lastOf('АД систолическое');
  const dia = lastOf('АД диастолическое');
  const bp = sys && dia && sys.date === dia.date ? { text: `${sys.value}/${dia.value}`, date: sys.date } : null;

  const stat = (label, value, unit, sub, href) => {
    const inner = `<dt>${label}</dt><dd>${value}${unit ? `<span>${unit}</span>` : ''}</dd>${sub ? `<small>${sub}</small>` : ''}`;
    return href ? `<a class="me-stat" href="${href}">${inner}</a>` : `<div class="me-stat">${inner}</div>`;
  };

  const facts = [
    years != null ? count(years, ['год', 'года', 'лет']) : '',
    p.blood_type ? `группа крови ${esc(p.blood_type)}` : '',
  ].filter(Boolean);

  return `
    <header class="me">
      <div class="me-id">
        <div class="me-avatar" aria-hidden="true">${esc(String(p.name ?? '?').slice(0, 1))}</div>
        <div>
          <h1>${esc(p.name ?? 'Обзор')}</h1>
          <div class="me-sub">${[...facts, '<a href="#/profile">профиль</a>'].join(' · ')}</div>
        </div>
      </div>
      <dl class="me-stats">
        ${height ? stat('Рост', fmtNum(height, 1), 'см', '', '') : ''}
        ${weight ? stat('Вес', fmtNum(weight, 1), 'кг', weightRow ? esc(fmtDate(weightRow.date, 'short')) : '', metricLink('Вес')) : ''}
        ${bmi ? stat('ИМТ', fmtNum(bmi, 1), '', 'вес / рост²', metricLink('ИМТ')) : ''}
        ${bp ? stat('Давление', esc(bp.text), '', esc(fmtDate(bp.date, 'short')), metricLink('АД систолическое')) : ''}
      </dl>
    </header>`;
}

function stateCard() {
  const summary = store.data.records.find((r) => r.type === 'summary');
  if (!summary) {
    return `<section class="card span-2"><div class="card-head"><h2>Состояние</h2></div>${empty('Сводки пока нет', 'Попроси ассистента: <code>сделай сводку</code>.')}</section>`;
  }
  return `
    <section class="card span-2">
      <div class="card-head">
        <h2>Состояние</h2>
        <span class="card-meta">сводка от ${esc(fmtDate(summary.date, 'short'))}</span>
        <span class="card-end">${statusPill(summary.status)}</span>
      </div>
      <p class="lead">${esc(summary.summary)}</p>
      ${systemsBlock(summary.systems)}
      <a class="card-link" href="${recordLink(summary.id)}">Открыть сводку целиком ${icon('arrow-right', 14)}</a>
    </section>`;
}

function planCard() {
  const items = upcomingPlan();
  return `
    <section class="card" id="plan-card">
      <div class="card-head"><h2>Ближайшее</h2><a class="card-end" href="#/plan">Весь план</a></div>
      ${items.length ? `<div class="plan-list">${items.slice(0, 4).map(planRow).join('')}</div>` : empty('План пуст')}
    </section>`;
}

function casesCard() {
  const open = sortedCases('open');
  const closed = sortedCases('closed').length;
  return `
    <section class="card span-2">
      <div class="card-head"><h2>Активные кейсы</h2><span class="card-count">${open.length}</span><a class="card-end" href="#/cases">Все кейсы</a></div>
      ${
        open.length
          ? `<div class="rows">${open.map(caseRow).join('')}</div>`
          : closed
            ? empty('Активных кейсов нет', 'Всё, за чем наблюдали, закрыто.')
            : empty('Кейсов пока нет', 'Расскажи ассистенту, что беспокоит, — он заведёт кейс.')
      }
      ${closed ? `<a class="card-link" href="#/cases?s=closed">Закрытых — ${closed} ${icon('arrow-right', 14)}</a>` : ''}
    </section>`;
}

function flaggedCard() {
  const flagged = flaggedTests();
  const today = store.data.today;
  const rows = flagged.slice(0, 7).map(
    (t) => `
      <a class="flag-row" href="${metricLink(t.name)}">
        <span class="flag-name">${esc(t.name)}</span>
        <span class="flag-val">${valueHtml(t.last)}</span>
        <span class="flag-age">${esc(relTime(t.last.date, today))}</span>
      </a>`,
  );
  return `
    <section class="card">
      <div class="card-head"><h2>Вне нормы</h2><span class="card-count">${flagged.length}</span><a class="card-end" href="#/metrics?f=flagged">Все</a></div>
      ${flagged.length ? `<div class="rows">${rows.join('')}</div>` : empty(store.tests.size ? 'Все показатели в норме' : 'Показателей пока нет')}
      <p class="card-note">По последнему замеру каждого показателя.</p>
    </section>`;
}

function pinnedCard() {
  const tests = store.data.pinned.map((name) => store.tests.get(name)).filter(Boolean);
  return `
    <section class="card flat span-3">
      <div class="card-head"><h2>Ключевые показатели</h2><a class="card-end" href="#/metrics">Все показатели</a></div>
      ${
        tests.length
          ? `<div class="tiles">${tests.map(metricTile).join('')}</div>`
          : empty('Ничего не закреплено', 'Открой любой показатель и нажми звёздочку — он появится здесь.')
      }
    </section>`;
}

function recentCard() {
  const recent = store.data.records.filter((r) => r.type !== 'summary').slice(0, 5);
  return `
    <section class="card span-3">
      <div class="card-head"><h2>Последние записи</h2><a class="card-end" href="#/records">Все записи</a></div>
      ${recent.length ? `<div class="rows">${recent.map(recordRow).join('')}</div>` : empty('Записей пока нет')}
    </section>`;
}

export function render({ view }) {
  const inbox = store.data.inbox.length;
  view.innerHTML = `
    ${header()}
    ${
      store.data.profile.name
        ? ''
        : `<div class="banner">${icon('user', 18)}<span>Карта ещё не настроена. Открой эту папку в своём ИИ-ассистенте и напиши: <code>начни настройку</code></span></div>`
    }
    ${
      inbox
        ? `<a class="banner" href="#/inbox">${icon('inbox', 18)}<span>Во входящих ${count(inbox, ['файл', 'файла', 'файлов'])} — скажи ассистенту: <code>разбери inbox</code></span></a>`
        : ''
    }
    <div class="dash">
      ${stateCard()}
      ${planCard()}
      ${casesCard()}
      ${flaggedCard()}
      ${pinnedCard()}
      ${recentCard()}
    </div>`;
  bindPlan($('#plan-card', view), () => render({ view }));
}
