// Графики на чистом SVG: спарклайн, линейный график с зоной нормы, столбики по месяцам.
// Правила: тонкие линии, точки с «кольцом» цвета фона, подписи только там, где нужны,
// значения всегда доступны и без наведения — в таблице истории рядом.

import { esc, fmtNum, fmtDate, MONTHS_SHORT, FLAGS } from './util.js';

// ---------- всплывающая подсказка (одна на всё приложение) ----------

let tip;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text; // textContent: подписи приходят из CSV
  return node;
}

export function showTip(x, y, build) {
  if (!tip) {
    tip = el('div', 'viz-tip');
    tip.setAttribute('role', 'status');
    document.body.appendChild(tip);
  }
  tip.replaceChildren();
  build(tip);
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 14;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  let top = y - r.height - 12;
  if (top < 8) top = y + 18;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${top}px`;
}

export function hideTip() {
  if (tip) tip.hidden = true;
}

// ---------- шкалы ----------

function niceTicks(min, max, target = 4) {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push(+v.toFixed(10));
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  return { lo, hi, ticks, fmt: (v) => v.toFixed(digits) };
}

const shortDate = (t) => {
  const d = new Date(t);
  return `${MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
};

// ---------- спарклайн ----------

/** Маленькая линия динамики: серая, последняя точка — акцентом (или цветом предупреждения). */
export function sparkline(points, { w = 96, h = 28, flag = '' } = {}) {
  if (points.length < 2) return '';
  const ts = points.map((p) => p.t);
  const vs = points.map((p) => p.v);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const x = (t) => (t1 === t0 ? w / 2 : 4 + ((t - t0) / (t1 - t0)) * (w - 8));
  const y = (v) => (hi === lo ? h / 2 : h - 4 - ((v - lo) / (hi - lo)) * (h - 8));
  const line = points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = points.at(-1);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <polyline class="spark-line" points="${line}"/>
    <circle class="spark-dot${flag ? ' flagged' : ''}" cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="3.2"/></svg>`;
}

// ---------- линейный график ----------

const W = 640;
const H = 240;

/**
 * series: [{ name, short, color, points: [{ t, v, flag, row }] }]
 * band:   { low, high } — зона нормы из бланка (любая граница может отсутствовать)
 * target: { value, label } — цель: пунктир с подписью (пунктир здесь уместен — это порог, а не сетка)
 */
export function lineChart(root, { series, band = null, target = null, unit = '', title = '' }) {
  series = series.filter((s) => s.points.length);
  root.replaceChildren();
  if (!series.length) return;

  const multi = series.length > 1;
  const m = { l: 46, r: multi ? 96 : 58, t: 18, b: 30 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;

  const ts = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
  const t0 = ts[0];
  const t1 = ts.at(-1);
  const x = (t) => (t0 === t1 ? m.l + pw / 2 : m.l + ((t - t0) / (t1 - t0)) * pw);

  const vals = series.flatMap((s) => s.points.map((p) => p.v));
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const bandLow = band && Number.isFinite(band.low) ? band.low : null;
  const bandHigh = band && Number.isFinite(band.high) ? band.high : null;
  // Каждая граница нормы должна попасть на шкалу — иначе при односторонней норме («до 100»),
  // когда все замеры выше неё, зона окажется за пределами графика.
  for (const edge of [bandLow, bandHigh]) {
    if (edge == null) continue;
    lo = Math.min(lo, edge);
    hi = Math.max(hi, edge);
  }
  if (target) {
    lo = Math.min(lo, target.value);
    hi = Math.max(hi, target.value);
  }
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
  const scale = niceTicks(lo >= 0 ? Math.max(0, lo - pad) : lo - pad, hi + pad);
  const y = (v) => m.t + ph - ((v - scale.lo) / (scale.hi - scale.lo)) * ph;

  let svg = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`;

  // Зона нормы — спокойная заливка под данными.
  if (bandLow != null || bandHigh != null) {
    const top = bandHigh != null ? y(bandHigh) : m.t;
    const bottom = bandLow != null ? y(bandLow) : m.t + ph;
    svg += `<rect class="band" x="${m.l}" y="${top}" width="${pw}" height="${Math.max(0, bottom - top)}"/>`;
    for (const edge of [bandLow, bandHigh]) {
      if (edge != null) svg += `<line class="band-edge" x1="${m.l}" x2="${m.l + pw}" y1="${y(edge)}" y2="${y(edge)}"/>`;
    }
    if (bottom - top >= 18) svg += `<text class="band-label" x="${m.l + 7}" y="${top + 13}">норма</text>`;
  }

  // Сетка и подписи оси Y.
  for (const tick of scale.ticks) {
    svg += `<line class="grid" x1="${m.l}" x2="${m.l + pw}" y1="${y(tick)}" y2="${y(tick)}"/>`;
    svg += `<text class="tick" x="${m.l - 8}" y="${y(tick) + 4}" text-anchor="end">${scale.fmt(tick)}</text>`;
  }
  svg += `<line class="axis" x1="${m.l}" x2="${m.l + pw}" y1="${m.t + ph}" y2="${m.t + ph}"/>`;

  // Ось X: засечка на каждый замер, подписи — где помещаются (последний замер важнее).
  let lastLabelX = Infinity;
  for (const t of [...ts].reverse()) {
    svg += `<line class="axis" x1="${x(t)}" x2="${x(t)}" y1="${m.t + ph}" y2="${m.t + ph + 4}"/>`;
    if (lastLabelX - x(t) >= 56) {
      svg += `<text class="tick" x="${x(t)}" y="${H - 8}" text-anchor="middle">${shortDate(t)}</text>`;
      lastLabelX = x(t);
    }
  }

  if (target) {
    svg += `<line class="target-line" x1="${m.l}" x2="${m.l + pw}" y1="${y(target.value)}" y2="${y(target.value)}"/>`;
    svg += `<text class="target-label" x="${m.l + 7}" y="${y(target.value) - 6}">${esc(target.label)}</text>`;
  }

  // Линии и точки.
  for (const [si, s] of series.entries()) {
    const path = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    svg += `<path class="line" d="${path}" style="stroke:${s.color}"/>`;
    for (const p of s.points) {
      svg += `<circle class="point${p.flag ? ' flagged' : ''}" data-t="${p.t}" data-s="${si}" cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4.5" style="fill:${p.flag ? 'var(--warn)' : s.color}"/>`;
    }
  }

  // Подписи: конец каждой линии; для одной серии — ещё максимум и минимум, если они не на конце.
  for (const s of series) {
    const last = s.points.at(-1);
    svg += `<text class="end-label" x="${x(last.t) + 10}" y="${y(last.v) + 4}">${fmtNum(last.v)}${multi ? ` <tspan class="end-name">${esc(s.short ?? s.name)}</tspan>` : ''}</text>`;
  }
  if (!multi && series[0].points.length >= 3) {
    const pts = series[0].points;
    const last = pts.at(-1);
    const max = pts.reduce((a, b) => (b.v > a.v ? b : a));
    const min = pts.reduce((a, b) => (b.v < a.v ? b : a));
    if (max !== last) svg += `<text class="point-label" x="${x(max.t)}" y="${y(max.v) - 10}" text-anchor="middle">${fmtNum(max.v)}</text>`;
    if (min !== last && min !== max) svg += `<text class="point-label" x="${x(min.t)}" y="${y(min.v) + 18}" text-anchor="middle">${fmtNum(min.v)}</text>`;
  }

  svg += `<line class="crosshair" y1="${m.t}" y2="${m.t + ph}" x1="0" x2="0" visibility="hidden"/>`;
  svg += `<rect class="hit" x="${m.l - 12}" y="${m.t - 8}" width="${pw + 24}" height="${ph + 16}" fill="transparent"/></svg>`;

  if (multi) {
    const legend = el('div', 'legend');
    for (const s of series) {
      const item = el('span', 'legend-item');
      const key = el('i', 'legend-line');
      key.style.background = s.color;
      item.append(key, el('span', '', s.name));
      legend.append(item);
    }
    root.append(legend);
  }
  const holder = el('div', 'chart');
  holder.innerHTML = svg;
  holder.tabIndex = 0;
  holder.setAttribute('aria-label', `${title}. Стрелки влево и вправо — перемещение по замерам.`);
  root.append(holder);

  // ---- наведение: вертикальная линия прилипает к ближайшему замеру, подсказка показывает все серии
  const svgEl = holder.firstElementChild;
  const cross = svgEl.querySelector('.crosshair');
  const points = [...svgEl.querySelectorAll('.point')];
  let active = -1;

  function setActive(i) {
    active = i;
    for (const c of points) c.classList.toggle('active', i >= 0 && Number(c.dataset.t) === ts[i]);
    if (i < 0) {
      cross.setAttribute('visibility', 'hidden');
      hideTip();
      return;
    }
    const t = ts[i];
    cross.setAttribute('x1', x(t));
    cross.setAttribute('x2', x(t));
    cross.setAttribute('visibility', 'visible');
    const box = svgEl.getBoundingClientRect();
    const hits = series.map((s) => ({ s, p: s.points.find((p) => p.t === t) })).filter((h) => h.p);
    // Подсказка встаёт над областью графика, чтобы не закрывать соседние точки.
    showTip(box.left + (x(t) / W) * box.width, box.top + (m.t / H) * box.height, (tipRoot) => {
      tipRoot.append(el('div', 'tip-title', fmtDate(hits[0].p.row.date, 'short')));
      for (const { s, p } of hits) {
        const row = el('div', 'tip-row');
        const key = el('i', 'tip-key');
        key.style.background = s.color;
        row.append(key, el('b', '', `${p.row.value}${unit ? ` ${unit}` : ''}`));
        if (multi) row.append(el('span', 'tip-name', s.name));
        if (p.flag) row.append(el('span', 'tip-flag', `${FLAGS[p.flag].mark} ${FLAGS[p.flag].label}`));
        tipRoot.append(row);
      }
      if (!multi && hits[0].p.row.lab) tipRoot.append(el('div', 'tip-sub', hits[0].p.row.lab));
    });
  }

  svgEl.querySelector('.hit').addEventListener('pointermove', (e) => {
    const box = svgEl.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < ts.length; i++) if (Math.abs(x(ts[i]) - vx) < Math.abs(x(ts[best]) - vx)) best = i;
    if (best !== active) setActive(best);
  });
  svgEl.addEventListener('pointerleave', () => setActive(-1));
  holder.addEventListener('focus', () => setActive(ts.length - 1));
  holder.addEventListener('blur', () => setActive(-1));
  holder.addEventListener('keydown', (e) => {
    const next = { ArrowLeft: active - 1, ArrowRight: active + 1, Home: 0, End: ts.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    setActive(Math.min(ts.length - 1, Math.max(0, next)));
  });
}

// ---------- столбики по месяцам (эпизоды) ----------

/** months: [{ key: '2026-07', count }] — подряд, от старых к новым. */
export function monthColumns(root, months, forms) {
  const CW = 640;
  const CH = 128;
  const m = { l: 6, r: 6, t: 20, b: 34 };
  const pw = CW - m.l - m.r;
  const ph = CH - m.t - m.b;
  const slot = pw / months.length;
  const bw = Math.min(24, slot * 0.55);
  const max = Math.max(1, ...months.map((mo) => mo.count));
  const base = m.t + ph;

  let svg = `<svg class="chart-svg" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Эпизоды по месяцам">`;
  svg += `<line class="axis" x1="${m.l}" x2="${m.l + pw}" y1="${base}" y2="${base}"/>`;
  months.forEach((mo, i) => {
    const cx = m.l + slot * (i + 0.5);
    const [yy, mm] = mo.key.split('-').map(Number);
    if (mo.count > 0) {
      const top = base - (mo.count / max) * ph;
      const x0 = cx - bw / 2;
      const r = Math.min(4, (base - top) / 2);
      svg += `<path class="column" data-i="${i}" d="M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${base}Z"/>`;
      svg += `<text class="point-label" x="${cx}" y="${top - 6}" text-anchor="middle">${mo.count}</text>`;
    }
    svg += `<text class="tick" x="${cx}" y="${base + 15}" text-anchor="middle">${MONTHS_SHORT[mm - 1]}</text>`;
    if (mm === 1 || i === 0) svg += `<text class="tick tick-year" x="${cx}" y="${base + 29}" text-anchor="middle">${yy}</text>`;
    svg += `<rect class="hit" data-i="${i}" x="${m.l + slot * i}" y="${m.t - 12}" width="${slot}" height="${ph + 12}" fill="transparent"/>`;
  });
  svg += '</svg>';

  const holder = el('div', 'chart');
  holder.innerHTML = svg;
  root.replaceChildren(holder);

  for (const hit of holder.querySelectorAll('.hit')) {
    const mo = months[Number(hit.dataset.i)];
    const column = holder.querySelector(`.column[data-i="${hit.dataset.i}"]`);
    hit.addEventListener('pointerenter', () => {
      column?.classList.add('active');
      const box = hit.getBoundingClientRect();
      showTip(box.left + box.width / 2, box.top + 8, (tipRoot) => {
        tipRoot.append(el('div', 'tip-title', fmtDate(mo.key, 'long')));
        const row = el('div', 'tip-row');
        row.append(el('b', '', String(mo.count)), el('span', 'tip-name', forms(mo.count)));
        tipRoot.append(row);
      });
    });
    hit.addEventListener('pointerleave', () => {
      column?.classList.remove('active');
      hideTip();
    });
  }
}
