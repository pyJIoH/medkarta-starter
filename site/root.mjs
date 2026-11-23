// Где лежат данные карты.
// По умолчанию — в той же папке, что и сайт: заготовка «всё в одном».
// Сайт можно держать отдельным репозиторием, а данные — в другой папке:
//   node site/server.mjs --root /путь/к/карте
//   MEDKARTA_ROOT=/путь/к/карте node site/server.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Папка приложения: здесь лежит site/. Сайт в неё ничего не пишет, если данные вынесены. */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(text) {
  console.error(text);
  process.exit(1);
}

/** Папка с данными карты: --root, затем MEDKARTA_ROOT, иначе папка приложения. */
export function resolveDataRoot(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--root');
  const inline = argv.find((a) => a.startsWith('--root='));
  if (i >= 0 && (!argv[i + 1] || argv[i + 1].startsWith('--'))) fail('После --root нужен путь к папке с данными карты.');
  const raw = i >= 0 ? argv[i + 1] : inline ? inline.slice('--root='.length) : env.MEDKARTA_ROOT;
  if (!raw) return APP_ROOT;
  const root = path.resolve(raw);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`Папка с данными не найдена: ${root}`);
  return root;
}
