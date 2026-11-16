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

The frontend snapshot still contains hard-coded primary Supabase function URLs. It is not yet configured for automatic failover.

## Supabase Edge Functions snapshot
Source copied from primary:
- `supabase/functions/tattoo-manager-api/index.ts` — source version 98
- `supabase/functions/tattoo-manager-bot/index.ts` — source version 70
- `supabase/functions/tattoo-manager-ai/index.ts` — source version 23
- `supabase/functions/tattoo-task-reminders/index.ts` — source version 23
- `supabase/functions/tattoo-calendar-yandex/index.ts` — source version 8
- `supabase/functions/tattoo-calendar-yandex-callback/index.ts` — source version 8
- `supabase/functions/tattoo-calendar-apple/index.ts` — source version 8

On the backup project, `tattoo-manager-api` is currently ACTIVE (version 1). The other six functions are not yet deployed.

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

Required names found in the function sources:
- Common: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`
- AI: `GROQ_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- Yandex: `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`

Set `SUPABASE_URL` to the backup project URL on backup functions. Use the backup project's own service-role key, not the primary project's key. Preserve the same Telegram, AI-provider and Yandex credentials where the service is intended to continue using the same integrations. Do not copy secret values into this repository.

## Not yet complete — do not activate failover
- Deploy and configure the six remaining Edge Functions.
- Verify the deployed `tattoo-manager-api` has all required secrets and can authenticate Telegram init data.
- Inspect and preserve any encryption key/configuration used for stored calendar OAuth tokens; a copied encrypted token may not be decryptable if the encryption key differs.
- Configure and test Storage access and object signing.
- Build continuous replication / safe dual-write with idempotency and reverse reconciliation. The initial data copy is only a point-in-time snapshot; new writes are not yet replicated.
- Add frontend endpoint selection and safe retry logic for primary quota exhaustion or outage.
- Implement a trustworthy Egress threshold monitor. Supabase's documented usage reporting does not currently provide a confirmed real-time public meter/webhook suitable for an exact automatic 80% trigger. Do not claim proactive threshold switching is active.
- Test master and client login, registration, booking, calendar, finance, tasks, photos, AI, Telegram notifications and recovery synchronization before switching production.

## Safety
- Production project was not modified.
- Do not switch the live app or Telegram bot to backup until all tests pass.
- Do not assume a static frontend backup is a complete server failover.
- Never store production customer data, credentials or tokens in this Git repository.
