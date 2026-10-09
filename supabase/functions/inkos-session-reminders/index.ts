import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const env = (name: string) => (Deno.env.get(name) || '').trim();

function isSchedulerRequest(req: Request): boolean {
  const apiKey = (req.headers.get('apikey') || '').trim();
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!apiKey || apiKey !== bearer) return false;
  const trustedKeys = [env('SUPABASE_SERVICE_ROLE_KEY'), env('SUPABASE_SECRET_KEY')].filter(Boolean);
  return trustedKeys.includes(apiKey);
}

const SUPABASE_URL = env('SUPABASE_URL').replace(/\/+$/, '');
const DB_KEY = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SECRET_KEY');

async function dbRequest(path: string, init: RequestInit = {}): Promise<any> {
  if (!SUPABASE_URL || !DB_KEY) throw new Error('SUPABASE_ADMIN_CONFIG_MISSING');
  const headers = new Headers(init.headers || {});
  headers.set('apikey', DB_KEY);
  headers.set('Authorization', 'Bearer ' + DB_KEY);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(SUPABASE_URL + '/rest/v1/' + path, { ...init, headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error('DB_HTTP_' + response.status);
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function resolveTimeZone(raw: unknown): string {
  const zone = String(raw || 'Asia/Novosibirsk');
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date()); return zone; }
  catch { return 'Asia/Novosibirsk'; }
}

function wallClockToUtc(dateValue: unknown, timeValue: unknown, zone: string): number | null {
  const dateMatch = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(timeValue || '').match(/^(\d{1,2}):(\d{2})/);
  if (!dateMatch || !timeMatch) return null;
  const parts = dateMatch.slice(1).map(Number);
  const h = Number(timeMatch[1]);
  const m = Number(timeMatch[2]);
  if (parts[1] < 1 || parts[1] > 12 || parts[2] < 1 || parts[2] > 31 || h > 23 || m > 59) return null;
  const target = Date.UTC(parts[0], parts[1] - 1, parts[2], h, m, 0, 0);
  let guess = target;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  for (let i = 0; i < 4; i++) {
    const p: Record<string, string> = {};
    for (const item of fmt.formatToParts(new Date(guess))) if (item.type !== 'literal') p[item.type] = item.value;
    const localAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), 0, 0);
    const diff = target - localAsUtc;
    guess += diff;
    if (diff === 0) break;
  }
  const verify: Record<string, string> = {};
  for (const item of fmt.formatToParts(new Date(guess))) if (item.type !== 'literal') verify[item.type] = item.value;
  if (Number(verify.year) !== parts[0] || Number(verify.month) !== parts[1] ||
      Number(verify.day) !== parts[2] || Number(verify.hour) !== h || Number(verify.minute) !== m) return null;
  return guess;
}

function isCancelled(event: any): boolean {
  const status = String(event?.status || '').toLowerCase();
  return ['cancelled', 'canceled', 'cancel', 'отмен', 'no-show', 'noshow', 'no_show', 'completed', 'finished', 'заверш', 'done'].some(x => status.includes(x));
}
function consentGiven(client: any): boolean {
  return client?.reminderConsent === true || String(client?.reminderConsent || '').toLowerCase() === 'true';
}
function firstName(value: unknown): string {
  const name = String(value || '').trim().split(/\s+/)[0];
  return name || 'друг';
}

function messageFor(kind: '24h' | '2h', client: any, event: any, eventAt: number, zone: string): string {
  const name = firstName(client?.name);
  const time = String(event.start || event.startTime || event.time || '—').slice(0, 5);
  const date = new Intl.DateTimeFormat('ru-RU', { timeZone: zone, day: 'numeric', month: 'long' }).format(new Date(eventAt));
  if (kind === '24h') {
    return 'Здравствуйте, ' + name + '! Напоминаю: ваш сеанс в тату-студии запланирован на завтра, ' +
      date + ' в ' + time + '. Если планы изменились, пожалуйста, напишите мне. До встречи!';
  }
  return 'Здравствуйте, ' + name + '! Напоминаю: сегодня у вас сеанс в ' + time +
    ', примерно через 2 часа. Если планы изменились или нужно уточнить детали, напишите мне. До встречи!';
}

