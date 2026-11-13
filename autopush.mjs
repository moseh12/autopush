// Automatic push notifications for all your tips apps — no backend changes.
//
// Every run (GitHub Actions cron):
//   1. fetches each app's tip endpoints from the shared API
//   2. compares with state.json from the previous run
//   3. sends ONE grouped push per endpoint (section) for new tips, and one per section for tips that just WON
//   4. writes the new state.json (the workflow commits it back)
//
// Env:
//   FCM_SERVICE_ACCOUNTS  JSON object { "<app id>": <service-account json>, ... }  (GitHub secret)
//   MODE                  "auto" (every tick: poll + whatever is due on the Nairobi clock) | "poll" | "daily" | "test"
//                         | "promo" (hourly Join-VIP push) | "discount" (4 PM) | "cashback" (midnight)
//
// Timing (Nairobi time, apps.json "defaults.schedule"): daily 09:00, discount 16:00, cashback 00:00,
// promo hourly outside quiet hours. In "auto" mode each one is sent at most once, and only within
// "windowHours" after its time — a late trigger never sends a 9 AM reminder in the evening.
//   DRY_RUN=1             print messages instead of sending
//   STATE_FILE            default ./state.json
//   CONFIG_FILE           default ./apps.json
//   ONLY_APP              limit to one app id (handy for "test")
//
// Instant runs: besides the cron, the workflow also runs on a `repository_dispatch`
// event (type "tips-updated"). Your backend calls it right after a tip changes,
// so the congratulations push goes out in about a minute.
//
// VIP privacy: pushes for VIP endpoints never include teams, predictions or odds.
//   An endpoint is VIP when it has "vip": true, "screen": "vip", or "vip" in its label/path.
//   apps.json (defaults or per app):
//     "revealVipResults": false   true = show match details when a VIP tip WINS
//     "vipNewBody":  "..."         text for new VIP tips
//     "vipWonBody":  "..."         text for a VIP win (when not revealed)
//     "image": "https://..."      color logo shown in every push of that app (Android small icon is always one color)
//
// Wording variety: every notification text comes from messages.json. The bot picks one at
// random and never reuses a wording it sent recently to that app (remembered in state.json
// under "_recent"). Per-app overrides: "messages": { "newVip": [...], ... } in apps.json.

import { createHash, createSign } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const MODE = process.env.MODE || 'poll';
const DRY_RUN = process.env.DRY_RUN === '1';
const STATE_FILE = process.env.STATE_FILE || new URL('./state.json', import.meta.url).pathname;
const CONFIG_FILE = process.env.CONFIG_FILE || new URL('./apps.json', import.meta.url).pathname;

const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
const defaults = config.defaults || {};
const apps = config.apps
  .filter((a) => a.enabled !== false)
  .filter((a) => !process.env.ONLY_APP || a.id === process.env.ONLY_APP);

const accounts = loadAccounts();
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8') || '{}') : {};

let failures = 0;
const FORCE = process.env.FORCE === '1' || process.env.FORCE_PROMO === '1';

