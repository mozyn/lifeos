/**
 * The bundled city list for the first-run "Where are you?" step (prayer-time location). The data is
 * GeoNames cities15000 (CC BY 4.0, https://www.geonames.org), selected and written once by
 * scripts/make-cities.mjs into cities-data.json; it is a lazy chunk of the app, so nothing here ever
 * calls an outside service.
 *
 * - Search folds case and diacritics (São Paulo = "sao paulo", Ta’if = "taif", Port-au-Prince =
 *   "port au prince") and takes a qualifier after the name: "detroit, mi", "london uk",
 *   "london ontario" (an admin1 name, a country code or English name, or a US/Canadian postal code).
 * - Ranking: exact name, then name prefix, then the prefix of a later word, then population.
 * - A device's time zone suggests its most populous city; the browser's own zone ids (Chrome says
 *   Asia/Calcutta and Europe/Kiev where GeoNames says Asia/Kolkata and Europe/Kyiv) are matched
 *   through Intl's canonical id.
 */

export interface City {
  name: string;
  admin1: string;
  country: string;
  lat: number;
  lon: number;
  tz: string;
  pop: number;
}

type Row = [name: string, admin1: string, country: string, lat: number, lon: number, tz: string, pop: number];

let loading: Promise<City[]> | null = null;

/** The whole list, most populous first. The JSON is its own chunk, fetched on first use. */
export function loadCities(): Promise<City[]> {
  loading ??= import('./cities-data.json').then(
    (m) => (m.default.cities as unknown as Row[]).map(([name, admin1, country, lat, lon, tz, pop]) => ({ name, admin1, country, lat, lon, tz, pop })),
    (err: unknown) => {
      loading = null; // a failed chunk load (offline before it was cached) can be retried
      throw err;
    },
  );
  return loading;
}

// Letters NFD does not decompose (Łódź, Đà Nẵng, Malmø, Gəncə, Baħar …).
const LETTERS: Record<string, string> = { ı: 'i', ł: 'l', đ: 'd', ð: 'd', ø: 'o', ß: 'ss', æ: 'ae', œ: 'oe', ə: 'e', ħ: 'h', þ: 'th' };

