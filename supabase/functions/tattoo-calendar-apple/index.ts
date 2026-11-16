import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-telegram-init-data",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function out(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
const base = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const encoder = new TextEncoder();

async function telegramUser(initData: string): Promise<{ id: number }> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN_NOT_CONFIGURED");
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) throw new Error("INVALID_TELEGRAM_INIT_DATA");
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + "=" + v).join("\n");
  const webAppKey = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", webAppKey, encoder.encode(token));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(check)));
  const actual = [...digest].map(b => b.toString(16).padStart(2, "0")).join("");
  if (actual !== hash) throw new Error("INVALID_TELEGRAM_SIGNATURE");
  const authDate = Number(p.get("auth_date") || 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) throw new Error("TELEGRAM_INIT_DATA_EXPIRED");
  const raw = p.get("user");
  if (!raw) throw new Error("TELEGRAM_USER_MISSING");
  return JSON.parse(raw) as { id: number };
}
async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(base + "/rest/v1/" + path, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: "Bearer " + serviceKey,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {})
    }
  });
  const t = await r.text();
  if (!r.ok) throw new Error("DATABASE_ERROR_" + r.status + ": " + t);
  return t ? JSON.parse(t) : null;
}
async function encryptionKey() {
  if (!serviceKey) throw new Error("SERVICE_ROLE_KEY_MISSING");
  const raw = await crypto.subtle.digest("SHA-256", encoder.encode(serviceKey + "|tattoo-manager-apple-calendar-v1"));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function encryptCredentials(email: string, password: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey();
  const plain = encoder.encode(JSON.stringify({ email, password }));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const all = new Uint8Array(iv.length + encrypted.length);
  all.set(iv); all.set(encrypted, iv.length);
  let binary = "";
  for (const b of all) binary += String.fromCharCode(b);
  return btoa(binary);
}
async function decryptCredentials(value: string): Promise<{ email: string; password: string }> {
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const iv = bytes.slice(0, 12), ciphertext = bytes.slice(12);
  const key = await encryptionKey();
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plain));
}
function decodeXml(s: string) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function propHref(xml: string, prop: string): string {
  const re = new RegExp("<(?:[\\w.-]+:)?" + prop + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?" + prop + ">", "i");
  const m = xml.match(re);
  if (!m) throw new Error("APPLE_CALDAV_" + prop.toUpperCase() + "_NOT_FOUND");
  const h = m[1].match(/<(?:[\\w.-]+:)?href(?:\\s[^>]*)?>([\\s\\S]*?)<\/(?:[\\w.-]+:)?href>/i);
  if (!h) throw new Error("APPLE_CALDAV_HREF_NOT_FOUND");
  return decodeXml(h[1].trim());
}
function resolveHref(href: string, responseUrl: string) {
  return new URL(href, responseUrl).toString();
}
function basicAuth(email: string, password: string) {
  return "Basic " + btoa(email + ":" + password);
}
async function caldav(url: string, email: string, password: string, method: string, depth: string, body: string) {
  const response = await fetch(url, {
    method,
    redirect: "follow",
    headers: {
      Authorization: basicAuth(email, password),
      Depth: depth,
      "Content-Type": "application/xml; charset=utf-8",
      Accept: "application/xml, text/xml"
    },
    body
  });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) throw new Error("APPLE_AUTH_FAILED_CHECK_APP_PASSWORD");
  if (!(response.ok || response.status === 207)) throw new Error("APPLE_CALDAV_HTTP_" + response.status + ": " + text.slice(0, 300));
  return { text, url: response.url || url };
}
async function discover(email: string, password: string) {
  const firstBody = '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
  const first = await caldav("https://caldav.icloud.com/", email, password, "PROPFIND", "0", firstBody);
  const principalHref = propHref(first.text, "current-user-principal");
  const principalUrl = resolveHref(principalHref, first.url);
  const secondBody = '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>';
  const second = await caldav(principalUrl, email, password, "PROPFIND", "0", secondBody);
  const homeHref = propHref(second.text, "calendar-home-set");
  const calendarHomeUrl = resolveHref(homeHref, second.url);
  return { principalUrl, calendarHomeUrl };
}
function calendarDataBlocks(xml: string): string[] {
  const out: string[] = [];
  const re = /<(?:[\w.-]+:)?calendar-data(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?calendar-data>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    let value = m[1].trim();
    if (value.startsWith("<![CDATA[") && value.endsWith("]]>")) value = value.slice(9, -3);
    else value = decodeXml(value);
    if (/BEGIN:VEVENT/i.test(value)) out.push(value);
  }
  return out;
}
async function fetchCalendarEvents(homeUrl: string, email: string, password: string) {
  const listBody = '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>';
  const listed = await caldav(homeUrl, email, password, "PROPFIND", "1", listBody);
  const blocks = listed.text.match(/<(?:[\w.-]+:)?response(?:\s[^>]*)?>[\s\S]*?<\/(?:[\w.-]+:)?response>/gi) || [];
  const calendars: string[] = [];
  for (const block of blocks) {
    if (!/<(?:[\w.-]+:)?calendar(?:\s[^>]*)?\s*\/>/i.test(block) && !/<(?:[\w.-]+:)?calendar(?:\s[^>]*)?>/i.test(block)) continue;
    const hrefMatch = block.match(/<(?:[\w.-]+:)?href(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?href>/i);
    if (hrefMatch) {
      const href = decodeXml(hrefMatch[1].trim());
      const url = resolveHref(href, listed.url);
      if (url.startsWith("https://") && !calendars.includes(url)) calendars.push(url);
    }
  }
  if (!calendars.length) throw new Error("APPLE_NO_CALENDARS_FOUND");
  const query = '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20180101T000000Z" end="20350101T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
  const events: string[] = [];
  for (const url of calendars) {
    const result = await caldav(url, email, password, "REPORT", "1", query);
    events.push(...calendarDataBlocks(result.text));
    if (events.length > 10000) throw new Error("APPLE_TOO_MANY_EVENTS");
  }
  const vevents: string[] = [];
  for (const item of events) {
    const re = /BEGIN:VEVENT[\s\S]*?END:VEVENT/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(item))) vevents.push(m[0]);
  }
  return { calendars: calendars.length, vevents };
}
Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.method !== "POST") return out({ error: "METHOD_NOT_ALLOWED" }, 405);
    const user = await telegramUser(req.headers.get("x-telegram-init-data") || "");
    const body = await req.json();
    const action = String(body.action || "");
    const studios = await db("tm_studios?owner_telegram_user_id=eq." + encodeURIComponent(String(user.id)) + "&select=id,owner_telegram_user_id");
    if (!studios?.length) return out({ error: "MASTER_NOT_LINKED" }, 403);
    const studio = studios[0];
    const table = "tm_apple_calendar_connections";
    if (action === "connect") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.app_password || "").replace(/\s+/g, "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return out({ error: "APPLE_EMAIL_INVALID" }, 400);
      if (!/^[a-z0-9-]{12,32}$/i.test(password)) return out({ error: "APPLE_APP_PASSWORD_FORMAT_INVALID" }, 400);
      const found = await discover(email, password);
      const encrypted = await encryptCredentials(email, password);
      const payload = {
        studio_id: studio.id,
        owner_telegram_user_id: user.id,
        account_email: email,
        credentials_encrypted: encrypted,
        principal_url: found.principalUrl,
        calendar_home_url: found.calendarHomeUrl,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      await db(table + "?on_conflict=studio_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(payload)
      });
      return out({ ok: true, connected: true, email, connected_at: payload.connected_at });
    }
    if (action === "status") {
      const rows = await db(table + "?studio_id=eq." + studio.id + "&select=account_email,connected_at");
      return out({ connected: !!rows?.[0]?.connected_at, email: rows?.[0]?.account_email || null, connected_at: rows?.[0]?.connected_at || null });
    }
    if (action === "disconnect") {
      await db(table + "?studio_id=eq." + studio.id, { method: "DELETE" });
      return out({ ok: true });
    }
    if (action === "sync") {
      const rows = await db(table + "?studio_id=eq." + studio.id + "&select=credentials_encrypted,calendar_home_url,account_email");
      const row = rows?.[0];
      if (!row) return out({ error: "APPLE_CALENDAR_NOT_CONNECTED" }, 400);
      const credentials = await decryptCredentials(row.credentials_encrypted);
      const result = await fetchCalendarEvents(row.calendar_home_url, credentials.email, credentials.password);
      const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//TATTOO MANAGER//Apple Calendar Import//RU\r\n" +
        result.vevents.join("\r\n") + "\r\nEND:VCALENDAR\r\n";
      return out({ ok: true, email: row.account_email, calendar_count: result.calendars, event_count: result.vevents.length, ics });
    }
    return out({ error: "UNKNOWN_ACTION" }, 400);
  } catch (e) {
    const m = e instanceof Error ? e.message : "INTERNAL_ERROR";
    const status = /INVALID_TELEGRAM|TELEGRAM_INIT_DATA|TELEGRAM_USER/.test(m) ? 401 : 500;
    console.error("APPLE_CALENDAR_API", m);
    return out({ error: m }, status);
  }
});