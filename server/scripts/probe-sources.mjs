// Проверка доступности официальных источников с текущего IP (VPN/гео-блокировки).
// Запуск: docker compose run --rm tools sh -c "cd server && node scripts/probe-sources.mjs"
const urls = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'https://www.nalog.gov.ru/opendata/',
      'https://egrul.nalog.ru/',
      'https://pb.nalog.ru/',
      'https://bo.nalog.ru/',
      'https://rmsp.nalog.ru/',
      'https://gisp.gov.ru/opendata/',
      'https://gisp.gov.ru/',
      'https://fsa.gov.ru/opendata/',
      'https://pub.fsa.gov.ru/',
      'https://fas.gov.ru/opendata/7703516539-rnp',
      'https://zakupki.gov.ru/',
      'https://fedresurs.ru/',
      'https://bankrot.fedresurs.ru/',
      'https://data.gov.ru/',
      'https://knd.gov.ru/main',
      'https://kad.arbitr.ru/',
    ];

async function probe(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (proveren-postavshik probe)' } });
    return `${String(res.status).padEnd(4)} ${String(Date.now() - started).padStart(6)}ms  ${url}${res.headers.get('location') ? ' → ' + res.headers.get('location') : ''}`;
  } catch (err) {
    const cause = err.cause?.code || err.cause?.message || err.name;
    return `ERR  ${String(Date.now() - started).padStart(6)}ms  ${url}  (${cause})`;
  }
}

const results = await Promise.all(urls.map(probe));
console.log(results.join('\n'));
