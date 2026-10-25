// Список открытых наборов данных ФНС: идентификатор и название (для выбора источников).
// Запуск: docker compose run --rm tools sh -c "cd server && node scripts/list-fns-opendata.mjs"
const res = await fetch('https://www.nalog.gov.ru/opendata/', { signal: AbortSignal.timeout(30000) });
const html = await res.text();
const seen = new Map();
for (const m of html.matchAll(/href="\/opendata\/(7707329152-[a-z0-9]+)\/?"[^>]*>([\s\S]*?)<\/a>/gi)) {
  const title = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (title && !seen.has(m[1])) seen.set(m[1], title);
}
for (const [id, title] of seen) console.log(`${id}\t${title}`);
console.log(`total: ${seen.size}`);