async function notifyOwner(settings: any, stage: '24h' | '2h', result: 'sent' | 'failed', client: any): Promise<boolean> {
  try {
    const push = settings?.push;
    if (push?.enabled !== true || !String(push?.topic || '').trim()) return false;
    const server = new URL(String(push?.server || 'https://ntfy.sh'));
    // Keep the privileged scheduler from posting arbitrary user-supplied URLs.
    if (server.protocol !== 'https:' || server.hostname.toLowerCase() !== 'ntfy.sh' ||
        server.username || server.password || server.port) return false;
    const when = stage === '24h' ? 'за 24 часа' : 'за 2 часа';
    const withName = push?.names === true;
    const who = withName && client?.name ? ' (' + String(client.name).slice(0, 70) + ')' : '';
    const title = result === 'sent' ? 'INK.OS · Напоминание отправлено' : 'INK.OS · Ошибка отправки';
    const message = result === 'sent'
      ? 'Клиенту' + who + ' отправлено напоминание ' + when + '.'
      : 'Не удалось отправить клиенту' + who + ' напоминание ' + when + '. Проверьте журнал отправки в INK.OS.';
    const response = await fetch(server.origin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: String(push.topic).trim(), title, message, priority: result === 'sent' ? 3 : 4 }),
      signal: AbortSignal.timeout(8000),
    });
    return response.ok;
  } catch (error) {
    console.warn('INK.OS owner notification failed:', String((error as Error)?.message || error).slice(0, 100));
    return false;
  }
}

async function sendTelegram(chatIdValue: unknown, message: string): Promise<string> {
  const token = env('TELEGRAM_BOT_TOKEN');
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED');
  const chatId = String(chatIdValue || '').trim();
  if (!/^-?\d+$/.test(chatId)) throw new Error('TELEGRAM_CHAT_ID_MISSING_OR_INVALID');
  const response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: Number(chatId), text: message, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(12000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok !== true) {
    const description = String(data?.description || '');
    if (/initiate conversation|start conversation|blocked by the user/i.test(description)) {
      throw new Error('TELEGRAM_CLIENT_MUST_START_BOT');
    }
    throw new Error('TELEGRAM_SEND_FAILED_HTTP_' + response.status);
  }
  return String(data?.result?.message_id || '');
}

async function sendVk(peerIdValue: unknown, message: string): Promise<string> {
  const token = env('VK_ACCESS_TOKEN');
  if (!token) throw new Error('VK_ACCESS_TOKEN_NOT_CONFIGURED');
  const peerId = String(peerIdValue || '').trim();
  if (!/^-?\d+$/.test(peerId)) throw new Error('VK_PEER_ID_MISSING_OR_INVALID');
  const form = new URLSearchParams();
  form.set('peer_id', peerId);
  form.set('random_id', String(Math.floor(Math.random() * 2147483000) + 1));
  form.set('message', message);
  form.set('access_token', token);
  form.set('v', env('VK_API_VERSION') || '5.199');
  const response = await fetch('https://api.vk.com/method/messages.send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(12000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error || data?.response == null) {
    const code = data?.error?.error_code;
    throw new Error(code ? 'VK_SEND_FAILED_CODE_' + code : 'VK_SEND_FAILED_HTTP_' + response.status);
  }
  return String(data.response);
}

function filters(userId: string, eventId: string, stage: string): string {
  return 'user_id=eq.' + encodeURIComponent(userId) +
    '&event_id=eq.' + encodeURIComponent(eventId) +
    '&reminder_type=eq.' + encodeURIComponent(stage);
}

