/** Официальный открытый набор данных: паспорт, источник в карточке и срок актуальности сведений. */
export class OpenDataset {
  constructor(
    readonly id: string,
    /** Идентификатор источника в catalog.json → sources. */
    readonly source: string,
    readonly title: string,
    readonly passport: string,
    /** Сколько дней сведения считаются свежими после даты набора. */
    readonly freshDays: number,
  ) {}
}

const fns = (id: string, slug: string, source: string, title: string, freshDays = 120) =>
  new OpenDataset(id, source, title, `https://www.nalog.gov.ru/opendata/7707329152-${slug}/`, freshDays);

/** Наборы ФНС. Порядок — порядок импорта: реестр МСП, затем обогащение карточек. */
export const FNS = {
  rsmp: fns('rsmp', 'rsmp', 'SME_REGISTRY', 'Единый реестр субъектов МСП', 35),
  sshr: fns('sshr', 'sshr2019', 'FNS_PB', 'Среднесписочная численность работников'),
  snr: fns('snr', 'snr', 'FNS_PB', 'Специальные налоговые режимы'),
  snrip: fns('snrip', 'snrip', 'FNS_PB', 'Специальные налоговые режимы ИП'),
  debtam: fns('debtam', 'debtam', 'FNS_PB', 'Задолженность по налогам и сборам'),
  // Годовые наборы: сведения актуальны до выхода следующей версии
  paytax: fns('paytax', 'paytax', 'FNS_PB', 'Уплаченные налоги и сборы', 400),
  taxoffence: fns('taxoffence', 'taxoffence', 'FNS_PB', 'Налоговые правонарушения и меры ответственности', 400),
  rsmppp: fns('rsmppp', 'rsmppp', 'SME_SUPPORT', 'Реестр МСП — получателей поддержки'),
  revexp: fns('revexp', 'revexp', 'FNS_REVEXP', 'Доходы и расходы по бухгалтерской отчётности'),
} as const;

export type FnsDatasetId = keyof typeof FNS;

export const FNS_DATASETS: readonly OpenDataset[] = Object.values(FNS);

/** РНП ФАС — открытый набор из раздела 8 ТЗ. С зарубежных IP сайт недоступен. */
export const FAS_RNP = new OpenDataset('rnp', 'FAS_RNP', 'Реестр недобросовестных поставщиков (ФАС)', 'https://fas.gov.ru/opendata/7703516539-rnp/', 730);
