import type { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';

/** Кодировка CSV по первым байтам: BOM или корректный UTF-8 с кириллицей — UTF-8, иначе windows-1251. */
export function detectEncoding(head: Buffer): 'utf-8' | 'windows-1251' {
  if (head.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return 'utf-8';
  const text = new TextDecoder('utf-8').decode(head);
  const broken = (text.match(/�/g) ?? []).length;
  return broken > 2 ? 'windows-1251' : 'utf-8';
}

/** Разделитель по строке заголовка: ; , | или табуляция — что встречается чаще вне кавычек. */
export function detectDelimiter(headerLine: string): string {
  const outside = headerLine.replace(/"[^"]*"/g, '');
  const counts = [';', ',', '|', '\t'].map((d) => ({ d, n: outside.split(d).length - 1 }));
  return counts.sort((a, b) => b.n - a.n)[0].d;
}

/**
 * Потоковый разбор CSV (RFC 4180): кавычки, "" внутри значения, переводы строк внутри кавычек.
 * Первая строка — заголовок; onRow получает массив значений каждой следующей строки.
 */
export async function streamCsv(stream: Readable, onHeader: (header: string[]) => void, onRow: (cells: string[]) => void | Promise<void>): Promise<number> {
  let decoder: TextDecoder | null = null;
  let delimiter: string | null = null;
  let header: string[] | null = null;
  let cell = '';
  let row: string[] = [];
  let quoted = false;
  let pendingQuote = false; // встретили " внутри кавычек: это конец значения или экранированная кавычка
  let rows = 0;
  let firstLine = '';

  const endRow = async () => {
    row.push(cell);
    cell = '';
    const r = row;
    row = [];
    if (r.length === 1 && r[0] === '') return; // пустая строка
    if (!header) {
      header = r.map((h) => h.replace(/^﻿/, '').trim());
      onHeader(header);
      return;
    }
    rows += 1;
    await onRow(r.map((c) => c.trim()));
  };

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (!decoder) decoder = new TextDecoder(detectEncoding(chunk.subarray(0, 4096)));
    const text = decoder.decode(chunk, { stream: true });
    if (!delimiter) {
      firstLine += text;
      const nl = firstLine.search(/\r?\n/);
      if (nl < 0 && firstLine.length < 1_000_000) continue;
      delimiter = detectDelimiter(nl < 0 ? firstLine : firstLine.slice(0, nl));
    }
    const input = firstLine || text;
    firstLine = '';
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (quoted) {
        if (pendingQuote) {
          pendingQuote = false;
          if (ch === '"') {
            cell += '"';
            continue;
          }
          quoted = false; // кавычка закрыла значение — символ обрабатываем как обычный ниже
        } else if (ch === '"') {
          pendingQuote = true;
          continue;
        } else {
          cell += ch;
          continue;
        }
      }
      if (ch === '"' && cell === '') quoted = true;
      else if (ch === delimiter) {
        row.push(cell);
        cell = '';
      } else if (ch === '\n') await endRow();
      else if (ch !== '\r') cell += ch;
    }
  }
  if (decoder) {
    const tail = decoder.decode();
    if (tail) cell += tail;
  }
  if (cell !== '' || row.length) await endRow();
  return rows;
}
