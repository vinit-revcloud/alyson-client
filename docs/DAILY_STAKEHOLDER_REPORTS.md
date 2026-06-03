# Daily stakeholder reports (Resend + cron + ZIP)

Once per day, stakeholders receive **one email** with a **ZIP** of company-wide reports.

**Current default (Cintara):** Time Dashboard, Employee Scoring, and Workspace Activity only — **no hourly** per-employee exports (too heavy). Enable hourly later with `DAILY_REPORT_INCLUDE_HOURLY=true`.

## ZIP contents (default)

```
alyson-daily-reports-2026-06-03.zip
├── README.txt
└── company/
    ├── employee-scoring.csv
    ├── employee-scoring.xlsx
    ├── workspace-activity.csv
    ├── workspace-activity.xlsx
    ├── time-dashboard.csv
    └── time-dashboard.xlsx
```

With `DAILY_REPORT_INCLUDE_HOURLY=true`, an `employees/{name}/` folder is added (PDF + CSV + Excel per person).

## Recipients (configured)

```env
DAILY_REPORT_RECIPIENTS=alysonclient@cintara.ai,thirumalai@cintara.ai
```

## Environment variables

```env
# Required
RESEND_API_KEY=re_xxxxxxxx
DAILY_REPORT_RECIPIENTS=alysonclient@cintara.ai,thirumalai@cintara.ai
DAILY_REPORT_CRON_SECRET=your-long-random-secret

# Recommended
RESEND_FROM_EMAIL=Alyson HR <reports@cintara.ai>
DAILY_REPORT_ENABLED=true

# Reports in ZIP (all true by default)
DAILY_REPORT_INCLUDE_SCORING=true
DAILY_REPORT_INCLUDE_WORKSPACE=true
DAILY_REPORT_INCLUDE_TIME_DOCTOR=true
DAILY_REPORT_INCLUDE_HOURLY=false

# Window
DAILY_REPORT_HOURS_BACK=24

# Vercel cron (same value as DAILY_REPORT_CRON_SECRET)
CRON_SECRET=your-long-random-secret
```

## When emails arrive

| Trigger | When |
|---------|------|
| **Automatic** | Every day **6:00 AM IST** (Vercel cron on production) |
| **Manual test** | **Reports → Daily email → Send daily reports now** (HR / CEO / Super Admin) |

The UI button uses the same ZIP as cron. Enter your server **send code** (`DAILY_REPORT_CRON_SECRET` or `DAILY_REPORT_UI_SEND_CODE`).

## Cron

`vercel.json` — daily **06:00 IST**. Set `DAILY_REPORT_CRON_SECRET` and `CRON_SECRET` on Vercel to the same value.

## Manual test

**Local:**

```bash
curl -X POST "http://localhost:3001/api/cron/daily-reports" \
  -H "Authorization: Bearer YOUR_DAILY_REPORT_CRON_SECRET"
```

**Production** ([alyson-client.vercel.app](https://alyson-client.vercel.app)):

```bash
curl -X POST "https://alyson-client.vercel.app/api/cron/daily-reports" \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

Set `CRON_SECRET` and `DAILY_REPORT_CRON_SECRET` to the **same** value in Vercel Production env. See [VERCEL_PRODUCTION.md](./VERCEL_PRODUCTION.md).

## Enable hourly later

```env
DAILY_REPORT_INCLUDE_HOURLY=true
DAILY_REPORT_MAX_EMPLOYEES=120
DAILY_REPORT_CONCURRENCY=3
```

Expect longer runs and larger ZIP files.
