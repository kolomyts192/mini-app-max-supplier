// Первые документы скачанного набора ФНС — чтобы сверить структуру XML перед импортом.
// Запуск: docker compose run --rm tools sh -c "cd server && npx tsx scripts/peek-dataset.ts paytax 2"
import fs from 'node:fs';
import path from 'node:path';
import { forEachZipEntry, streamElements } from '../src/opendata/xmlStream';

async function main() {
  const [id, n = '2'] = process.argv.slice(2);
  const dir = process.env.OPENDATA_DIR ?? '/opendata';
  const meta = JSON.parse(fs.readFileSync(path.join(dir, id, 'latest.json'), 'utf8')) as { file: string };
  let left = Number(n);
  let first = true;
  const stop = new Error('enough');
  try {
    await forEachZipEntry(meta.file, async (name, stream) => {
      if (first) console.log('first entry:', name);
      first = false;
      await streamElements(stream, 'Документ', (doc) => {
        console.log(doc.slice(0, 1500), '\n---');
        if (--left <= 0) throw stop;
      });
    });
  } catch (err) {
    if (err !== stop) throw err;
  }
}

main();
