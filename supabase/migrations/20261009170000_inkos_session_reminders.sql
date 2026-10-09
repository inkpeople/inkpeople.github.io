-- INK.OS automated session reminders log table
create table if not exists public.inkos_reminder_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id text not null,
  client_id text not null,
  reminder_type text not null check (reminder_type in ('24h','2h')),
  channel text not null check (channel in ('telegram','vk')),
  status text not null default 'pending' check (status in ('pending','sending','sent','failed')),
  attempts integer not null default 0 check (attempts >= 0),
  scheduled_for timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  owner_push_sent boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inkos_reminder_log_unique unique (user_id,event_id,reminder_type)
);
alter table public.inkos_reminder_log enable row level security;
revoke all on public.inkos_reminder_log from anon, authenticated;
grant select on public.inkos_reminder_log to authenticated;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'inkos_reminder_log'
      and policyname = 'Users can read own INK.OS reminder logs'
  ) then
    create policy "Users can read own INK.OS reminder logs"
      on public.inkos_reminder_log for select to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;
create index if not exists inkos_reminder_log_user_sent_idx
  on public.inkos_reminder_log (user_id, status, scheduled_for);