// Nairobi-local date/hour, used so a job never sends twice for the same day/hour
// (GitHub's timer and cron-job.org may both fire).
function localNow(offset = 3) {
  const d = new Date(Date.now() + offset * 3600000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}
function firstTime(key, id) {
  state._sent ??= {};
  if (state._sent[key] === id && !FORCE) {
    console.log(`${key}: already sent for ${id} — skipped`);
    return false;
  }
  state._sent[key] = id;
  return true;
}
const tokenCache = new Map(); // must be declared before main runs (top-level await)

// ---------------------------------------------------------------- wording variety
const MESSAGES_FILE = process.env.MESSAGES_FILE || new URL('./messages.json', import.meta.url).pathname;
const MESSAGES = existsSync(MESSAGES_FILE) ? JSON.parse(readFileSync(MESSAGES_FILE, 'utf8')) : {};
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Nairobi-local weekday/hour and greeting words. */
function timeVars(offset = 3) {
  const d = new Date(Date.now() + offset * 3600000);
  const hour = d.getUTCHours();
  const dow = d.getUTCDay();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'tonight';
  return { day: DAY_NAMES[dow], dayKey: DAY_KEYS[dow], hour, greet, part };
}

/** Match details from one tip, for {match} {home} {away} {league} {time} {pick} {odds} {score}. */
function tipVars(t = {}) {
  const s = (v) => String(v ?? '').trim();
  const home = s(t.team_one), away = s(t.team_two);
  return {
    home, away,
    match: home && away ? `${home} vs ${away}` : home || away,
    league: s(t.league_name), time: s(t.time), pick: s(t.tips_name),
    odds: s(t.odds_value), score: s(t.results),
  };
}

const fillText = (text, vars) => String(text ?? '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const shortHash = (x) => createHash('sha1').update(x).digest('hex').slice(0, 8);

/** choose(), or the first fallback wording filled in as-is if nothing else fits. */
function chooseOr(app, kind, vars, fallback) {
  const all = { app: app.name, ...timeVars(defaults.utcOffset ?? 3), ...vars };
  return choose(app, kind, vars, fallback)
    ?? { title: fillText(fallback[0].title, all), body: fillText(fallback[0].body, all) };
}

/**
 * Picks a wording for [kind] that this app hasn't seen recently.
 * Pool order: app.messages[kind] > legacy app[kind].messages > legacy defaults[kind].messages
 *             > messages.json[kind] > [fallback].
 * Skips wordings whose placeholders have no value, or whose "days"/"hours" don't match now.
 */
function choose(app, kind, vars, fallback = []) {
  const t = timeVars(defaults.utcOffset ?? 3);
  const all = { app: app.name, day: t.day, greet: t.greet, part: t.part, ...vars };
  const pool = app.messages?.[kind] || app[kind]?.messages || defaults.messages?.[kind]
    || defaults[kind]?.messages || MESSAGES[kind] || fallback;

  const usable = pool.filter((m) => {
    if (!m || !m.title || !m.body) return false;
    if (m.days && !m.days.map((d) => String(d).toLowerCase().slice(0, 3)).includes(t.dayKey)) return false;
    if (m.hours) {
      const [from, to] = m.hours;
      const inside = from <= to ? t.hour >= from && t.hour < to : t.hour >= from || t.hour < to;
      if (!inside) return false;
    }
    const needed = [...(m.title + ' ' + m.body).matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
    return needed.every((k) => {
      const v = all[k];
      return v !== undefined && v !== null && String(v).trim() !== '' && String(v) !== '0';
    });
  });
  if (!usable.length) return null;

  state._recent ??= {};
  const key = `${app.id}:${kind}`;
  const recent = state._recent[key] ?? [];
  const fresh = usable.filter((m) => !recent.includes(shortHash(m.title + m.body)));
  const candidates = fresh.length ? fresh : usable;
  const msg = candidates[Math.floor(Math.random() * candidates.length)];

  // Remember roughly the last 70% of the pool, so wordings come back only after the rest were used.
  const keep = Math.max(1, Math.min(Math.floor(usable.length * 0.7), 20));
  state._recent[key] = [shortHash(msg.title + msg.body), ...recent.filter((h) => h !== shortHash(msg.title + msg.body))].slice(0, keep);

  return { title: fillText(msg.title, all), body: fillText(msg.body, all), image: msg.image };
}

// ---------------------------------------------------------------- main
if (MODE === 'auto') {
  await auto();
} else if (MODE === 'daily') {
  await daily();
} else if (MODE === 'promo') {
  await promo();
} else if (MODE === 'discount' || MODE === 'cashback') {
  await offer(MODE);
} else if (MODE === 'test') {
  for (const app of apps) {
    await push(app, `✅ ${app.name}: notifications work`, 'This is a test push from GitHub Actions.', {
      type: 'test', screen: 'free',
    });
  }
} else {
  await poll();
}
if (MODE !== 'test') writeFileSync(STATE_FILE, JSON.stringify(state, null, 1) + '\n');

if (failures) {
  console.error(`${failures} push(es) failed`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------- auto (one tick)
async function auto() {
  const sch = { daily: 9, discount: 16, cashback: 0, windowHours: 2, ...(defaults.schedule || {}) };
  const offset = defaults.utcOffset ?? 3;
  const { hour } = localNow(offset);
  const due = (at) => at !== false && at != null && ((hour - at + 24) % 24) < sch.windowHours;

  await poll();
  if (due(sch.daily)) await daily();
  if (due(sch.discount)) await offer('discount');
  if (due(sch.cashback)) await offer('cashback');
  await promo();
}

async function daily() {
  if (!firstTime('daily', localNow(defaults.utcOffset ?? 3).date)) return;
  for (const app of apps) {
    const d = { ...defaults.daily, ...app.daily };
    const m = choose(app, 'daily', {}, d.title && d.body ? [{ title: d.title, body: d.body }] : [])
      ?? { title: "🔥 Today's tips are ready", body: 'Fresh free and VIP predictions are live.' };
    await push(app, m.title, m.body, { type: 'daily', screen: d.screen || 'free', tag: 'daily_reminder' }, m.image);
  }
}

// ---------------------------------------------------------------- polling
async function poll() {
  const cache = new Map(); // same URL fetched once even if several apps use it

  for (const app of apps) {
    const appState = (state[app.id] ??= {});
    const wonStatuses = (app.wonStatuses || defaults.wonStatuses || ['won']).map((s) => s.toLowerCase());

    for (const ep of app.endpoints) {
      const url = `${(app.baseUrl || defaults.baseUrl).replace(/\/$/, '')}/${ep.path.replace(/^\//, '')}`;
      let tips;
      try {
        if (!cache.has(url)) cache.set(url, fetchTips(url));
        tips = await cache.get(url);
      } catch (e) {
        console.warn(`[${app.id}] skip ${url}: ${e.message}`);
        continue; // keep old state so nothing is re-announced later
      }

      const previous = appState[ep.path];
      const current = {};
      for (const t of tips) current[tipKey(t)] = String(t.status ?? '').toLowerCase();
      appState[ep.path] = current;

      // First time we see this endpoint: remember it, don't spam existing tips.
      if (!previous) {
        console.log(`[${app.id}] ${ep.path}: baseline saved (${tips.length} tips)`);
        continue;
      }

      const notify = ep.notify || ['new', 'won'];

      if (notify.includes('new')) {
        const fresh = tips.filter((t) => !(tipKey(t) in previous));
        if (fresh.length) {
          const vip = isVip(ep);
          const many = fresh.length > 1;
          // VIP: never reveal teams, prediction or odds — only the section and how many.
          const vars = vip
            ? { label: ep.label, count: fresh.length, more: fresh.length - 1 }
            : { label: ep.label, count: fresh.length, more: fresh.length - 1, ...tipVars(fresh[0]) };
          const kind = (vip ? 'newVip' : 'newFree') + (many ? 'Many' : '');
          const legacy = vip
            ? [{ title: many ? `👑 {count} new VIP tips in {label}` : `👑 New VIP tip in {label}`,
                 body: app.vipNewBody ?? defaults.vipNewBody ?? "Unlock VIP in the app to view today's predictions 🔒" }]
            : [{ title: many ? '⚽ {count} new tips in {label}' : '⚽ New tip in {label}',
                 body: describe(fresh[0]) + (many ? ` + ${fresh.length - 1} more` : '') + ' · Free' }];
          const { title, body, image } = chooseOr(app, kind, vars, legacy);
          await push(app, title, body, {
            type: vip ? 'vip_tips' : 'new_tips', vip: vip ? 'true' : 'false',
            screen: ep.screen || 'free', category: ep.label,
            count: fresh.length, tag: `new_${ep.path}`,
          }, ep.image || image);
        }
      }

      if (notify.includes('won')) {
        const wins = tips.filter((t) => {
          const k = tipKey(t);
          return wonStatuses.includes(current[k]) && k in previous && previous[k] !== current[k];
        });
        if (wins.length) await pushWins(app, ep, wins);
      }
    }
  }
}

// One congratulations push per section, with that section's total odds.
async function pushWins(app, ep, wins) {
  const vip = isVip(ep);
  const reveal = app.revealVipResults ?? defaults.revealVipResults ?? false;
  const hide = vip && !reveal;

  const odds = wins.map((t) => parseFloat(String(t.odds_value ?? '').replace(',', '.')));
  const total = odds.every((o) => o > 0) ? odds.reduce((a, b) => a * b, 1).toFixed(2) : null;

  const many = wins.length > 1;
  const kind = (hide ? 'wonVip' : 'wonFree') + (many ? 'Many' : '');
  // Hidden VIP wins only get the section, count, odds and total — never teams or the pick.
  const vars = hide
    ? { label: ep.label, count: wins.length, more: wins.length - 1, total }
    : { label: ep.label, count: wins.length, more: wins.length - 1, total, ...tipVars(wins[0]) };
  const odd = total ? ` · total odds ${total}` : '';
  const legacy = [{
    title: many ? `🎉 Congratulations! {label} — {count} tips WON ✅` : '🎉 Congratulations! {label} WON ✅',
    body: hide
      ? (many ? `${wins.length} VIP tips WON${odd} 💰 Join VIP 👑`
              : (app.vipWonBody ?? defaults.vipWonBody ?? 'Our VIP tip just WON 💰 Join VIP for the next one 👑'))
      : (many ? `${describe(wins[0])} and ${wins.length - 1} more${odd} 💰` : `${describe(wins[0])} 💰 Cash out and enjoy!`),
  }];
  const { title, body, image } = chooseOr(app, kind, vars, legacy);

  await push(app, title, body, {
    type: 'result', vip: vip ? 'true' : 'false', screen: 'proof',
    category: ep.label, count: wins.length, total_odds: total ?? undefined,
    tag: `won_${ep.path}`, // per section, so one section's push doesn't replace another's
  }, image);
}

// ---------------------------------------------------------------- daily VIP offers
// "discount": 16:00 Nairobi (30% off)     "cashback": 00:00 Nairobi (50% cashback)
// Placeholders: {app} {percent}. One message per day, rotating.
function offers() { return {
  discount: {
    percent: 30,
    messages: [
      { title: '🎁 {percent}% OFF VIP — today only', body: 'Join VIP now and save {percent}% on today\'s premium picks. Tap to claim before it ends ⏳' },
      { title: '🔥 VIP flash sale: {percent}% OFF', body: 'All VIP plans are {percent}% off right now. Don\'t miss tonight\'s games 👑' },
      { title: '💎 {percent}% OFF VIP access', body: 'Unlock correct scores, HT/FT and big-odds picks for less. Offer ends soon ⏳' },
    ],
  },
  cashback: {
    percent: 50,
    messages: [
      { title: '💸 Instant {percent}% cashback', body: 'Subscribe now for instant {percent}% cashback 💰 Join VIP in {app} tonight.' },
      { title: '🌙 Midnight cashback is live', body: 'Subscribe now for instant {percent}% cashback on VIP 💸 Tap to join.' },
      { title: '💰 Get {percent}% back instantly', body: 'Subscribe now for instant {percent}% cashback and unlock today\'s VIP tips 👑' },
    ],
  },
}; }

async function offer(kind) {
  const base = offers()[kind];
  const cfg = { ...(defaults[kind] || {}) };
  if (!firstTime(kind, localNow(defaults.utcOffset ?? 3).date)) return;
  for (const app of apps) {
    const c = { ...cfg, ...(app[kind] || {}) };
    if (c.enabled === false) continue;
    const vars = { percent: c.percent ?? base.percent };
    const msg = choose(app, kind, vars, base.messages);
    if (!msg) continue;
    await push(app, msg.title, msg.body, {
      type: kind, vip: 'true', screen: c.screen || 'vip',
      percent: vars.percent, tag: `vip_${kind}`,
    }, msg.image || c.image);
  }
}

// ---------------------------------------------------------------- hourly VIP promo
// Rotating "Join VIP" messages. Placeholders: {app} {vipCount} {vipWon}.
// A message using {vipCount}/{vipWon} is skipped when that number is 0.
function defaultPromo() { return [
  { title: '👑 VIP tips are live', body: '{vipCount} premium picks are waiting in VIP today. Unlock them before kick-off ⏰' },
  { title: '🔥 VIP members are winning', body: '{vipWon} VIP tips already WON 💰 Don\'t miss the next one — join VIP now.' },
  { title: '💎 Bigger odds live in VIP', body: 'Correct scores, HT/FT and high-odds picks are for VIP members only. Join today 👑' },
  { title: '⏳ Kick-off is getting close', body: 'Today\'s VIP picks are ready. Join VIP and go into the games with confidence.' },
  { title: '🏆 Stop guessing, start winning', body: 'Our analysts did the research for you. Unlock today\'s VIP predictions 🔓' },
  { title: '🎯 The best picks are in VIP', body: 'Every VIP pick, every day, straight in {app}. Tap to unlock 🔓' },
  { title: '💰 Small stakes, big odds', body: 'VIP accumulators with total odds you won\'t find in free tips. Join VIP now 👑' },
]; }

async function promo() {
  const cfg = { ...(defaults.promo || {}) };
  if (cfg.enabled === false) return console.log('promo disabled');

  // Quiet hours in local time (default Nairobi UTC+3, no pushes 22:00–07:59).
  const offset = cfg.utcOffset ?? 3;
  const hour = (new Date().getUTCHours() + offset + 24) % 24;
  const [qStart, qEnd] = cfg.quietHours ?? [22, 8];
  const quiet = qStart > qEnd ? hour >= qStart || hour < qEnd : hour >= qStart && hour < qEnd;
  if (quiet && process.env.FORCE_PROMO !== '1') return console.log(`promo skipped: quiet hours (${hour}:00 local)`);
  if (hour === (cfg.skipHour ?? 16) && process.env.FORCE_PROMO !== '1') return console.log('promo skipped: discount offer goes out this hour');
  if (!firstTime('promo', `${localNow(offset).date} ${hour}h`)) return;

  for (const app of apps) {
    const appCfg = { ...cfg, ...(app.promo || {}) };
    if (appCfg.enabled === false) continue;

    // Counts from the last poll (state.json) — no extra API calls.
    let vipCount = 0, vipWon = 0;
    const wonStatuses = (app.wonStatuses || defaults.wonStatuses || ['won']).map((x) => x.toLowerCase());
    for (const ep of app.endpoints) {
      if (!isVip(ep)) continue;
      const tips = Object.values(state[app.id]?.[ep.path] || {});
      vipCount += tips.length;
      vipWon += tips.filter((st) => wonStatuses.includes(st)).length;
    }

    const msg = choose(app, 'promo', { vipCount, vipWon }, defaultPromo());
    if (!msg) continue;
    await push(app, msg.title, msg.body, {
      type: 'promo', vip: 'true', screen: 'vip',
      tag: 'vip_promo', // replaces the previous promo, so the tray isn't flooded
    }, msg.image || appCfg.image);
  }
}

async function fetchTips(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : body?.data;
  if (!Array.isArray(list)) throw new Error('response is not a list');
  return list;
}

function tipKey(t) {
  if (t.id != null) return `id:${t.id}`;
  const raw = [t.date, t.time, t.team_one, t.team_two, t.tips_name, t.category].map((v) => String(v ?? '').trim().toLowerCase()).join('|');
  return createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

// An endpoint is VIP if apps.json marks it with "vip": true, "screen": "vip",
// or its label contains "VIP". Set "vip": false to force an endpoint public.
function isVip(ep) {
  if (ep.vip === true) return true;
  if (ep.vip === false) return false;
  return ep.screen === 'vip' || /vip/i.test(ep.label || '') || /vip/i.test(ep.path || '');
}

function describe(t) {
  const teams = [t.team_one, t.team_two].map((v) => String(v ?? '').trim()).filter(Boolean).join(' vs ');
  return [teams, t.tips_name && `· ${t.tips_name}`, t.odds_value && `@ ${t.odds_value}`].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- FCM HTTP v1
function loadAccounts() {
  if (DRY_RUN) return {};
  const raw = process.env.FCM_SERVICE_ACCOUNTS;
  if (!raw) throw new Error('FCM_SERVICE_ACCOUNTS secret is missing');
  return JSON.parse(raw);
}

async function push(app, title, body, data = {}, image) {
  const android = app.android || {};
  // Full-color logo/banner shown in the notification (https URL). Endpoint image wins.
  image = image || app.image || defaults.image;
  const strData = Object.fromEntries(
    Object.entries({ ...data, title, body, click_action: 'FLUTTER_NOTIFICATION_CLICK' })
      .filter(([, v]) => v != null)
      .map(([k, v]) => [k, String(v)]),
  );

  const message = {
    topic: app.topic || defaults.topic || 'all',
    notification: { title, body, ...(image ? { image } : {}) },
    data: strData,
    android: {
      priority: 'high',
      notification: clean({
        channel_id: android.channelId,
        icon: android.icon,
        color: android.color,
        sound: 'default',
        tag: strData.tag,
        notification_priority: 'PRIORITY_MAX',
        visibility: 'PUBLIC',
      }),
    },
    apns: { payload: { aps: { sound: 'default', 'mutable-content': 1 } } },
  };

  if (DRY_RUN) {
    console.log(`[DRY ${app.id}] ${title}\n            ${body}${image ? `\n            image: ${image}` : ''}\n            ${JSON.stringify(strData)}`);
    return;
  }

  const sa = accounts[app.id];
  if (!sa) {
    console.error(`[${app.id}] no service account in FCM_SERVICE_ACCOUNTS — skipped`);
    failures++;
    return;
  }

  try {
    const token = await accessToken(sa);
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`FCM ${res.status}: ${await res.text()}`);
    console.log(`[${app.id}] sent: ${title}`);
  } catch (e) {
    console.error(`[${app.id}] push failed: ${e.message}`);
    failures++;
  }
}

async function accessToken(sa) {
  if (tokenCache.has(sa.client_email)) return tokenCache.get(sa.client_email);
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud, iat: now, exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');

  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`token error: ${JSON.stringify(json)}`);
  tokenCache.set(sa.client_email, json.access_token);
  return json.access_token;
}

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''));
}
