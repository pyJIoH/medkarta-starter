// Происхождение по сырым данным ДНК-теста: отцовская линия (Y-хромосома), материнская линия
// (митохондриальная ДНК) и грубая оценка по континентам. Всё считается локально.
//
// Справочники скачиваются в genome/ref/ карты и в git не попадают (кроме панели маркеров):
//   ref/yhaplo/     дерево Y-хромосомы ISOGG с поправками под чипы — из github.com/23andMe/yhaplo
//   ref/phylotree/  дерево мтДНК PhyloTree 17 (tree.xml, weights.txt, rcrs.fasta) — из github.com/genepi/phylotree-rcrs-17
//   genome/ancestry-panel.csv (в приложении) — 55 маркеров происхождения с частотами по «1000 геномов»
//
// Методы упрощённые: это не замена оценке самого сервиса, а способ увидеть то же самое у себя и понять, откуда оно берётся.

import fs from 'node:fs';
import path from 'node:path';

const called = (m) => Boolean(m && m.gt && !m.gt.includes('-'));
const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : []);

// ---------- отцовская линия: Y-хромосома ----------

/** Дерево в формате Newick: «(A,(B,C)D)Root;». Метка «R/K2b2a2» — два имени одного узла. */
function parseNewick(text) {
  const nodes = new Map(); // любое имя → узел
  const stack = [];
  let last = null;
  const make = () => ({ name: '', aliases: [], parent: null, children: [], snps: [] });
  const tokens = text.trim().replace(/;$/, '').match(/[(),]|[^(),]+/g) ?? [];
  for (const tok of tokens) {
    if (tok === '(') {
      const node = make();
      if (stack.length) (node.parent = stack.at(-1)), stack.at(-1).children.push(node);
      stack.push(node);
      last = null;
    } else if (tok === ',') last = null;
    else if (tok === ')') last = stack.pop();
    else {
      let node = last; // метка после «)» — имя закрытого узла; иначе это лист
      if (!node) {
        node = make();
        if (stack.length) (node.parent = stack.at(-1)), stack.at(-1).children.push(node);
      }
      node.aliases = tok.trim().split('/');
      node.name = node.aliases[0];
      for (const a of node.aliases) nodes.set(a, node);
      last = node;
    }
  }
  return nodes;
}

