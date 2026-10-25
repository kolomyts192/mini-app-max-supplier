import type { Catalog } from '../catalog/catalog';
import { plural } from '../catalog/text';
import { CERTIFICATE_LABEL, SUPPLIER_PREF_LABEL } from '../domain/types';
import { attributeLabel } from '../search/attributes';
import type { SearchCounts, SupplierSummary } from '../search/dto';
import type { OpenDataImport } from '../search/service';
import type { BotSession } from './session';

export const T = {
  greeting:
    'Здравствуйте. Я помогу найти производителя или поставщика и покажу, какие сведения о компании удалось найти в официальных источниках.\n\n' +
    'Напишите одним сообщением, что ищете. Например:\n«Нужен производитель строительной краски в Московской области, оптом, до 2 тонн».\n\n' +
    'Я не гарантирую надёжность поставщика, качество или наличие товара: я показываю найденные сведения и откуда они взяты.',
  demoNotice: 'Демо-версия: поиск идёт по ручной тестовой базе вымышленных компаний.',
  realNotice:
    'Поиск идёт по официальным открытым данным ФНС: реестр МСП, численность, налоги, штрафы, господдержка, отчётность. Какие реестры подключены для компании, видно в её карточке; документы и статус производителя уточняйте у поставщика.',
  askProduct: 'Что ищете? Напишите товар, а если важно — регион, объём и тип поставщика.',
  askProductUnknown: (cats: string) => `Не нашёл такой товар в справочнике. Сейчас доступны категории:\n${cats}\n\nВыберите категорию или напишите товар иначе.`,
  askProductCandidates: 'Уточните, какой товар ищете:',
  askRegion: 'В каком регионе ищем? Выберите или напишите регион, например: «Тульская область».',
  regionNotRecognized: 'Не распознал регион. Выберите из списка или напишите, например: «Калужская область».',
  askSupplierType: 'Ищем только производителя?',
  askVolume: 'Укажите объём, например: «до 2 тонн», «500 кг», «100 м²».',
  volumeNotRecognized: 'Не распознал объём. Напишите, например: «до 2 тонн» или нажмите «Не важно».',
  askCertificate: 'Нужны документы на товар (сертификат или декларация)?',
  changeWhat: 'Что изменить?',
  ready: 'Параметры готовы. Откройте подборку, чтобы посмотреть и сравнить варианты.',
  readyNoUsername: 'Параметры готовы. Откройте мини-приложение кнопкой «Открыть» в профиле бота — параметры подставятся автоматически в течение 15 минут.',
  cancelled: 'Поиск отменён. Чтобы начать заново, напишите, что ищете, или отправьте /find.',
  help:
    'Я ищу производителей и поставщиков товаров для бизнеса — стройматериалы, упаковка, металл, спецодежда, мебель, продукты и другое — и показываю, какие сведения о компании нашлись в официальных источниках.\n\n' +
    'Команды:\n/start — приветствие\n/find — начать поиск\n/saved — сохранённые подборки\n/help — помощь\n/cancel — отменить текущий поиск\n\n' +
    'Как это работает: вы пишете запрос → я уточняю регион и тип поставщика → открываете подборку в мини-приложении, сравниваете варианты и сохраняете.',
  noSaved: 'Сохранённых подборок пока нет. Сохранить подборку можно в мини-приложении кнопкой «Сохранить подборку».',
  savedList: (n: number) => `Сохранённые подборки (${n}). Откройте нужную:`,
  selectionSaved: 'Подборка сохранена. Открыть её можно командой /saved',
  error: 'Что-то пошло не так. Попробуйте ещё раз через минуту или отправьте /find.',
  emptyResults: 'По запросу ничего не найдено. Попробуйте:',
  found: (c: SearchCounts) => {
    const n = (v: number) => v.toLocaleString('ru-RU');
    const companies = (v: number) => `${n(v)} ${plural(v, ['компания', 'компании', 'компаний'])}`;
    // Сведения собираются только для лучших совпадений: при большой категории не обещаем, что подошли все
    if (c.isEstimate) return `В категории ${companies(c.total)}. Проверил ${n(c.evaluated)} лучших совпадений — подходят ${n(c.matched)}. В подборке — ${n(c.shown)} лучших.`;
    return `По вашим параметрам подходят ${companies(c.matched)}. В подборке — ${n(c.shown)} лучших.`;
  },
  attributesNotRecognized: 'Не разобрал характеристики. Напишите, например: «18 мм, ФСФ» — или нажмите «Пропустить».',
  sourcesDown: 'Часть сведений сейчас недоступна. В подборке показаны результаты по другим источникам.',
};

