import type { Catalog } from '../../catalog/catalog';
import type { Company, CompanyProduct, SupplierTypeAssessment } from '../domain/company';
import { allTagAttrs, tagAttrs } from '../io/xmlStream';
import { CatalogClassifier } from './classify';
import { isoDate, prettyName, titleCase } from './format';

const SME_CATEGORY: Record<string, string> = { '1': 'MICRO', '2': 'SMALL', '3': 'MEDIUM' };

/** Почему документ реестра не стал поставщиком: вне выбранных регионов или вне категорий справочника. */
export type RsmpSkip = 'region' | 'category';

export type RsmpParseOutcome = { company: Company; skip?: undefined } | { company: null; skip: RsmpSkip };

/**
 * Документ Единого реестра МСП (7707329152-rsmp) → компания с категориями справочника.
 * Категория определяется по основному ОКВЭД (правила okvedRules) и по продукции, которую компания указала сама.
 * Корректность реквизитов здесь не проверяется — это задача CompanyValidator.
 */
export class RsmpParser {
  private readonly classifier: CatalogClassifier;

  constructor(
    private readonly catalog: Catalog,
    private readonly regions: ReadonlySet<string> | null = null,
  ) {
    this.classifier = CatalogClassifier.for(catalog);
  }

  parse(doc: string): RsmpParseOutcome {
    const main = tagAttrs(doc, 'СвОКВЭДОсн');
    const hasDeclared = doc.includes('<СвПрод');
    // Дешёвый отсев до полного разбора: 6,8 млн документов, в вертикали — несколько процентов
    if (!hasDeclared && (!main?.КодОКВЭД || !this.classifier.okvedMayMatch(main.КодОКВЭД))) return { company: null, skip: 'category' };

    const regionCode = tagAttrs(doc, 'СведМН')?.КодРегион ?? '';
    if (this.regions && !this.regions.has(regionCode)) return { company: null, skip: 'region' };

    const declared = allTagAttrs(doc, 'СвПрод').map((p) => ({ code: p.КодПрод ?? '', name: p.НаимПрод ?? '' }));
    const byOkved = this.classifier.categoriesForOkved(main?.КодОКВЭД, main?.НаимОКВЭД);
    const byDeclared = new Set<string>();
    const products: CompanyProduct[] = [];
    for (const d of declared) {
      for (const m of this.classifier.productsForOkpd2(d.code)) {
        products.push({ ...m, title: d.name || this.catalog.product(m.productId)!.name, code: d.code });
        byDeclared.add(m.categoryId);
      }
    }
    const categories = new Set([...byOkved, ...byDeclared]);
    if (!categories.size) return { company: null, skip: 'category' };

    const head = tagAttrs(doc, 'Документ') ?? {};
    const city = tagAttrs(doc, 'Город') ?? tagAttrs(doc, 'НаселПункт');
    const ssr = head.ССЧР ?? tagAttrs(doc, 'СведССЧР')?.ССЧР;
    return {
      company: {
        ...this.identity(doc),
        sme: SME_CATEGORY[head.КатСубМСП] ?? 'UNKNOWN',
        includedAt: isoDate(head.ДатаВклМСП),
        employees: ssr ? Number(ssr) : null,
        regionCode,
        regionName: this.regionName(regionCode, tagAttrs(doc, 'Регион')),
        city: city?.Наим ? titleCase(city.Наим) : null,
        okvedMain: { code: main?.КодОКВЭД ?? '', name: main?.НаимОКВЭД ?? '' },
        okvedAdd: allTagAttrs(doc, 'СвОКВЭДДоп').map((o) => ({ code: o.КодОКВЭД, name: o.НаимОКВЭД })),
        declared,
        categories: [...categories],
        products,
        matchedBy: { okved: byOkved, declared: [...byDeclared] },
      },
    };
  }

  /** ИНН, ОГРН и наименование юрлица или ИП. Пустой ИНН — если в документе нет ни того, ни другого. */
  private identity(doc: string): Pick<Company, 'inn' | 'ogrn' | 'name' | 'fullName' | 'entityType'> {
    const org = tagAttrs(doc, 'ОргВклМСП');
    if (org) {
      return {
        inn: org.ИННЮЛ ?? '',
        ogrn: org.ОГРН ?? null,
        name: prettyName(org.НаимОргСокр, org.НаимОрг),
        fullName: prettyName(org.НаимОрг, org.НаимОрг),
        entityType: 'LEGAL_ENTITY',
      };
    }
    const ip = tagAttrs(doc, 'ИПВклМСП');
    if (ip) {
      const fio = tagAttrs(doc, 'ФИОИП') ?? {};
      const person = [fio.Фамилия, fio.Имя, fio.Отчество].filter(Boolean).map((x) => titleCase(x)).join(' ');
      return { inn: ip.ИННФЛ ?? '', ogrn: ip.ОГРНИП ?? null, name: `ИП ${person}`.trim(), fullName: `Индивидуальный предприниматель ${person}`.trim(), entityType: 'IP' };
    }
    return { inn: '', ogrn: null, name: '', fullName: '', entityType: 'LEGAL_ENTITY' };
  }

  private regionName(code: string, reg: Record<string, string> | null): string {
    const fromCatalog = this.catalog.region(code)?.name;
    if (fromCatalog) return fromCatalog;
    if (!reg?.Наим) return code ? `Регион ${code}` : '';
    const type = (reg.Тип ?? '').toLowerCase();
    const n = reg.Наим;
    if (type.startsWith('г')) return n;
    if (type.startsWith('респ')) return n.toLowerCase().includes('республика') ? n : `Республика ${n}`;
    if (type.startsWith('обл')) return `${n} область`;
    if (type.startsWith('край')) return `${n} край`;
    if (type.includes('аобл') || type.includes('автономная')) return `${n} автономная область`;
    if (type.includes('ао') || type.includes('округ')) return `${n} автономный округ`;
    return `${n} ${reg.Тип ?? ''}`.trim();
  }
}

/**
 * Тип поставщика по сведениям реестра МСП. По одному ОКВЭД производитель не определяется:
 * «производитель (заявлено компанией)» — только если компания указала производимую продукцию.
 */
export class SupplierTypeAssessor {
  assess(c: Company): SupplierTypeAssessment {
    if (c.products.length) {
      const names = [...new Set(c.products.map((p) => `«${p.title}» (ОКПД2 ${p.code})`))].slice(0, 3).join(', ');
      return {
        type: 'MANUFACTURER',
        confidence: 0.65,
        basis: `в реестре МСП компания указала производимую продукцию: ${names}. Сведения заявлены самой компанией`,
      };
    }
    return {
      type: 'UNKNOWN',
      confidence: 0.2,
      basis: `основной ОКВЭД ${c.okvedMain.code} «${c.okvedMain.name}». Одного ОКВЭД недостаточно, чтобы подтвердить производство`,
    };
  }
}
