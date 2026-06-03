# Production — alyson-client.vercel.app

Deploy branch: **main** → [https://alyson-client.vercel.app](https://alyson-client.vercel.app)

## 1. Push code

```bash
git add -A
git commit -m "Daily stakeholder ZIP reports and production cron."
git push origin main
```

Vercel redeploys automatically when `main` updates.

## 2. Vercel environment variables

In [Vercel Dashboard](https://vercel.com) → **alyson-client** → **Settings** → **Environment Variables** → **Production**:

Copy everything your app needs from local `.env` (Google DWD JSON, Time Doctor, Supabase, Clerk, etc.), plus:

| Variable | Value |
|----------|--------|
| `RESEND_API_KEY` | From [resend.com](https://resend.com) |
| `RESEND_FROM_EMAIL` | Verified sender, e.g. `Alyson HR <reports@cintara.ai>` |
| `DAILY_REPORT_ENABLED` | `true` |
| `DAILY_REPORT_RECIPIENTS` | `alysonclient@cintara.ai,thirumalai@cintara.ai` |
| `DAILY_REPORT_CRON_SECRET` | Long random string (same as local) |
| `CRON_SECRET` | **Same value** as `DAILY_REPORT_CRON_SECRET` (Vercel cron auth) |
| `DAILY_REPORT_INCLUDE_HOURLY` | `false` |
| `DAILY_REPORT_INCLUDE_SCORING` | `true` |
| `DAILY_REPORT_INCLUDE_WORKSPACE` | `true` |
| `DAILY_REPORT_INCLUDE_TIME_DOCTOR` | `true` |
| `DAILY_REPORT_HOURS_BACK` | `24` |

Template without secrets: [env.production.example](../env.production.example)

**Important:** Never prefix server secrets with `VITE_` (they would leak to the browser).

## 3. Cron job (daily 6:00 AM IST)

`vercel.json` already defines:

- Path: `/api/cron/daily-reports`
- Schedule: `30 0 * * *` (UTC) = 06:00 IST
- `maxDuration`: 300 seconds (**Vercel Pro** recommended)

After deploy, open **Vercel → Project → Cron Jobs** and confirm the job is listed.

Vercel sends `Authorization: Bearer <CRON_SECRET>` on cron invocations when `CRON_SECRET` is set.

## 4. Test from the app (easiest)

1. Deploy with env vars set.
2. Open [https://alyson-client.vercel.app/reports](https://alyson-client.vercel.app/reports)
3. Tab **Daily email** → enter send code (same as `CRON_SECRET`) → **Send daily reports now**
4. Check `alysonclient@cintara.ai` and `thirumalai@cintara.ai` for the ZIP.

## 5. Test production (curl)

Replace `YOUR_CRON_SECRET` with the value from Vercel:

```bash
curl -X POST "https://alyson-client.vercel.app/api/cron/daily-reports" \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

Success example:

```json
{
  "ok": true,
  "sent": true,
  "recipients": ["alysonclient@cintara.ai", "thirumalai@cintara.ai"],
  "zipFilename": "alyson-daily-reports-2026-06-03.zip",
  "zipSizeMb": 0.8
}
```

Check both inboxes for the ZIP (`company/` folder with scoring, workspace, time-dashboard CSV + Excel).

## 5. Resend on production

- Sandbox `onboarding@resend.dev` only delivers to your Resend account email.
- For **alysonclient@** and **thirumalai@**, verify **cintara.ai** in Resend and set `RESEND_FROM_EMAIL` to that domain.

## 6. Troubleshooting

| Issue | Fix |
|--------|-----|
| `401 Unauthorized` | `CRON_SECRET` / `DAILY_REPORT_CRON_SECRET` mismatch |
| `503` cron secret missing | Add both secrets on Vercel Production |
| Cron times out (10s) | Upgrade to **Vercel Pro** or reduce report scope |
| Email not received | Resend domain verification; check Resend logs |
| Empty ZIP / errors in JSON | Google DWD + Time Doctor env vars missing on Vercel |

More detail: [DAILY_STAKEHOLDER_REPORTS.md](./DAILY_STAKEHOLDER_REPORTS.md)