/** Строки вида «SNP  гаплогруппа  позиция  A->G  …» из таблиц поправок. */
const fixRows = (file) =>
  readLines(file)
    .map((l) => l.replace(/#.*$/, '').trim().split(/\s+/))
    .filter((c) => c.length >= 4 && /^\d+$/.test(c[2]))
    .map((c) => ({ snp: c[0], hg: c[1], pos: Number(c[2]), mut: c[3] }));

export function yHaplogroup(genome, dir) {
  const table = path.join(dir, 'isogg.2016.01.04.txt');
  const treeFile = path.join(dir, 'y.tree.primary.2016.01.04.nwk');
  if (!fs.existsSync(table) || !fs.existsSync(treeFile)) return { missing: 'ref/yhaplo' };
  const nodes = parseNewick(fs.readFileSync(treeFile, 'utf8'));

  // Узел по имени гаплогруппы; недостающие достраиваются по имени: родитель «R1a1» — это «R1a».
  const nodeFor = (name) => {
    if (nodes.has(name)) return nodes.get(name);
    if (name.length <= 1) return null;
    const parent = nodeFor(name.slice(0, -1));
    if (!parent) return null;
    const node = { name, aliases: [name], parent, children: [], snps: [] };
    parent.children.push(node);
    nodes.set(name, node);
    return node;
  };

  // Что исключаем: известные ошибки таблицы, маркеры, которые чипы читают неверно, неоднозначные позиции.
  const omitNames = new Set();
  const omitPos = new Set();
  for (const f of ['isogg.omit.bad.txt', 'isogg.omit.bad.23andMe.txt', 'isogg.omit.branch.conflict.txt', 'isogg.omit.branch.conflict.23andMe.v5.txt', 'isogg.split.txt']) {
    for (const r of fixRows(path.join(dir, f))) (omitNames.add(r.snp), omitPos.add(r.pos));
  }
  for (const l of readLines(path.join(dir, 'isogg.omit.name.txt'))) if (l.trim()) omitNames.add(l.trim().split(/\s+/)[0]);
  for (const l of readLines(path.join(dir, 'isogg.multiallelic.txt'))) if (/^\s*\d+\s*$/.test(l)) omitPos.add(Number(l));
  const fixes = new Map();
  for (const f of ['isogg.correct.position.txt', 'isogg.correct.mutation.txt']) for (const r of fixRows(path.join(dir, f))) fixes.set(r.snp, r);

  let tested = 0;
  for (const line of readLines(table).slice(1)) {
    const c = line.split('\t').map((x) => x.trim());
    if (c.length < 6) continue;
    let [snp, hg, other, , pos, mut] = c;
    const fix = fixes.get(snp);
    if (fix) (hg = fix.hg), (pos = String(fix.pos)), (mut = fix.mut);
    // Пометки в скобках и тильда — «место на дереве неточное»: такие маркеры не используем.
    if (!snp || /[(~]/.test(hg) || !/^\d+$/.test(pos) || !/^[ACGT]->[ACGT]$/.test(mut)) continue;
    if (omitNames.has(snp) || omitPos.has(Number(pos))) continue;
    const markers = (genome.byPos.get(`Y:${pos}`) ?? []).filter((m) => called(m) && m.gt.length === 1);
    if (!markers.length) continue;
    const [anc, der] = mut.split('->');
    const state = markers.some((m) => m.gt === der) ? 'der' : markers.some((m) => m.gt === anc) ? 'anc' : '';
    if (!state) continue;
    const node = nodeFor(hg);
    if (!node) continue;
    const names = [snp, ...other.split(/[,;/]\s*/).filter(Boolean)];
    const same = node.snps.find((x) => x.pos === pos);
    if (same) {
      same.names.push(...names); // один маркер под несколькими именами — считаем один раз
      continue;
    }
    tested += 1;
    node.snps.push({ snp, pos, names, state });
  }
  if (!tested) return { missing: 'маркеры Y-хромосомы' };

  // Лучший путь от корня: больше всего «своих» вариантов и меньше всего противоречий.
  // Свой вариант +1, предковый −1: в таблице 2016 года на одном узле бывают собраны маркеры,
  // которые сегодня разнесены по соседним ветвям, поэтому пара противоречий ветвь не отменяет.
  const root = nodes.get('Root') ?? [...nodes.values()].find((n) => !n.parent);
  let best = { node: root, score: 0, depth: 0 };
  const walk = (node, score, depth) => {
    const der = node.snps.filter((x) => x.state === 'der').length;
    const anc = node.snps.length - der;
    const here = score + der - anc;
    if (der && (here > best.score || (here === best.score && depth > best.depth))) best = { node, score: here, depth };
    for (const child of node.children) walk(child, here, depth + 1);
  };
  walk(root, 0, 0);

  const pathNodes = [];
  for (let n = best.node; n; n = n.parent) pathNodes.unshift(n);
  const rep = new Map();
  for (const l of readLines(path.join(dir, 'representative.SNPs.isogg.2015_tree.txt'))) {
    const [hg, snps] = l.trim().split(/\s+/);
    if (hg && snps && snps !== '.') rep.set(hg, snps.split(/[,/]/)[0]);
  }
  // Короткое имя: буква ветви и её маркер — «R-M417». Так гаплогруппы называют сами сервисы.
  const labelOf = (node) => {
    for (let n = node; n; n = n.parent) {
      const named = n.aliases.map((a) => rep.get(a)).find(Boolean) ?? n.snps.find((x) => x.state === 'der')?.snp;
      if (named) return `${node.name.match(/^[A-Z]+/)?.[0] ?? node.name}-${named}`;
    }
    return node.name;
  };
  // Надёжная часть пути: последний узел, который подтверждён хотя бы двумя своими вариантами без перевеса противоречий.
  // Всё, что глубже, держится на одном-двух маркерах — это «вероятная ветвь».
  let solid = root;
  for (const n of pathNodes) {
    const der = n.snps.filter((x) => x.state === 'der').length;
    if (der >= 2 && der > 2 * (n.snps.length - der)) solid = n;
  }
  const steps = pathNodes
    .filter((n) => n.snps.length)
    .map((n) => ({
      name: n.name,
      derived: n.snps.filter((x) => x.state === 'der').map((x) => x.snp),
      ancestral: n.snps.filter((x) => x.state === 'anc').length,
      names: n.snps.filter((x) => x.state === 'der').flatMap((x) => x.names),
    }));
  return {
    haplogroup: best.node.name,
    label: labelOf(best.node),
    solid: { haplogroup: solid.name, label: labelOf(solid) },
    derived: steps.reduce((s, x) => s + x.derived.length, 0),
    conflicts: steps.reduce((s, x) => s + x.ancestral, 0),
    tested,
    path: steps.map((x) => ({ name: x.name, derived: x.derived.slice(0, 6), count: x.derived.length, ancestral: x.ancestral })),
    snps: [...new Set(steps.flatMap((x) => x.names))], // по ним подбирается рассказ о ветви
    tree: 'ISOGG, версия 2016-01-04',
  };
}

// ---------- материнская линия: митохондриальная ДНК ----------

export function mtHaplogroup(genome, dir) {
  const treeFile = path.join(dir, 'tree.xml');
  const fasta = path.join(dir, 'rcrs.fasta');
  if (!fs.existsSync(treeFile) || !fs.existsSync(fasta)) return { missing: 'ref/phylotree' };
  const rcrs = fs.readFileSync(fasta, 'utf8').split(/\r?\n/).filter((l) => !l.startsWith('>')).join('').toUpperCase();
  const weights = new Map();
  for (const l of readLines(path.join(dir, 'weights.txt'))) {
    const [poly, w] = l.split('\t');
    if (poly && Number.isFinite(Number(w))) weights.set(poly, Number(w));
  }
  const weight = (poly) => weights.get(poly) ?? 6;

  // Что прочитал тест: позиция → буква. Позиции в файле — по эталону rCRS, как и в дереве.
  const sample = new Map();
  for (const m of genome.byId.values()) {
    if (m.chr !== 'MT' || !called(m) || m.gt.length !== 1 || !/^[ACGT]$/.test(m.gt)) continue;
    if (m.pos < 1 || m.pos > rcrs.length) continue;
    if (sample.has(m.pos) && sample.get(m.pos) !== m.gt) sample.set(m.pos, ''); // два маркера разошлись — не учитываем
    else if (!sample.has(m.pos)) sample.set(m.pos, m.gt);
  }
  for (const [pos, base] of sample) if (!base) sample.delete(pos);
  if (sample.size < 200) return { missing: 'маркеры митохондриальной ДНК' };
  const own = new Map(); // отличия от эталона
  for (const [pos, base] of sample) if (base !== rcrs[pos - 1]) own.set(pos, base);
  const ownWeight = [...own].reduce((s, [pos, base]) => s + weight(`${pos}${base}`), 0);

  // Дерево читаем потоком: открылся узел — применили его мутации, закрылся — откатили.
  const xml = fs.readFileSync(treeFile, 'utf8');
  const state = new Map(); // позиция → буква на текущей ветви
  const undo = [];
  const stack = [];
  const scored = [];
  const re = /<haplogroup name="([^"]*)"|<poly>([^<]*)<\/poly>|<\/haplogroup>/g;
  let m;
  const score = (name, depth) => {
    let expected = 0;
    let found = 0;
    let nExpected = 0;
    let nFound = 0;
    const missing = [];
    const hit = [];
    for (const [pos, base] of state) {
      if (base === rcrs[pos - 1] || !sample.has(pos)) continue; // вернулось к эталону или чип туда не смотрит
      const w = weight(`${pos}${base}`);
      expected += w;
      nExpected += 1;
      if (own.get(pos) === base) (found += w), (nFound += 1), hit.push(pos);
      else missing.push(`${pos}${base}`);
    }
    const a = expected ? found / expected : 1;
    const b = ownWeight ? found / ownWeight : 1;
    scored.push({ name, depth, score: 0.5 * a + 0.5 * b, found: nFound, expected: nExpected, missing, hit, path: stack.slice() });
  };
  let pending = null; // узел оцениваем, когда прочитаны все его мутации
  const flush = () => {
    if (pending) score(pending.name, pending.depth);
    pending = null;
  };
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) {
      flush();
      stack.push(m[1]);
      undo.push([]);
      pending = { name: m[1], depth: stack.length };
    } else if (m[2] !== undefined) {
      const p = m[2].trim().match(/^(\d+)([ACGT])!*$/); // вставки и делеции чип не читает
      if (!p) continue;
      const pos = Number(p[1]);
      undo.at(-1).push([pos, state.get(pos)]);
      state.set(pos, p[2]);
    } else {
      flush();
      stack.pop();
      for (const [pos, prev] of undo.pop().reverse()) prev === undefined ? state.delete(pos) : state.set(pos, prev);
    }
  }
  scored.sort((x, y) => y.score - x.score || x.depth - y.depth);
  const best = scored[0];
  // Файл дерева «подвешен» за эталон (его гаплогруппа — первый узел), а общий предок всех линий лежит
  // на стыке L0 и L1'2'3'4'5'6. Разворачиваем путь: от общего предка к найденной ветви.
  const spine = scored.find((x) => x.name === "L1'2'3'4'5'6")?.path ?? [];
  let lineage = best.path;
  if (spine.length) {
    let i = 0;
    while (i + 1 < spine.length && i + 1 < best.path.length && spine[i + 1] === best.path[i + 1]) i += 1;
    const inL0 = i === spine.length - 1 && best.path[spine.length] === 'L0';
    lineage = inL0 ? best.path.slice(spine.length) : [...spine.slice(i).reverse(), ...best.path.slice(i + 1)];
  }
  // Свои отличия, которых нет на пути к этой гаплогруппе, — «личные» мутации ветви или ошибки чтения.
  const explained = new Set(best.hit);
  const extra = [...own].filter(([pos]) => !explained.has(pos)).map(([pos, base]) => `${pos}${base}`);
  return {
    haplogroup: best.name,
    score: Number(best.score.toFixed(3)),
    found: best.found,
    expected: best.expected,
    absent: best.missing.slice(0, 12), // ожидались на этой ветви, но тест показал другое
    own: own.size,
    unexplained: extra.slice(0, 12),
    tested: sample.size,
    path: lineage, // ветви от общего предка к найденной — по ним подбираются рассказы
    runnersUp: scored.slice(1, 4).map((x) => ({ name: x.name, score: Number(x.score.toFixed(3)) })),
    tree: 'PhyloTree 17',
  };
}

