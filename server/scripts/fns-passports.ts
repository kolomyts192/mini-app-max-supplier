// Свежие версии открытых наборов ФНС: дата, размер, ссылка. Помогает выбрать наборы для импорта.
// Запуск: docker compose run --rm tools sh -c "cd server && npx tsx scripts/fns-passports.ts disqualifiedpersons taxoffence"
import { latestFromPassport } from '../src/opendata/download';

async function main() {
  const ids = process.argv.slice(2);
  for (const id of ids) {
    try {
      const l = await latestFromPassport(`https://www.nalog.gov.ru/opendata/7707329152-${id}/`);
      const head = await fetch(l.url, { method: 'HEAD' });
      console.log(id.padEnd(22), l.dataDate, `${Math.round(Number(head.headers.get('content-length') ?? 0) / 1048576)} MB`.padStart(8), l.url);
    } catch (e) {
      console.log(id.padEnd(22), 'ERR', (e as Error).message);
    }
  }
}

main();