const ruDate = (iso: string) => iso.split('-').reverse().join('.');

/** «Источники: реестр МСП на 10.10.2026 · налоги ФНС на 25.09.2026 · Росаккредитация на 31.08.2026». Пусто, если данных нет. */
export function sourcesLine(imports: OpenDataImport[]): string {
  const latest = (pred: (i: OpenDataImport) => boolean) => imports.filter(pred).map((i) => i.dataDate).sort().at(-1);
  const parts = [
    ['реестр МСП', latest((i) => i.source === 'SME_REGISTRY')],
    ['налоги и численность ФНС', latest((i) => i.source === 'FNS_PB')],
    ['Росаккредитация', latest((i) => i.source.startsWith('FSA_'))],
  ]
    .filter(([, d]) => d)
    .map(([name, d]) => `${name} на ${ruDate(d as string)}`);
  return parts.length ? `Источники: ${parts.join(' · ')}.` : '';
}

/** Чем подтверждён тип поставщика: номер декларации или «заявлено в реестре МСП». */
export function typeEvidence(s: SupplierSummary): string {
  const byDoc = /изготовителем в (сертификате|декларации) (.+?) \(Росаккредитация/.exec(s.supplierTypeBasis ?? '');
  if (byDoc) return `по ${byDoc[1] === 'сертификате' ? 'сертификату' : 'декларации'} ${byDoc[2]}`;
  const decl = s.documents.items.find((d) => d.type === 'DECLARATION' && d.manufacturerInn === s.inn);
  if (decl) return `по декларации ${decl.number}`;
  if (s.supplierTypeBasis?.includes('в реестре МСП')) return 'заявлено в реестре МСП';
  return 'тип не подтверждён, определён по ОКВЭД';
}

/** «Отобрал 5 из 24 320» и три лучших прямо в чате. */
export function selectionText(shown: number, total: number, top: SupplierSummary[]): string {
  const n = (v: number) => v.toLocaleString('ru-RU');
  const lines = top.map((s, i) => `${i + 1}. ${s.name}, ${s.region.name} — ${s.supplierTypeLabel.toLowerCase()} (${typeEvidence(s)})`);
  return [`Отобрал ${n(shown)} из ${n(total)}. Лучшие три:`, ...lines].join('\n');
}

export function querySummary(s: BotSession, catalog: Catalog): string {
  const lines: string[] = ['Я понял запрос так:'];
  lines.push(`— товар: ${s.product ? s.product.name.toLowerCase() : 'не указан'};`);
  lines.push(`— регион: ${s.region ? s.region.name : 'не указан'};`);
  if (s.wholesale !== null) lines.push(`— формат: ${s.wholesale ? 'опт' : 'розница'};`);
  if (s.volume) {
    const unit = catalog.unit(s.volume.unit)?.short ?? s.volume.unit;
    const op = { up_to: 'до ', from: 'от ', exact: '' }[s.volume.mode];
    lines.push(`— объём: ${op}${String(s.volume.value).replace('.', ',')} ${unit};`);
  }
  if (s.attributes?.length) lines.push(`— характеристики: ${s.attributes.map(attributeLabel).join(', ')};`);
  if (s.supplier_type) lines.push(`— тип поставщика: ${SUPPLIER_PREF_LABEL[s.supplier_type]};`);
  if (s.certificate_requirement) lines.push(`— ${CERTIFICATE_LABEL[s.certificate_requirement]};`);
  const last = lines.length - 1;
  lines[last] = lines[last].replace(/;$/, '.');
  return lines.join('\n');
}
