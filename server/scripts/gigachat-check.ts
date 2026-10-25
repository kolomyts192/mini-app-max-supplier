/**
 * Проверка подключения GigaChat: токен, список моделей, пробный разбор запроса.
 * Запуск: npm run gigachat:check -- "фанера ФСФ 18 мм, Москва"
 * (в Docker: docker compose run --rm tools sh -c "cd server && npm install && npm run gigachat:check")
 */
import pino from 'pino';
import { GigaChatClient } from '../src/ai/gigachat/gigachatClient';
import { GigaChatTokenProvider } from '../src/ai/gigachat/tokenProvider';
import { GigaChatQueryInterpreter } from '../src/ai/queryInterpreter';
import { Catalog } from '../src/catalog/catalog';
import { loadConfig } from '../src/config';
import { attributeLabel } from '../src/search/attributes';

async function main() {
  const config = loadConfig();
  const log = pino({ level: 'warn' });
  if (!config.GIGACHAT_AUTH_KEY) {
    console.error('GIGACHAT_AUTH_KEY не задан: впишите «Ключ авторизации» из личного кабинета developers.sber.ru в .env');
    process.exit(2);
  }
  const step = (name: string) => process.stdout.write(`${name}… `);

  step('1. Токен доступа');
  const tokens = new GigaChatTokenProvider({ authUrl: config.GIGACHAT_AUTH_URL, authKey: config.GIGACHAT_AUTH_KEY, scope: config.GIGACHAT_SCOPE });
  const token = await tokens.get(15_000);
  console.log(`получен, действует до ${new Date(tokens.expiresAt!).toLocaleString('ru-RU')} (scope ${config.GIGACHAT_SCOPE})`);

  step('2. Модели');
  const res = await fetch(`${config.GIGACHAT_API_URL.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET /models: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const models = ((await res.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
  const found = models.includes(config.GIGACHAT_MODEL);
  console.log(`${models.join(', ')}\n   ${found ? '✔' : '✘'} GIGACHAT_MODEL=${config.GIGACHAT_MODEL} ${found ? 'доступна' : '— нет в списке, выберите модель из списка выше'}`);

  step('3. Пробный разбор запроса');
  const text = process.argv.slice(2).join(' ') || 'фанера ФСФ 18 мм, Москва, только от производителя';
  const client = new GigaChatClient(tokens, { apiUrl: config.GIGACHAT_API_URL, model: config.GIGACHAT_MODEL, maxConcurrency: 1 }, log);
  const started = Date.now();
  const r = await new GigaChatQueryInterpreter(client, Catalog.load(config.dataDir)).interpret(text, 30_000);
  console.log(`${Date.now() - started} мс\n   «${text}»`);
  console.log(`   товар: ${r.product ? `${r.product.name} (${r.product.productId ?? r.product.categoryId}, уверенность ${r.product.confidence})` : '—'}`);
  console.log(`   регион: ${r.region?.name ?? '—'}; тип: ${r.supplierType ?? '—'}; документы: ${r.certificate ?? '—'}`);
  console.log(`   характеристики: ${r.attributes.map(attributeLabel).join(', ') || '—'}`);
  console.log(`   слова для документов: ${r.terms.join(', ') || '—'}`);
  console.log(`   уточнение: ${r.clarify ?? '—'}`);
  console.log('\nGigaChat подключён. Перезапустите приложение, чтобы поиск начал использовать ИИ.');
}

main().catch((err) => {
  console.error(`\n✘ ${(err as Error).message}`);
  process.exit(1);
});
