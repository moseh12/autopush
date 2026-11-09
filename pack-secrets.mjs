// Builds the FCM_SERVICE_ACCOUNTS secret from your downloaded Firebase keys.
//
//   node pack-secrets.mjs cashscoretips=keys/cashscoretips.json brilliantscores=keys/brilliant.json ...
//
// The left side must match the app "id" in apps.json. Paste the printed JSON
// into GitHub → repo → Settings → Secrets and variables → Actions →
// New repository secret, named FCM_SERVICE_ACCOUNTS.

import { readFileSync } from 'node:fs';

const out = {};
for (const arg of process.argv.slice(2)) {
  const [id, file] = arg.split('=');
  if (!id || !file) {
    console.error(`Bad argument "${arg}" — use appId=path/to/key.json`);
    process.exit(1);
  }
  const sa = JSON.parse(readFileSync(file, 'utf8'));
  if (!sa.private_key || !sa.client_email || !sa.project_id) {
    console.error(`${file} is not a Firebase service-account key`);
    process.exit(1);
  }
  out[id] = { project_id: sa.project_id, client_email: sa.client_email, private_key: sa.private_key, token_uri: sa.token_uri };
}

if (!Object.keys(out).length) {
  console.error('Usage: node pack-secrets.mjs appId=key.json [appId=key.json ...]');
  process.exit(1);
}
console.log(JSON.stringify(out));