/** Lower case, no diacritics, no apostrophes or ʿayn/hamza marks, every other separator one space. */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[ıłđðøßæœəħþ]/g, (c) => LETTERS[c])
    .replace(/['’‘`´ʹʻʼʽʾʿˈ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

let regions: Intl.DisplayNames | null | undefined;
const countryNames = new Map<string, string>();

function countryName(code: string): string {
  let name = countryNames.get(code);
  if (name === undefined) {
    if (regions === undefined) {
      try {
        regions = new Intl.DisplayNames(['en'], { type: 'region' });
      } catch {
        regions = null;
      }
    }
    try {
      name = regions?.of(code) ?? code;
    } catch {
      name = code;
    }
    countryNames.set(code, name);
  }
  return name;
}

// What people type after a city name that is neither an admin1 name nor a country's name or code.
const COUNTRY_ALIASES: Record<string, string> = { uk: 'GB', britain: 'GB', 'great britain': 'GB', usa: 'US', america: 'US', uae: 'AE', ksa: 'SA' };
const POSTAL =
  'US:AL Alabama|AK Alaska|AZ Arizona|AR Arkansas|CA California|CO Colorado|CT Connecticut|DE Delaware|DC District of Columbia|FL Florida|GA Georgia|HI Hawaii|ID Idaho|IL Illinois|IN Indiana|IA Iowa|KS Kansas|KY Kentucky|LA Louisiana|ME Maine|MD Maryland|MA Massachusetts|MI Michigan|MN Minnesota|MS Mississippi|MO Missouri|MT Montana|NE Nebraska|NV Nevada|NH New Hampshire|NJ New Jersey|NM New Mexico|NY New York|NC North Carolina|ND North Dakota|OH Ohio|OK Oklahoma|OR Oregon|PA Pennsylvania|RI Rhode Island|SC South Carolina|SD South Dakota|TN Tennessee|TX Texas|UT Utah|VT Vermont|VA Virginia|WA Washington|WV West Virginia|WI Wisconsin|WY Wyoming;' +
  'CA:AB Alberta|BC British Columbia|MB Manitoba|NB New Brunswick|NL Newfoundland and Labrador|NS Nova Scotia|NT Northwest Territories|NU Nunavut|ON Ontario|PE Prince Edward Island|QC Quebec|SK Saskatchewan|YT Yukon';
let postal: Map<string, string> | null = null;

/** "US:mi" → "michigan" (folded admin1). */
function postalRegion(country: string, code: string): string | undefined {
  if (!postal) {
    postal = new Map();
    for (const part of POSTAL.split(';')) {
      const [cc, list] = part.split(':');
      for (const entry of list.split('|')) postal.set(`${cc}:${entry.slice(0, 2).toLowerCase()}`, fold(entry.slice(3)));
    }
  }
  return postal.get(`${country}:${code}`);
}

interface Prepared {
  city: City;
  name: string; // folded
  squash: string; // folded, no spaces ("saopaulo")
  admin1: string; // folded
  cc: string; // lower-case country code
  country: string; // folded English country name
}

const prepared = new WeakMap<City[], Prepared[]>();

function prepare(cities: City[]): Prepared[] {
  let list = prepared.get(cities);
  if (!list) {
    list = cities.map((city) => {
      const name = fold(city.name);
      return { city, name, squash: name.replace(/ /g, ''), admin1: fold(city.admin1), cc: city.country.toLowerCase(), country: fold(countryName(city.country)) };
    });
    prepared.set(cities, list);
  }
  return list;
}

/** 0 exact, 1 name prefix, 2 prefix of a later word, -1 no match. */
function nameTier(p: Prepared, q: string): number {
  const squash = q.replace(/ /g, '');
  if (p.name === q || p.squash === squash) return 0;
  if (p.name.startsWith(q) || p.squash.startsWith(squash)) return 1;
  if (p.name.includes(` ${q}`)) return 2;
  return -1;
}

const startsWord = (text: string, t: string) => text.startsWith(t) || text.includes(` ${t}`);

/** The part after the name: admin1 or country name (prefix of any word), country code, alias, postal code. */
function qualifies(p: Prepared, t: string): boolean {
  const code = t.replace(/ /g, '');
  if (code === p.cc || COUNTRY_ALIASES[t] === p.city.country) return true;
  if ((p.admin1 && startsWord(p.admin1, t)) || startsWord(p.country, t)) return true;
  return code.length === 2 && postalRegion(p.city.country, code) === p.admin1;
}

/** Up to `limit` cities for what the person typed; [] below two letters. */
export function searchCities(cities: City[], query: string, limit = 8): City[] {
  const comma = query.indexOf(',');
  const whole = fold(comma >= 0 ? query.slice(0, comma) : query);
  const after = comma >= 0 ? fold(query.slice(comma + 1)) : '';
  if (whole.replace(/ /g, '').length + after.length < 2 || !whole) return [];

  // "head, tail" with a comma; without one, every space is a possible split ("sao paulo brazil")
  const splits: [string, string][] = [];
  if (after) splits.push([whole, after]);
  else for (let i = whole.indexOf(' '); i > 0; i = whole.indexOf(' ', i + 1)) splits.push([whole.slice(0, i), whole.slice(i + 1)]);

  const hits: { city: City; tier: number }[] = [];
  for (const p of prepare(cities)) {
    let tier = after ? -1 : nameTier(p, whole);
    for (const [head, tail] of splits) {
      if (tier === 0) break;
      const t = nameTier(p, head);
      if (t >= 0 && (tier < 0 || t < tier) && qualifies(p, tail)) tier = t;
    }
    if (tier >= 0) hits.push({ city: p.city, tier });
  }
  hits.sort((a, b) => a.tier - b.tier || b.city.pop - a.city.pop);
  return hits.slice(0, limit).map((h) => h.city);
}

// "Qom Province" says no more than "Qom"
const GENERIC = /\s+(province|region|governorate|prefecture|state|oblast|county|district|municipality|city)$/;

/** "Detroit, Michigan, United States"; the admin1 is left out when it only repeats the name. */
export function cityLabel(c: City): string {
  const parts = [c.name];
  const admin1 = fold(c.admin1);
  if (admin1 && admin1 !== fold(c.name) && admin1.replace(GENERIC, '') !== fold(c.name)) parts.push(c.admin1);
  parts.push(countryName(c.country));
  return parts.join(', ');
}

const canonical = new Map<string, string | null>();

function canonicalZone(tz: string): string | null {
  let id = canonical.get(tz);
  if (id === undefined) {
    try {
      id = new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone;
    } catch {
      id = null;
    }
    canonical.set(tz, id);
  }
  return id;
}

function mostPopulous(cities: City[], match: (tz: string) => boolean): City | null {
  let best: City | null = null;
  for (const c of cities) if (match(c.tz) && (!best || c.pop > best.pop)) best = c;
  return best;
}

/** The most populous city in an IANA zone (the device's, for a first suggestion), or null. */
export function suggestForZone(cities: City[], tz: string): City | null {
  if (!tz) return null;
  const exact = mostPopulous(cities, (z) => z === tz);
  if (exact) return exact;
  const want = canonicalZone(tz);
  return want ? mostPopulous(cities, (z) => canonicalZone(z) === want) : null;
}
