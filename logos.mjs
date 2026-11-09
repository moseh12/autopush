// Builds logos.json: team / league name -> logo image URL.
// Runs after each poll. Looks up only names it has never seen, through
// API-Football's free plan (100 requests/day), so the app never needs a key.
//
// Env:
//   API_FOOTBALL_KEY   free key from dashboard.api-football.com (GitHub secret)
//   LOGO_DAILY_BUDGET  max lookups per day (default 90, free plan is 100)
//   LOGO_PER_RUN       max lookups per run (default 8)
//   API_FOOTBALL_BASE  override for testing
//
// Hand fixes: put  "Team name": "https://...png"  (or null to hide) in
// logo_overrides.json under "teams" or "leagues". Overrides always win.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const KEY = process.env.API_FOOTBALL_KEY;
const BASE = (process.env.API_FOOTBALL_BASE || 'https://v3.football.api-sports.io').replace(/\/$/, '');
const DAILY = Number(process.env.LOGO_DAILY_BUDGET || 90);
const PER_RUN = Number(process.env.LOGO_PER_RUN || 8);
const RETRY_DAYS = 14; // retry names that were not found after this many days
const here = (f) => new URL(`./${f}`, import.meta.url).pathname;
const LOGOS = process.env.LOGOS_FILE || here('logos.json');
const OVERRIDES = here('logo_overrides.json');
const CONFIG = process.env.CONFIG_FILE || here('apps.json');

if (!KEY) {
  console.log('logos: API_FOOTBALL_KEY not set — skipping');
  process.exit(0);
}

// Common short names -> what API-Football calls them.
const ALIASES = {
  'man city': 'Manchester City', 'man utd': 'Manchester United', 'man united': 'Manchester United',
  'spurs': 'Tottenham', 'tottenham hotspur': 'Tottenham', 'wolves': 'Wolves', 'newcastle utd': 'Newcastle',
  'nottm forest': 'Nottingham Forest', "nott'm forest": 'Nottingham Forest', 'psg': 'Paris Saint Germain',
  'inter milan': 'Inter', 'ac milan': 'AC Milan', 'bayern munich': 'Bayern Munich', 'atletico': 'Atletico Madrid',
};

export const norm = (s) =>
  String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();

const read = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8') || 'null') ?? fallback : fallback);

const config = read(CONFIG, { apps: [] });
const db = read(LOGOS, {});
db.teams ??= {};
db.leagues ??= {};
db.misses ??= {}; // "t:name" | "l:name" -> ISO date last tried without result
db.quota ??= { day: '', used: 0 };
const overrides = read(OVERRIDES, { teams: {}, leagues: {} });

const today = new Date().toISOString().slice(0, 10);
if (db.quota.day !== today) db.quota = { day: today, used: 0 };

// ---------------------------------------------------------------- collect names
const teams = new Map(); // norm -> original (today's tips are added first, so they are looked up first)
const leagues = new Map();
const urls = new Set();
const historyUrls = new Set();
for (const app of config.apps.filter((a) => a.enabled !== false)) {
  const base = (app.baseUrl || config.defaults?.baseUrl || '').replace(/\/$/, '');
  for (const ep of app.endpoints || []) urls.add(`${base}/${ep.path.replace(/^\//, '')}`);
  for (const path of app.logoEndpoints || []) historyUrls.add(`${base}/${path.replace(/^\//, '')}`);
}
for (const url of [...urls, ...[...historyUrls].filter((u) => !urls.has(u))]) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    const body = await res.json();
    const list = Array.isArray(body) ? body : body?.data;
    for (const t of Array.isArray(list) ? list : []) {
      for (const n of [t.team_one, t.team_two]) if (norm(n)) teams.set(norm(n), String(n).trim());
      if (norm(t.league_name)) leagues.set(norm(t.league_name), String(t.league_name).trim());
    }
  } catch (e) {
    console.warn(`logos: skip ${url}: ${e.message}`);
  }
}

// ---------------------------------------------------------------- overrides
for (const [k, v] of Object.entries(overrides.teams || {})) db.teams[norm(k)] = v;
for (const [k, v] of Object.entries(overrides.leagues || {})) db.leagues[norm(k)] = v;

// ---------------------------------------------------------------- lookups
const due = (kind, key) => {
  const store = kind === 't' ? db.teams : db.leagues;
  if (key in store) return false;
  const miss = db.misses[`${kind}:${key}`];
  return !miss || (Date.now() - Date.parse(miss)) / 86400000 >= RETRY_DAYS;
};

