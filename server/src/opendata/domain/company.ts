export type EntityType = 'LEGAL_ENTITY' | 'IP';

export interface Okved {
  code: string;
  name: string;
}

/** Продукция, которую компания сама указала в реестре МСП (ОКПД2). */
export interface DeclaredProduct {
  code: string;
  name: string;
}

/** Заявленная продукция, сопоставленная с товаром справочника. */
export interface CompanyProduct {
  productId: string;
  categoryId: string;
  title: string;
  /** Код ОКПД2 из реестра. */
  code: string;
}

/** Субъект МСП из реестра, отнесённый к категориям справочника. */
export interface Company {
  inn: string;
  ogrn: string | null;
  name: string;
  fullName: string;
  entityType: EntityType;
  sme: string;
  includedAt: string | null;
  employees: number | null;
  regionCode: string;
  regionName: string;
  city: string | null;
  okvedMain: Okved;
  okvedAdd: Okved[];
  declared: DeclaredProduct[];
  categories: string[];
  products: CompanyProduct[];
  /** Чем обоснована каждая категория: основным ОКВЭД или заявленной продукцией (для диагностики покрытия). */
  matchedBy: { okved: string[]; declared: string[] };
}

export interface SupplierTypeAssessment {
  type: 'MANUFACTURER' | 'UNKNOWN';
  confidence: number;
  basis: string;
}
