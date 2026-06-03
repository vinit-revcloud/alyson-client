# Time Doctor access token auto-refresh

The app refreshes the Time Doctor **access token** automatically when these env vars are set (local `.env` and Vercel Production):

| Variable | Purpose |
|----------|---------|
| `API_BASE_URL` | e.g. `https://webapi.timedoctor.com/v1.1` |
| `API_REFRESH_TOKEN` | Long-lived refresh token from Time Doctor OAuth |
| `OAUTH_CLIENT_ID` | OAuth app client id |
| `OAUTH_CLIENT_SECRET` | OAuth app client secret |
| `API_ACCESS_TOKEN` | Optional seed; refreshed on each cold start / before expiry |
| `TIME_DOCTOR_TIMEZONE` | Optional IANA override (e.g. `America/Chicago`). Default: auto from TD `company_time_zone` |

## Behavior

- On each API call, if refresh credentials exist, the server exchanges the refresh token for a new access token (proactively, not only after 401).
- Within one warm serverless invocation, the refreshed token is reused for ~45 minutes.
- On **401/403**, it retries once after refresh.

You no longer need to paste a new access token into `.env` on every expiry **as long as** `API_REFRESH_TOKEN` stays valid.

## If refresh stops working

1. Regenerate tokens in the Time Doctor developer / OAuth flow.
2. Update **both** `API_ACCESS_TOKEN` and `API_REFRESH_TOKEN` in Vercel (and local `.env`) if Time Doctor rotates the refresh token.
3. Confirm `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, and `API_BASE_URL` match the app that issued the refresh token.

## Note on serverless

Refreshed tokens live in **memory** for that request/instance only. Vercel env `API_ACCESS_TOKEN` is not updated automatically; the in-memory token is what matters at runtime after the first refresh in that process.
