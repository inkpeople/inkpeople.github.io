# Tattoo Manager — recovery snapshot (2026-11-16)

This branch is a code recovery snapshot. It does not replace production.

## Frontend
The currently published frontend files are already in the repository:
- `tattoo-manager-v2/index.html`
- `tattoo-manager-v2/client.html`
- `tattoo-manager-v2/sw.js`
- `tattoo-manager-v2/manifest.webmanifest`

## Supabase Edge Functions snapshot
Source copied from project `jgzzdsittnzomedvsspj`:
- `supabase/functions/tattoo-manager-api/index.ts` — source version 98
- `supabase/functions/tattoo-manager-bot/index.ts` — source version 70
- `supabase/functions/tattoo-manager-ai/index.ts` — source version 23
- `supabase/functions/tattoo-task-reminders/index.ts` — source version 23
- `supabase/functions/tattoo-calendar-yandex/index.ts` — source version 8
- `supabase/functions/tattoo-calendar-yandex-callback/index.ts` — source version 8
- `supabase/functions/tattoo-calendar-apple/index.ts` — source version 8

## Important recovery notes
- No production settings, secrets, database rows, or customer files are included in this branch.
- Function source expects environment variables such as `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `TELEGRAM_BOT_TOKEN`. Recreate these securely in the target environment; never commit their values.
- This is a source-code backup only. It is not yet a working failover environment.
- The production Supabase database and Storage remain the source of truth. A separate database/storage backup and a tested restore procedure are still required.
- Do not point the live app or Telegram bot at a recovery deployment until a full test has passed.
