/**
 * Оценка выдачи на золотом наборе (data/search-golden.json): у какой доли поставщиков в пятёрке есть
 * доказательство нужного товара в реестрах. Не зависит от кода поиска: вызывает API как мини-приложение
 * и сверяет ответ с базой. Запуск: npm run search:eval -- --url http://localhost:8080 --label после
 */
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { loadConfig } from '../src/config';
import type { Attribute } from '../src/domain/types';
import { ReportStore } from '../src/opendata/io/reportStore';
import { attributeLabel } from '../src/search/attributes';

interface GoldenQuery {
  query: string;
  /** Префиксы основного ОКВЭД; после ~ — регулярное выражение по названию кода. */
  okved: string[];
  /** Регулярное выражение по названиям продукции в документах и заявленной продукции. */
  text: string;
  okpd2: string[];
}

interface SupplierEvidence {
  inn: string;
  okvedCode: string;
  okvedName: string;
  declared: { code: string; name: string }[];
  documents: string[];
}

interface QueryResult {
  query: string;
  shown: number;
  relevant: number;
  precision: number;
  latencyMs: number;
  interpretation: string;
  ai: string;
  results: { name: string; inn: string; basis: string | null }[];
}

/** Есть ли у поставщика доказательство нужного товара и какое. */
class EvidenceJudge {
  constructor(private readonly db: Pool) {}

  async load(inns: string[]): Promise<Map<string, SupplierEvidence>> {
    const { rows } = await this.db.query(
      `SELECT s.inn, s.okved_main->>'code' AS code, s.okved_main->>'name' AS name, s.declared_products,
              COALESCE((SELECT array_agg(d.product_name) FROM compliance_documents d WHERE d.supplier_id = s.id AND d.product_name IS NOT NULL), '{}') AS documents
         FROM suppliers s WHERE s.inn = ANY($1)`,
      [inns],
    );
    return new Map(rows.map((r) => [r.inn, { inn: r.inn, okvedCode: r.code ?? '', okvedName: r.name ?? '', declared: r.declared_products ?? [], documents: r.documents }]));
  }

  basis(e: SupplierEvidence | undefined, g: GoldenQuery): string | null {
    if (!e) return null;
    const text = new RegExp(g.text, 'iu');
    const okved = g.okved.find((rule) => {
      const [prefix, name] = rule.split('~');
      const code = e.okvedCode === prefix || e.okvedCode.startsWith(`${prefix}.`);
      return code && (!name || new RegExp(name, 'iu').test(e.okvedName));
    });
    if (okved) return `ОКВЭД ${e.okvedCode}`;
    const doc = e.documents.find((d) => text.test(d));
    if (doc) return `документ: ${doc.slice(0, 80)}`;
    const declared = e.declared.find((d) => text.test(d.name) || g.okpd2.some((c) => d.code === c || d.code.startsWith(`${c}.`)));
    return declared ? `заявлено: ${declared.code} ${declared.name}` : null;
  }
}

class SearchEvaluation {
  constructor(
    private readonly apiUrl: string,
    private readonly judge: EvidenceJudge,
  ) {}

  async run(queries: GoldenQuery[]): Promise<QueryResult[]> {
    const out: QueryResult[] = [];
    for (const g of queries) {
      const started = Date.now();
      const res = await fetch(`${this.apiUrl}/api/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-demo-user': 'golden-set-eval' },
        body: JSON.stringify({ text: g.query }),
      });
      if (!res.ok) throw new Error(`${g.query}: HTTP ${res.status} ${await res.text()}`);
      const data = (await res.json()) as {
        results: { name: string; inn: string }[];
        query: { categoryId: string | null; productId: string | null; regionCode: string | null; attributes?: Attribute[] };
        ai?: { interpretation: string; ranking: string };
      };
      const latencyMs = Date.now() - started;
      const evidence = await this.judge.load(data.results.map((r) => r.inn));
      const results = data.results.map((r) => ({ name: r.name, inn: r.inn, basis: this.judge.basis(evidence.get(r.inn), g) }));
      const relevant = results.filter((r) => r.basis).length;
      const q = data.query;
      const attrs = (q.attributes ?? []).map(attributeLabel).join(', ');
      out.push({
        query: g.query,
        shown: results.length,
        relevant,
        precision: results.length ? relevant / results.length : 0,
        latencyMs,
        interpretation: [q.productId ?? q.categoryId ?? '—', q.regionCode, attrs].filter(Boolean).join(' · '),
        ai: data.ai ? `${data.ai.interpretation}/${data.ai.ranking}` : 'нет',
        results,
      });
    }
    return out;
  }
}

function report(label: string, results: QueryResult[]) {
  const mean = results.reduce((s, r) => s + r.precision, 0) / results.length;
  const good = results.filter((r) => r.precision >= 0.8).length;
  const latency = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p95 = latency[Math.max(0, Math.ceil(latency.length * 0.95) - 1)];
  const markdown = [
    `# Оценка выдачи на золотом наборе: ${label}`,
    '',
    `- Запросов: ${results.length}; средняя доля подходящих в выдаче: **${(mean * 100).toFixed(1)}%**`,
    `- Запросов, где подходят 4 из 5 и больше: ${good} из ${results.length}`,
    `- Задержка: p50 ${latency[Math.floor(latency.length / 2)]} мс, p95 ${p95} мс`,
    '',
    '| Запрос | Распознано | Подходят | ИИ | мс |',
    '|---|---|---:|---|---:|',
    ...results.map((r) => `| ${r.query} | ${r.interpretation} | ${r.relevant} из ${r.shown} | ${r.ai} | ${r.latencyMs} |`),
    '',
    '## Выдача',
    '',
    ...results.flatMap((r) => [`### ${r.query}`, '', ...r.results.map((x) => `- ${x.basis ? '✔' : '✘'} ${x.name} (${x.inn})${x.basis ? ` — ${x.basis}` : ''}`), '']),
  ].join('\n');
  return { summary: { label, mean, good, p95, total: results.length }, markdown, json: { label, mean, good, p95, results } };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string, def: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : def;
  };
  const config = loadConfig();
  const golden = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'search-golden.json'), 'utf8')) as { queries: GoldenQuery[] };
  const db = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
  try {
    const label = arg('label', 'оценка');
    const results = await new SearchEvaluation(arg('url', `http://localhost:${config.PORT}`), new EvidenceJudge(db)).run(golden.queries);
    const r = report(label, results);
    const reportsDir = config.OPENDATA_REPORTS_DIR ?? path.join(path.resolve(config.OPENDATA_DIR), 'reports');
    const saved = new ReportStore(reportsDir).save(`search-eval-${label.replace(/[^\p{L}\p{N}]+/gu, '-')}`, { json: r.json, markdown: r.markdown });
    console.log(r.markdown.split('\n## Выдача')[0]);
    console.log(JSON.stringify({ ...r.summary, saved }, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
