// Which language to write to a client in. The CRM card's language wins (the team set it, or saved the CRM's guess);
// without it: the country, then the phone's country code, then the email's domain. Same rules as the CRM's
// language chip (app/src/lib/clientLanguage.ts there), so Auti and the team agree.
export const LANGUAGES = ['en', 'pt', 'es', 'fr', 'de', 'ru'];

const PT_COUNTRIES = /portugal|angola|brasil|brazil|mo[cç]ambique|mozambique|cabo verde|cape verde|guin[eé].?bissau|s[aã]o tom[eé]|timor/i;
const EN_COUNTRIES = /united kingdom|^uk$|^gb$|england|scotland|wales|northern ireland|ireland|namibia|united states|^usa?$|south africa|australia|new zealand|canada/i;
const OTHER = [[/espa[nñ]a|spain|m[eé]xico|argentina|colombia|chile/i, 'es'], [/france|fran[cç]a|belgique|luxembourg|s[eé]n[eé]gal/i, 'fr'],
  [/deutschland|germany|alemanha|[oö]sterreich|austria|schweiz/i, 'de'], [/russia|r[uú]ssia|россия/i, 'ru']];
const PHONE = [['351', 'pt'], ['244', 'pt'], ['55', 'pt'], ['258', 'pt'], ['238', 'pt'], ['245', 'pt'], ['239', 'pt'],
  ['44', 'en'], ['353', 'en'], ['264', 'en'], ['27', 'en'], ['1', 'en'], ['61', 'en'], ['34', 'es'], ['33', 'fr'], ['49', 'de'], ['7', 'ru']];
const TLD = { pt: 'pt', ao: 'pt', br: 'pt', mz: 'pt', cv: 'pt', uk: 'en', ie: 'en', na: 'en', za: 'en', es: 'es', fr: 'fr', de: 'de', at: 'de', ru: 'ru' };

/** { code, set, reason }: set = it is on the CRM card; reason = 'set' | 'country' | 'phone' | 'email' | null. */
export function languageFor(c = {}) {
  const set = String(c.language || '').toLowerCase();
  if (LANGUAGES.includes(set)) return { code: set, set: true, reason: 'set' };
  const country = String(c.country || '').trim();
  if (country) {
    if (PT_COUNTRIES.test(country)) return { code: 'pt', set: false, reason: 'country' };
    if (EN_COUNTRIES.test(country)) return { code: 'en', set: false, reason: 'country' };
    const o = OTHER.find(([re]) => re.test(country));
    if (o) return { code: o[1], set: false, reason: 'country' };
  }
  const raw = String(c.phone || '').replace(/[^\d+]/g, '');
  if (/^(\+|00)/.test(raw)) {
    const d = raw.replace(/^\+|^00/, '');
    const hit = PHONE.filter(([p]) => d.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0];
    if (hit) return { code: hit[1], set: false, reason: 'phone' };
  }
  const tld = String(c.email || '').toLowerCase().split('@')[1]?.split('.').pop() || '';
  if (TLD[tld]) return { code: TLD[tld], set: false, reason: 'email' };
  return { code: null, set: false, reason: null };
}

/** How to write it, in words for the model: Portugal and Angola write Portuguese differently. */
export function writeIn(code, { country = '', phone = '', market = '' } = {}) {
  if (code === 'pt') {
    const angola = /angola/i.test(country) || /^(\+|00)?244/.test(String(phone).replace(/[^\d+]/g, '')) || market === 'angola';
    return angola ? 'Portuguese, as written in Angola' : 'European Portuguese (pt-PT, never Brazilian forms)';
  }
  return { en: 'English (UK)', es: 'Spanish', fr: 'French', de: 'German', ru: 'Russian' }[code] || null;
}