// ---------- континенты ----------

export const REGIONS = ['EUR', 'EAS', 'SAS', 'AFR', 'AMR'];

function parsePanel(file) {
  const [head, ...rows] = readLines(file).filter(Boolean);
  if (!head) return [];
  const cols = head.split(',');
  return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v])));
}

/** Доли континентов, при которых такие генотипы наиболее вероятны (EM-алгоритм при известных частотах). */
function mixture(snps) {
  let q = REGIONS.map(() => 1 / REGIONS.length);
  for (let iter = 0; iter < 400; iter += 1) {
    const sum = REGIONS.map(() => 0);
    let total = 0;
    for (const s of snps) {
      for (const [copies, has] of [[s.count, true], [2 - s.count, false]]) {
        if (!copies) continue;
        const p = s.freq.map((f, k) => q[k] * (has ? f : 1 - f));
        const z = p.reduce((a, b) => a + b, 0) || 1e-12;
        for (let k = 0; k < q.length; k += 1) sum[k] += (copies * p[k]) / z;
        total += copies;
      }
    }
    q = sum.map((x) => x / total);
  }
  return q;
}

export function continents(genome, panelFile) {
  const panel = parsePanel(panelFile);
  if (!panel.length) return { missing: 'genome/ancestry-panel.csv' };
  const snps = [];
  for (const p of panel) {
    const m = genome.byId.get(p.rsid) ?? (genome.byPos.get(`${p.chr}:${p.pos}`) ?? [])[0];
    if (!called(m) || m.gt.length !== 2 || [...m.gt].some((a) => a !== p.allele && a !== p.other)) continue;
    snps.push({
      count: [...m.gt].filter((a) => a === p.allele).length,
      freq: REGIONS.map((r) => Math.min(0.995, Math.max(0.005, Number(p[r])))),
    });
  }
  if (snps.length < 20) return { missing: 'маркеры происхождения', markers: snps.length };
  const q = mixture(snps);
  // Насколько оценка устойчива: пересчитываем на случайных наборах тех же маркеров (генератор с фиксированным зерном).
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
  const runs = [];
  for (let i = 0; i < 200; i += 1) runs.push(mixture(snps.map(() => snps[Math.floor(rand() * snps.length)])));
  const pct = (k, at) => runs.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(at * (runs.length - 1))];
  return {
    markers: snps.length,
    panelSize: panel.length,
    shares: Object.fromEntries(REGIONS.map((r, k) => [r, Number(q[k].toFixed(3))])),
    low: Object.fromEntries(REGIONS.map((r, k) => [r, Number(pct(k, 0.05).toFixed(3))])),
    high: Object.fromEntries(REGIONS.map((r, k) => [r, Number(pct(k, 0.95).toFixed(3))])),
    panel: 'Kidd, 55 маркеров',
    reference: '1000 геномов',
  };
}
