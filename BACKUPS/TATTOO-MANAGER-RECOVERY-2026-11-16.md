# Tattoo Manager — recovery snapshot (2026-11-16)

This branch is a code and database recovery snapshot. It does not replace production and must not be treated as active failover until all checks below are complete.

## Projects
- Primary Supabase project: `jgzzdsittnzomedvsspj` (production; unchanged).
- Backup Supabase project: `ndetzxmpkfqcbzftaxtv` (separate organization, Free plan, Frankfurt).
- Recovery frontend: https://tattoo-manager-recovery.onrender.com
- Git branch: `backup/tattoo-manager-2026-11-16`

## Frontend
- `tattoo-manager-v2/index.html`
- `tattoo-manager-v2/client.html`
- `tattoo-manager-v2/sw.js`
- `tattoo-manager-v2/manifest.webmanifest`

The recovery branch frontend files now point to backup Supabase project `ndetzxmpkfqcbzftaxtv`. Render static-site deployment after these commits is still pending verification. This is a manual recovery endpoint, not automatic failover.

## Supabase Edge Functions snapshot
Source copied from primary:
- `supabase/functions/tattoo-manager-api/index.ts` — source version 98
- `supabase/functions/tattoo-manager-bot/index.ts` — source version 70
- `supabase/functions/tattoo-manager-ai/index.ts` — source version 23
- `supabase/functions/tattoo-task-reminders/index.ts` — source version 23
- `supabase/functions/tattoo-calendar-yandex/index.ts` — source version 8
- `supabase/functions/tattoo-calendar-yandex-callback/index.ts` — source version 8
- `supabase/functions/tattoo-calendar-apple/index.ts` — source version 8

All seven application Edge Functions are ACTIVE on backup. Their source code matches the primary snapshot; backup-specific endpoint changes point Telegram app links to `https://tattoo-manager-recovery.onrender.com` and Yandex OAuth callback to the backup Supabase project. Current backup versions: API v12, bot v6, AI v6, task reminders v6, Yandex v6, Yandex callback v6, Apple calendar v6. Separate `tattoo-manager-sync` is ACTIVE v5.

## Database restoration completed
- 28 `public.tm_*` tables restored with matching column structure.
- 51 foreign-key constraints and 52 additional indexes restored.
- Row-level security enabled on all 28 tables.
- Three existing production policies copied and verified.
- Initial application data copied from primary to backup and verified by exact row counts:
  - `tm_studios`: 4
  - `tm_user_profiles`: 10
  - `tm_user_roles`: 8
  - `tm_bot_registration`: 2
  - `tm_bot_settings`: 1
  - `tm_clients`: 3
  - `tm_appointments`: 3
  - `tm_calendar_events`: 1
  - `tm_calendar_connections`: 1
  - `tm_client_link_tokens`: 1
  - `tm_master_friendships`: 1
  - `tm_master_messages`: 6
  - `tm_task_reminder_guard`: 1
  - `tm_visit_reminder_log`: 3
- The remaining 14 application tables were empty at the time of this snapshot.
- Three private Storage buckets created on backup: `tm-client-gallery`, `tm-client-references`, `tm-master-portfolio`.
- No objects existed in these three production buckets at the time of the initial check.

## Required Edge Function secrets
Configure secrets directly in the backup project's Supabase dashboard. Copy values securely from the primary project's secret store; never paste them into chat or commit them to Git.

Custom secret names found in the function sources:
- Common: `TELEGRAM_BOT_TOKEN`
- AI: `GROQ_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- Yandex: `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`

Supabase injects `SUPABASE_URL` and the legacy `SUPABASE_SERVICE_ROLE_KEY` into hosted Edge Functions by default. Verify that the latter is available in the backup runtime; never expose it to the browser. If the project uses the newer key model, the function code will need to be updated to read `SUPABASE_SECRET_KEYS` instead.

Set the custom secret values directly in the backup project's Edge Function Secrets dashboard. Use the credentials belonging to the same Telegram bot, AI provider accounts and Yandex OAuth application that the app already uses. Never paste values into chat or commit them to this repository.

## Not yet complete — do not activate failover
- Configure required custom Edge Function secrets on backup: `TELEGRAM_BOT_TOKEN`, `GROQ_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`. Do not paste secrets into Git or chat.
- Verify the deployed `tattoo-manager-api` has all required secrets and can authenticate Telegram init data.
- Inspect and preserve any encryption key/configuration used for stored calendar OAuth tokens; a copied encrypted token may not be decryptable if the encryption key differs.
- Storage buckets exist and are private, but `storage.objects` currently has 0 objects. Configure and test Storage access and object signing; migrate objects if production begins storing them.
- Complete and test continuous replication / safe dual-write with idempotency and reverse reconciliation. The primary is restricted by Egress quota (6.033 GB / 5 GB), so current sync worker calls return HTTP 402. Backup outbox currently contains 2 pending test events; 0 delivered.
- Add frontend endpoint selection and safe retry logic for primary quota exhaustion or outage.
- Implement a trustworthy Egress threshold monitor. Supabase's documented usage reporting does not currently provide a confirmed real-time public meter/webhook suitable for an exact automatic 80% trigger. Do not claim proactive threshold switching is active.
- Backup database currently has 0 `auth.users`, 0 `auth.identities`, 0 Storage objects, 2 pending sync events and 0 delivered events. Verify whether production relies on Supabase Auth in addition to Telegram WebApp authentication. Test master and client login, registration, booking, calendar, finance, tasks, photos, AI, Telegram notifications and recovery synchronization before switching production.

## Safety
- Production project was not modified.
- Do not switch the live app or Telegram bot to backup until all tests pass.
- Do not assume a static frontend backup is a complete server failover.
- Never store production customer data, credentials or tokens in this Git repository.


## Current transfer checkpoint (2026-11-16)
- Recovery frontend `index.html` and `client.html` updated on this branch to use backup Supabase URL.
- Seven app Edge Functions redeployed from primary source with backup-specific links; all ACTIVE. Sync function remains ACTIVE.
- Telegram inline app URLs in API, bot and reminder functions now point to Render recovery frontend.
- Yandex OAuth callback references updated to backup function endpoint. Yandex developer-console redirect URI still needs confirmation/update.
- Render service has auto-deploy enabled, but the new GitHub commits have not yet appeared in its deploy history; verify deployment before using the URL.
- Production project remains unchanged; no live traffic has been switched.
