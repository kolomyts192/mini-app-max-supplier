import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FsaArchiveSet } from '../src/opendata/datasets/fsaDatasets';
import { detectDelimiter, streamCsv } from '../src/opendata/io/csvStream';
import { FsaParser } from '../src/opendata/parsing/fsaParser';

const parser = new FsaParser();
const fsaColumns = (h: string[]) => parser.columns(h);
const fsaRow = (cells: string[], c: ReturnType<typeof fsaColumns>) => parser.row(cells, c);
const { normalizeStatus, parseDate, rank: docRank } = FsaParser;
const { dateIn } = FsaArchiveSet;

const win1251 = (s: string) => Buffer.from(new TextEncoder().encode(s)); // UTF-8; кодировку windows-1251 проверяем отдельно ниже

async function parse(buf: Buffer, chunk = 7) {
  const rows: string[][] = [];
  let header: string[] = [];
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += chunk) parts.push(buf.subarray(i, i + chunk));
  await streamCsv(Readable.from(parts), (h) => (header = h), (r) => void rows.push(r));
  return { header, rows };
}

describe('потоковый CSV', () => {
  it('кавычки, "" и перевод строки внутри значения, разрез по чанкам', async () => {
    const csv = 'Номер;Заявитель;Продукция\r\n"ЕАЭС N RU Д-RU.1";"ООО ""Краска""";"Эмаль\nПФ-115"\r\n2;ИП Иванов;Грунт\r\n';
    const { header, rows } = await parse(win1251(csv));
    expect(header).toEqual(['Номер', 'Заявитель', 'Продукция']);
    expect(rows).toEqual([
      ['ЕАЭС N RU Д-RU.1', 'ООО "Краска"', 'Эмаль\nПФ-115'],
      ['2', 'ИП Иванов', 'Грунт'],
    ]);
  });

  it('windows-1251 и запятая как разделитель', async () => {
    const text = 'Регистрационный номер,ИНН заявителя\nRU Д-1,7701234567\n';
    const bytes = Buffer.from([...text].map((ch) => {
      const c = ch.charCodeAt(0);
      if (c >= 0x410 && c <= 0x44f) return c - 0x410 + 0xc0;
      return c;
    }));
    const { header, rows } = await parse(bytes, 5);
    expect(header).toEqual(['Регистрационный номер', 'ИНН заявителя']);
    expect(rows).toEqual([['RU Д-1', '7701234567']]);
    expect(detectDelimiter('a;b,c;d')).toBe(';');
    expect(detectDelimiter('id|"Статус"|"Номер СС"')).toBe('|');
  });
});

describe('Росаккредитация: колонки и строки', () => {
  const header = [
    'Регистрационный номер декларации', 'Статус декларации', 'Дата регистрации декларации', 'Дата окончания действия декларации',
    'ИНН заявителя', 'Полное наименование заявителя', 'ИНН изготовителя', 'Полное наименование изготовителя',
    'Наименование продукции', 'Технический регламент', 'Номер бланка',
  ];

  it('находит колонки по названию и разбирает строку', () => {
    const c = fsaColumns(header);
    expect(c.number).toBe(0);
    expect(c.manufacturerInn).toBe(6);
    const d = fsaRow(['ЕАЭС N RU Д-RU.РА01.В.12345/24', 'Действует', '01.02.2024', '31.01.2029', '5031000000', 'АО «ТЕСТХИМ»', '5031000000', 'АО «ТЕСТХИМ»', 'Эмаль ПФ-115', 'ТР ТС 005/2011', ''], c);
    expect(d).toMatchObject({ status: 'ACTIVE', validFrom: '2024-02-01', validTo: '2029-01-31', manufacturerInn: '5031000000', product: 'Эмаль ПФ-115' });
  });

  it('реальные заголовки наборов 2024 года: декларации и сертификаты', () => {
    const rds = ['id', 'Статус', 'Номер ДС', 'Дата рег', 'Срок действия', 'Номер ГТД', 'Тех регламенты', 'Заявитель', 'Адрес Заявителя', 'ИНН Заявителя', 'Тип изготовителя', 'Изготовитель', 'ИНН производителя', 'ОС', 'Полное наименование', 'Коды ОКПД2 / ТНВЭД', 'Дата прекращения', 'Временный номер декл', 'Статус исследований'];
    const c = fsaColumns(rds);
    expect(c).toMatchObject({ number: 2, status: 1, validFrom: 3, validTo: 4, techRegulation: 6, applicantName: 7, applicantInn: 9, manufacturerName: 11, manufacturerInn: 12, body: 13, product: 14, okpd2: 15, terminatedAt: 16 });
    const d = fsaRow(['1', 'Прекращен', 'ЕАЭС N RU Д-RU.РА01.В.1', '2025-03-01', '2030-02-28', '', 'ТР ТС 005/2011', 'ООО «А»', '', '5031000000', '', 'ООО «А»', '5031000000', 'ОС «Тест»', 'Эмаль ПФ-115', '20.30.22.110; 3208', '2025-09-01', '', ''], c);
    expect(d).toMatchObject({ status: 'TERMINATED', okpd2: ['20.30.22.110'], validFrom: '2025-03-01' });

    const rss = ['id', 'Статус', 'Номер СС', 'Дата рег', 'Срок действия', 'Временный номер СС', 'Номер бланка', 'Тех регламенты', 'Заявитель', 'ИНН заявителя', 'Изготовитель', 'ИНН изготовителя', 'ОС', 'Полное наименование продукции', 'Коды ОКПД2/ТНВЭД'];
    expect(fsaColumns(rss)).toMatchObject({ number: 2, manufacturerInn: 11, product: 13, okpd2: 14 });
  });

  it('без колонки номера или ИНН — понятная ошибка со списком заголовков', () => {
    expect(() => fsaColumns(['Продукция', 'Статус'])).toThrow(/Заголовки: Продукция \| Статус/);
  });

  it('дата периода из имени файла: ГГГГММДД и ДДММГГГГ', () => {
    expect(dateIn('rss_20240601-20240630.csv')).toBe('20240601');
    expect(dateIn('rss_01062025-30062025.csv')).toBe('20250601');
    expect(dateIn('data-20260831-structure-20260907.7z')).toBe('20260831');
    expect(dateIn('readme.csv')).toBe('00000000');
  });

  it('статусы, даты и порядок важности', () => {
    expect(normalizeStatus('Прекращён')).toBe('TERMINATED');
    expect(normalizeStatus('Приостановлен')).toBe('SUSPENDED');
    expect(normalizeStatus('Архивный')).toBe('ARCHIVED');
    expect(normalizeStatus('ДЕЙСТВУЕТ')).toBe('ACTIVE');
    expect(parseDate('2024-05-06T10:00:00')).toBe('2024-05-06');
    expect(docRank({ status: 'ACTIVE', validFrom: '2020-01-01' }) > docRank({ status: 'TERMINATED', validFrom: '2025-01-01' })).toBe(true);
  });
});
