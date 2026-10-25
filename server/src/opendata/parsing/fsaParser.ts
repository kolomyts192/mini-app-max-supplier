/**
 * Строки CSV открытых данных Росаккредитации: реестр деклараций (7736638268-rds) и сертификатов (7736638268-rss).
 * Состав колонок меняется между версиями структуры, поэтому колонки ищем по названию в заголовке.
 */
export interface FsaColumns {
  number: number;
  status: number;
  validFrom: number;
  validTo: number;
  terminatedAt: number;
  applicantInn: number;
  applicantName: number;
  manufacturerInn: number;
  manufacturerName: number;
  product: number;
  okpd2: number;
  techRegulation: number;
  body: number;
}

export interface FsaDocument {
  number: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'TERMINATED' | 'ARCHIVED' | 'UNKNOWN';
  validFrom: string | null;
  validTo: string | null;
  applicantInn: string | null;
  applicantName: string | null;
  manufacturerInn: string | null;
  manufacturerName: string | null;
  product: string | null;
  /** Коды ОКПД2 / ТН ВЭД из документа — для привязки к товару справочника. */
  okpd2: string[];
  techRegulation: string | null;
  body: string | null;
}

const find = (header: string[], patterns: RegExp[], exclude?: RegExp) => {
  const h = header.map((x) => x.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' '));
  for (const re of patterns) {
    const i = h.findIndex((x) => re.test(x) && !(exclude && exclude.test(x)));
    if (i >= 0) return i;
  }
  return -1;
};

const inn = (s: string | undefined) => {
  const d = (s ?? '').replace(/\D/g, '');
  return d.length === 10 || d.length === 12 ? d : null;
};
const text = (s: string | undefined) => (s && s.trim() ? s.trim() : null);

export class FsaParser {
  /**
   * Индексы нужных колонок. Ошибка с перечнем заголовков, если нет номера документа или ИНН.
   * Структура 2024 года (structure-20241001.csv): «Номер ДС», «Статус», «Дата рег», «Срок действия», «Заявитель»,
   * «ИНН Заявителя», «Изготовитель», «ИНН производителя», «ОС», «Полное наименование», «Коды ОКПД2 / ТНВЭД», «Тех регламенты».
   */
  columns(header: string[]): FsaColumns {
    const cols: FsaColumns = {
      number: find(
        header,
        [/регистрационн\S* номер/, /^номер (дс|сс|рс|декларации|сертификата|документа)$/, /номер (декларации|сертификата|документа)/, /^номер$/, /^(reg_?)?number$/],
        /бланк|заявк|аттестат|гтд|протокол|на тип|шасси|временн/,
      ),
      status: find(header, [/^статус$/, /^статус (декларации|сертификата|документа)/, /^status/]),
      validFrom: find(header, [/дата (регистрации|выдачи|начала)/, /^дата рег/, /(reg|begin|start)_?date/]),
      validTo: find(header, [/дата (окончания|истечения)/, /^срок действия/, /(end|finish)_?date/]),
      terminatedAt: find(header, [/^дата прекращения/]),
      applicantInn: find(header, [/инн.*заявител/, /заявител.*инн/, /applicant_?inn/]),
      applicantName: find(header, [/наименование.*заявител/, /^заявитель$/, /applicant_?name/], /инн|огрн|адрес|тип/),
      manufacturerInn: find(header, [/инн.*(изготовител|производител)/, /(изготовител|производител).*инн/, /manufacturer_?inn/]),
      manufacturerName: find(header, [/наименование.*изготовител/, /^изготовитель$/, /manufacturer_?name/], /инн|огрн|адрес|тип/),
      product: find(header, [/наименование продукции/, /полное наименование продукции/, /^полное наименование$/, /^продукция$/, /описание продукции/, /product_?name/]),
      okpd2: find(header, [/окпд/]),
      techRegulation: find(header, [/технически\S* регламент/, /^тех\S* регламент/, /документы?, (на соответствие|в соответствии)/, /tech_?reg/]),
      body: find(header, [/орган\S* по сертификации/, /^ос$/, /испытательн\S* лаборатор/, /cert_?body/]),
    };
    if (cols.number < 0 || (cols.applicantInn < 0 && cols.manufacturerInn < 0)) {
      throw new Error(`Структура набора Росаккредитации не распознана: нет колонки номера документа или ИНН. Заголовки: ${header.join(' | ')}`);
    }
    return cols;
  }

  row(cells: string[], c: FsaColumns): FsaDocument | null {
    const at = (i: number) => (i >= 0 ? cells[i] : undefined);
    const number = text(at(c.number));
    if (!number) return null;
    const status = FsaParser.normalizeStatus(at(c.status));
    return {
      number,
      // Статус не указан, но есть дата прекращения — документ прекращён
      status: status === 'UNKNOWN' && FsaParser.parseDate(at(c.terminatedAt)) ? 'TERMINATED' : status,
      validFrom: FsaParser.parseDate(at(c.validFrom)),
      validTo: FsaParser.parseDate(at(c.validTo)),
      applicantInn: inn(at(c.applicantInn)),
      applicantName: text(at(c.applicantName)),
      manufacturerInn: inn(at(c.manufacturerInn)),
      manufacturerName: text(at(c.manufacturerName)),
      product: text(at(c.product))?.slice(0, 1000) ?? null,
      okpd2: [...new Set((at(c.okpd2) ?? '').match(/\b\d{2}\.\d{2}(?:\.\d{1,2}){0,2}(?:\.\d{3})?\b/g) ?? [])].slice(0, 10),
      techRegulation: text(at(c.techRegulation))?.slice(0, 500) ?? null,
      body: text(at(c.body))?.slice(0, 500) ?? null,
    };
  }

  static normalizeStatus(s: string | undefined): FsaDocument['status'] {
    const v = (s ?? '').toLowerCase();
    if (!v) return 'UNKNOWN';
    if (/приостанов/.test(v)) return 'SUSPENDED';
    if (/прекращ|аннулир|отозван|недействит/.test(v)) return 'TERMINATED';
    if (/архив|истек|истёк/.test(v)) return 'ARCHIVED';
    if (/действ|возобновл|продл|active/.test(v)) return 'ACTIVE';
    return 'UNKNOWN';
  }

  /** ДД.ММ.ГГГГ, ГГГГ-ММ-ДД или ГГГГ-ММ-ДДTчч:мм → ГГГГ-ММ-ДД. */
  static parseDate(s: string | undefined): string | null {
    const v = (s ?? '').trim();
    let m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(v);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }

  /** Порядок важности документов при ограничении числа на компанию: действующие и свежие — первыми. */
  static rank(d: Pick<FsaDocument, 'status' | 'validFrom'>): string {
    return `${d.status === 'ACTIVE' ? 1 : 0}${d.validFrom ?? '0000-00-00'}`;
  }
}
