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
//   MODE                  "poll" (default) | "daily" | "test" | "promo" (hourly Join-VIP push) | "discount" (4 PM) | "cashback" (midnight)
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
const tokenCache = new Map(); // must be declared before main runs (top-level await)

// ---------------------------------------------------------------- main
if (MODE === 'daily') {
  for (const app of apps) {
    const d = { ...defaults.daily, ...app.daily };
    await push(app, d.title, d.body, { type: 'daily', screen: d.screen, tag: 'daily_reminder' });
  }
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
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1) + '\n');
}

if (failures) {
  console.error(`${failures} push(es) failed`);
  process.exitCode = 1;
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
          let title, body;
          if (vip) {
            // VIP: never reveal teams, prediction or odds — only that tips exist.
            title = fresh.length === 1
              ? `👑 New VIP tip in ${ep.label}`
              : `👑 ${fresh.length} new VIP tips in ${ep.label}`;
            body = app.vipNewBody ?? defaults.vipNewBody ?? 'Unlock VIP in the app to view today\'s predictions 🔒';
          } else {
            title = fresh.length === 1
              ? `⚽ New tip in ${ep.label}`
              : `⚽ ${fresh.length} new tips in ${ep.label}`;
            body = describe(fresh[0]) + (fresh.length > 1 ? ` + ${fresh.length - 1} more` : '') + ' · Free';
          }
          await push(app, title, body, {
            type: vip ? 'vip_tips' : 'new_tips', vip: vip ? 'true' : 'false',
            screen: ep.screen || 'free', category: ep.label,
            count: fresh.length, tag: `new_${ep.path}`,
          }, ep.image);
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

  let title, body;
  if (wins.length === 1) {
    title = `🎉 Congratulations! ${ep.label} WON ✅`;
    body = hide
      ? (app.vipWonBody ?? defaults.vipWonBody ?? 'Our VIP tip just WON 💰 Join VIP for the next one 👑')
      : `${describe(wins[0])} 💰 Cash out and enjoy!`;
  } else {
    title = `🎉 Congratulations! ${ep.label} — ${wins.length} tips WON ✅`;
    const odd = total ? ` · total odds ${total}` : '';
    body = hide
      ? `${wins.length} VIP tips WON${odd} 💰 Join VIP 👑`
      : `${describe(wins[0])} and ${wins.length - 1} more${odd} 💰`;
  }

  await push(app, title, body, {
    type: 'result', vip: vip ? 'true' : 'false', screen: 'proof',
    category: ep.label, count: wins.length, total_odds: total ?? undefined,
    tag: `won_${ep.path}`, // per section, so one section's push doesn't replace another's
  });
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
  const day = Math.floor(Date.now() / 86400000); // changes every day
  for (const [i, app] of apps.entries()) {
    const c = { ...cfg, ...(app[kind] || {}) };
    if (c.enabled === false) continue;
    const list = c.messages || base.messages;
    const msg = list[(day + i) % list.length];
    const vars = { app: app.name, percent: c.percent ?? base.percent };
    const fill = (t) => t.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
    await push(app, fill(msg.title), fill(msg.body), {
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

  const slot = Math.floor(Date.now() / 3600000); // changes every hour
  for (const [i, app] of apps.entries()) {
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

    const vars = { app: app.name, vipCount, vipWon };
    const list = (appCfg.messages || defaultPromo()).filter((m) =>
      !(/\{vipCount\}/.test(m.title + m.body) && !vipCount) &&
      !(/\{vipWon\}/.test(m.title + m.body) && !vipWon));
    if (!list.length) continue;

    const msg = list[(slot + i) % list.length];
    const fill = (t) => t.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
    await push(app, fill(msg.title), fill(msg.body), {
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