async function sendDueReminder(userId: string, event: any, client: any, settings: any, stage: '24h' | '2h', targetAt: number, zone: string): Promise<'sent' | 'failed' | 'skipped'> {
  if (!event?.id || !client?.id || !consentGiven(client)) return 'skipped';
  const channel = String(client.reminderChannel || 'telegram').toLowerCase() === 'vk' ? 'vk' : 'telegram';
  const eventId = String(event.id);
  const clientId = String(client.id);
  const baseFilter = filters(userId, eventId, stage);
  let existing = (await dbRequest('inkos_reminder_log?select=id,status,attempts&' + baseFilter + '&limit=1'))?.[0];

  if (existing?.status === 'sent' || existing?.status === 'sending') return 'skipped';
  if (existing && Number(existing.attempts || 0) >= 5) return 'skipped';

  if (!existing) {
    await dbRequest('inkos_reminder_log?on_conflict=user_id,event_id,reminder_type', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({
        user_id: userId, event_id: eventId, client_id: clientId, reminder_type: stage,
        channel, status: 'pending', attempts: 0, scheduled_for: new Date(targetAt).toISOString(),
      }),
    });
    existing = (await dbRequest('inkos_reminder_log?select=id,status,attempts&' + baseFilter + '&limit=1'))?.[0];
  }
  if (!existing?.id || existing.status === 'sent' || existing.status === 'sending' || Number(existing.attempts || 0) >= 5) return 'skipped';

  const nextAttempt = Number(existing.attempts || 0) + 1;
  const claim = await dbRequest('inkos_reminder_log?select=id,status,attempts&' + baseFilter +
    '&status=in.(pending,failed)&attempts=lt.5', {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ status: 'sending', attempts: nextAttempt, channel, last_error: null, updated_at: new Date().toISOString() }),
    });
  const claimed = Array.isArray(claim) ? claim[0] : null;
  if (!claimed?.id) return 'skipped';

  try {
    const message = messageFor(stage, client, event, event.__eventAt, zone);
    const providerMessageId = channel === 'vk'
      ? await sendVk(client.vkPeerId, message)
      : await sendTelegram(client.telegramChatId, message);
    await dbRequest('inkos_reminder_log?id=eq.' + encodeURIComponent(claimed.id), {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        status: 'sent', sent_at: new Date().toISOString(), provider_message_id: providerMessageId,
        last_error: null, updated_at: new Date().toISOString(),
      }),
    });
    const ownerPushSent = await notifyOwner(settings, stage, 'sent', client);
    if (ownerPushSent) {
      await dbRequest('inkos_reminder_log?id=eq.' + encodeURIComponent(claimed.id), {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ owner_push_sent: true }),
      });
    }
    return 'sent';
  } catch (error) {
    const message = String((error as Error)?.message || error).slice(0, 120);
    await dbRequest('inkos_reminder_log?id=eq.' + encodeURIComponent(claimed.id), {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: 'failed', last_error: message, updated_at: new Date().toISOString() }),
    });
    const ownerPushSent = await notifyOwner(settings, stage, 'failed', client);
    if (ownerPushSent) {
      await dbRequest('inkos_reminder_log?id=eq.' + encodeURIComponent(claimed.id), {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ owner_push_sent: true }),
      });
    }
    return 'failed';
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (req.headers.get('origin')) return json({ error: 'Browser requests are not allowed for this scheduler.' }, 403);
  if (!isSchedulerRequest(req)) return json({ error: 'Scheduler authentication failed.' }, 401);
  if (!SUPABASE_URL || !DB_KEY) return json({ error: 'Supabase admin configuration is missing.' }, 500);

  try {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const accounts = await dbRequest('inkos_user_data?select=user_id,data');
    let sent = 0, failed = 0, skipped = 0, checked = 0;
    for (const account of (Array.isArray(accounts) ? accounts : [])) {
      const userId = String(account?.user_id || '');
      if (!userId) continue;
      const root = account?.data || {};
      const stores = root?.stores || root;
      const clients = Array.isArray(stores?.clients) ? stores.clients : [];
      const events = Array.isArray(stores?.events) ? stores.events : [];
      const settings = stores?.settings && typeof stores.settings === 'object' ? stores.settings : {};
      const zone = resolveTimeZone(settings.reminderTimezone || settings.timezone || settings.timeZone || 'Asia/Novosibirsk');
      const clientMap = new Map<string, any>(clients.filter((c: any) => c?.id).map((c: any) => [String(c.id), c]));

      for (const event of events) {
        if (!event?.id || !event?.clientId || event.remindersEnabled === false ||
            String(event.remindersEnabled || '').toLowerCase() === 'false' || isCancelled(event)) continue;
        const kind = String(event.type || '').toLowerCase();
        if (!['session', 'correction', 'model'].includes(kind)) continue;
        const client = clientMap.get(String(event.clientId));
        if (!client || !consentGiven(client)) continue;
        const eventAt = wallClockToUtc(event.date || event.eventDate, event.start || event.startTime || event.time, zone);
        if (eventAt === null || eventAt <= now) continue;
        event.__eventAt = eventAt;

        const targets: Array<{stage: '24h' | '2h'; at: number}> = [
          { stage: '24h', at: eventAt - 24 * 60 * 60 * 1000 },
          { stage: '2h', at: eventAt - 2 * 60 * 60 * 1000 },
        ];
        for (const target of targets) {
          if (target.at > now || now - target.at > windowMs) continue;
          checked++;
          const result = await sendDueReminder(userId, event, client, settings, target.stage, target.at, zone);
          if (result === 'sent') sent++;
          else if (result === 'failed') failed++;
          else skipped++;
        }
      }
    }
    return json({ ok: true, checked, sent, failed, skipped, timezoneDefault: 'Asia/Novosibirsk', at: new Date().toISOString() });
  } catch (error) {
    const code = String((error as Error)?.message || error).slice(0, 100);
    console.error('INK.OS reminder scheduler failed:', code);
    return json({ ok: false, error: code }, 500);
  }
});
