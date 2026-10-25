import type { Company } from '../domain/company';

export interface ValidationIssue {
  field: 'inn' | 'ogrn' | 'region' | 'name';
  reason: string;
}

const INN10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

const digit = (s: string, weights: number[]) => (weights.reduce((sum, w, i) => sum + w * Number(s[i]), 0) % 11) % 10;

/**
 * Проверка реквизитов компании перед записью в базу: ИНН и ОГРН (длина по виду лица и контрольные цифры),
 * код региона и наименование. Компания с замечаниями не попадает в выдачу, а уходит в карантин с причиной.
 */
export class CompanyValidator {
  validate(c: Company): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const innLength = c.entityType === 'IP' ? 12 : 10;
    if (!c.inn) issues.push({ field: 'inn', reason: 'нет ИНН' });
    else if (!new RegExp(`^\\d{${innLength}}$`).test(c.inn)) issues.push({ field: 'inn', reason: `ИНН не из ${innLength} цифр` });
    else if (!CompanyValidator.innValid(c.inn)) issues.push({ field: 'inn', reason: 'неверная контрольная цифра ИНН' });

    if (c.ogrn !== null) {
      const ogrnLength = c.entityType === 'IP' ? 15 : 13;
      if (!new RegExp(`^\\d{${ogrnLength}}$`).test(c.ogrn)) issues.push({ field: 'ogrn', reason: `ОГРН не из ${ogrnLength} цифр` });
      else if (!CompanyValidator.ogrnValid(c.ogrn)) issues.push({ field: 'ogrn', reason: 'неверная контрольная цифра ОГРН' });
    }

    if (!/^\d{2}$/.test(c.regionCode)) issues.push({ field: 'region', reason: 'нет кода региона' });
    // \b в JavaScript не видит границу кириллического слова, поэтому префикс «ИП» отделяем явно
    if (!c.name.replace(/^ИП(?=\s|$)/u, '').trim()) issues.push({ field: 'name', reason: 'нет наименования' });
    return issues;
  }

  /** Контрольные цифры ИНН юрлица (10 знаков) или физлица/ИП (12 знаков). */
  static innValid(inn: string): boolean {
    if (/^\d{10}$/.test(inn)) return digit(inn, INN10) === Number(inn[9]);
    if (/^\d{12}$/.test(inn)) return digit(inn, INN11) === Number(inn[10]) && digit(inn, INN12) === Number(inn[11]);
    return false;
  }

  /** Контрольная цифра ОГРН (13 знаков, остаток от деления на 11) или ОГРНИП (15 знаков, на 13). */
  static ogrnValid(ogrn: string): boolean {
    if (!/^\d{13}$|^\d{15}$/.test(ogrn)) return false;
    const body = BigInt(ogrn.slice(0, -1));
    const mod = ogrn.length === 13 ? 11n : 13n;
    return Number((body % mod) % 10n) === Number(ogrn.at(-1));
  }
}
