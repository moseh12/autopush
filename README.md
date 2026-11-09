# Autopush: automatic push notifications for all your tips apps

You don't host anything and the shared API doesn't change. A free GitHub Actions job checks your
existing API (`https://mchumwasure.top/api/...`) every 10 minutes and pushes to each app's
Firebase project on its own:

| Event | Push |
|---|---|
| New tips appear on an endpoint | ⚽ 2 new tips in Free Sure Tips: *Man City vs Leeds · Home Win @ 1.40 + 1 more · Free* |
| A tip's status changes to `won` | ✅ 2 tips WON! *Arsenal vs Chelsea · Over 2.5 @ 1.85 and 1 more · total odds 3.15 💰* |
| 09:00 Nairobi every day | 🔥 Today's tips are ready |

Tips found in the same check are grouped into one push per category, so posting 10 tips sends one notification.
The first time an endpoint is seen, the tips already on it are only recorded, so nobody gets spammed with old tips.

## Setup (about 15 minutes, done once for all apps)

### 1. Create the repo
GitHub → **New repository**, for example `tips-autopush`. Upload everything in this folder, including `.github/workflows/autopush.yml`.

- **Public repo:** unlimited free minutes, so the 10-minute check is fine. Your keys stay safe because they live in Secrets, not in the files.
- **Private repo:** about 2,000 free minutes a month. Change the cron in the workflow to `*/30 * * * *` (every 30 minutes) to stay inside that.

### 2. Get a Firebase key for each app
For each app: Firebase console → project → ⚙ **Project settings** → **Service accounts** →
**Generate new private key**. Put the files in a `keys/` folder on your PC. Never upload this folder; `.gitignore` already excludes it.

### 3. Pack the keys into one secret
```
node pack-secrets.mjs cashscoretips=keys/cashscoretips.json brilliantscores=keys/brilliantscores.json winjack=keys/winjack.json
```
Copy the printed line. Then go to the repo → **Settings → Secrets and variables → Actions → New repository secret**.
Name it `FCM_SERVICE_ACCOUNTS` and paste the line as the value.

### 4. List your apps in `apps.json`
Copy the `example-second-app` block once per app and set:
- `id`: the same name you used in step 3
- `name`: shown in test pushes
- `enabled`: `true`
- `baseUrl` (optional): only if that app uses a different API address
- `endpoints`: the paths that app reads, each with a `label` and the `screen` to open (`free`, `vip`, `proof` or `history`)

Optional per endpoint: `"notify": ["new"]` sends only new-tip pushes, and `"notify": ["won"]` sends only results (good for history endpoints).

### 5. Test
Repo → **Actions → Auto push notifications → Run workflow**, mode `test`. Every enabled app should get
"✅ notifications work". Then run it once with mode `poll` to save the baseline. After that it runs on its own.

## Each app must subscribe to the topic
Pushes go to the topic **`all`** in each Firebase project. CashScore Tips already does this (`lib/notifications/notification_service.dart`).
For each of your other apps, copy:
- `lib/notifications/notification_service.dart`. Change the import `package:cashscoretips/...` to that app's package name.
- the `main.dart` setup lines: `onBackgroundMessage` and `NotificationService.instance.init()`
- the `AndroidManifest.xml` permission and meta-data, `res/drawable/ic_stat_notification.xml`, `res/values/colors.xml` and `res/raw/keep.xml`

Then release an update. A phone only gets pushes after it opens the updated app once.

## Notes
- GitHub's timer can run 5–15 minutes late when GitHub is busy, so a push may arrive a little after you post.
- `state.json` is the bot's memory of the tips it has already seen. The workflow saves it after each run; don't edit it.
- Send a one-off push to one app: Run workflow with mode `test` and `only_app` set to that app's id.
- Logs: Actions tab → open a run → "Send notifications".
