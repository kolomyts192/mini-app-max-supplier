// Загружает Bebas Neue (2014, FontFabric — версия с кириллицей) из репозитория автора
// и конвертирует в WOFF2. Проверяет, что в cmap есть кириллица.
// Запуск: node scripts/fetch-fonts.mjs  (нужен пакет wawoff2 в devDependencies)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../src/assets/fonts');
const BASE = 'https://raw.githubusercontent.com/dharmatype/Bebas-Neue/master/fonts/BebasNeue(2014)ByFontFabric/';
const WEIGHTS = { Regular: 400, Bold: 700, Book: 300 };

/** Есть ли кодовая точка в таблице cmap (формат 4). */
function hasCodepoint(buf, cp) {
  const numTables = buf.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === 'cmap') cmap = buf.readUInt32BE(rec + 8);
  }
  if (cmap < 0) return false;
  const n = buf.readUInt16BE(cmap + 2);
  for (let i = 0; i < n; i++) {
    const off = cmap + buf.readUInt32BE(cmap + 4 + i * 8 + 4);
    if (buf.readUInt16BE(off) !== 4) continue;
    const segX2 = buf.readUInt16BE(off + 6);
    for (let s = 0; s < segX2 / 2; s++) {
      const end = buf.readUInt16BE(off + 14 + s * 2);
      const start = buf.readUInt16BE(off + 16 + segX2 + s * 2);
      if (cp >= start && cp <= end) return true;
    }
  }
  return false;
}

const { compress } = await import('wawoff2');
fs.mkdirSync(out, { recursive: true });
for (const [name, weight] of Object.entries(WEIGHTS)) {
  const url = `${BASE}BebasNeue-${name}.ttf`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const ttf = Buffer.from(await res.arrayBuffer());
  const cyr = ['А', 'Я', 'Ё', 'ж'].map((c) => hasCodepoint(ttf, c.codePointAt(0)));
  console.log(`BebasNeue-${name}: ${ttf.length} B, cyrillic А/Я/Ё/ж: ${cyr.join('/')}`);
  if (!cyr.slice(0, 3).every(Boolean)) throw new Error('В шрифте нет кириллицы');
  const woff2 = Buffer.from(await compress(ttf));
  fs.writeFileSync(path.join(out, `bebas-neue-${weight}.woff2`), woff2);
  console.log(`  → bebas-neue-${weight}.woff2 ${woff2.length} B`);
}