// league_name in this API is usually a country ("England"); the app shows a flag for those,
// so league lookups are off unless LOOKUP_LEAGUES=1.
const LOOKUP_LEAGUES = process.env.LOOKUP_LEAGUES === '1';
const queue = [
  ...[...teams].filter(([k]) => due('t', k)).map(([k, name]) => ['t', k, name]),
  ...(LOOKUP_LEAGUES ? [...leagues].filter(([k]) => due('l', k)).map(([k, name]) => ['l', k, name]) : []),
];

let done = 0;
for (const [kind, key, name] of queue) {
  if (done >= PER_RUN || db.quota.used >= DAILY) break;
  const term = searchTerm(name);
  if (term.length < 3) {
    db.misses[`${kind}:${key}`] = new Date().toISOString();
    continue;
  }
  if (done > 0) await sleep(6500); // free plan allows ~10 requests per minute
  done++;
  db.quota.used++;
  try {
    const logo = kind === 't' ? await findTeam(term, name) : await findLeague(term, name);
    if (logo) {
      (kind === 't' ? db.teams : db.leagues)[key] = logo;
      delete db.misses[`${kind}:${key}`];
      console.log(`logos: ${kind === 't' ? 'team' : 'league'} "${name}" ✓`);
    } else {
      db.misses[`${kind}:${key}`] = new Date().toISOString();
      console.log(`logos: ${kind === 't' ? 'team' : 'league'} "${name}" not found`);
    }
  } catch (e) {
    console.warn(`logos: lookup "${name}" failed: ${e.message}`);
    if (/quota|limit|requests|token|key|subscription|account/i.test(e.message)) break; // stop: plan or key problem
  }
}

db.updated = new Date().toISOString();
writeFileSync(LOGOS, JSON.stringify(sortKeys(db), null, 1) + '\n');
const left = queue.length - done;
console.log(`logos: ${done} lookups this run, ${db.quota.used}/${DAILY} today, ${Math.max(0, left)} waiting`);

// ---------------------------------------------------------------- helpers
function searchTerm(name) {
  // API-Football search accepts letters, numbers and spaces only.
  return String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\b(fc|cf|afc|sc|ac|fk|sk|cd|ud)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

async function api(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'x-apisports-key': KEY },
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json();
  const errs = json?.errors && (Array.isArray(json.errors) ? json.errors : Object.values(json.errors));
  if (errs && errs.length) throw new Error(errs.join('; '));
  return json?.response || [];
}

async function findTeam(term, original) {
  const alias = ALIASES[norm(original)];
  if (alias) {
    term = searchTerm(alias);
    original = alias;
  }
  const list = await api(`/teams?search=${encodeURIComponent(term)}`);
  if (!list.length) return null;
  const want = norm(original);
  const scored = list.map((r) => {
    const n = norm(r.team?.name);
    let s = 0;
    if (n === want) s += 100;
    else if (n.startsWith(want) || want.startsWith(n)) s += 40;
    if (r.team?.national) s -= 5; // prefer clubs unless the name is an exact match
    if (/\b(u\d\d|women|w|ii|b)\b/.test(n) && !/\b(u\d\d|women|w|ii|b)\b/.test(want)) s -= 50;
    return { s, logo: r.team?.logo };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored[0].s > -40 ? scored[0].logo || null : null;
}

async function findLeague(term, original) {
  let list = await api(`/leagues?search=${encodeURIComponent(term)}`);
  const words = term.split(' ');
  // "England Premier League" / "Spain La Liga": search the country, then match the name.
  if (!list.length && words.length >= 2 && words[0].length >= 3) {
    await sleep(6500);
    db.quota.used++;
    list = await api(`/leagues?search=${encodeURIComponent(words[0])}`);
  }
  if (!list.length) return null;
  const want = norm(original);
  const scored = list.map((r) => {
    const n = norm(r.league?.name);
    const c = norm(r.country?.name);
    let s = 0;
    if (n === want || `${c} ${n}` === want || `${n} ${c}` === want) s += 100;
    if (c && want.includes(c)) s += 30; // "England Premier League" -> England
    if (n && want.includes(n)) s += 20;
    else if (n && !n.includes(want)) s -= 60; // unrelated league from a country search
    if (c === 'england' || c === 'world') s += 3; // sensible default for bare "Premier League"
    if (r.league?.type === 'League') s += 1;
    return { s, logo: r.league?.logo };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored[0].s > 0 ? scored[0].logo || null : null;
}

function sortKeys(o) {
  const out = {};
  for (const k of ['updated', 'quota', 'teams', 'leagues', 'misses']) {
    if (o[k] === undefined) continue;
    out[k] = typeof o[k] === 'object' && !Array.isArray(o[k]) && k !== 'quota'
      ? Object.fromEntries(Object.entries(o[k]).sort(([a], [b]) => a.localeCompare(b)))
      : o[k];
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
