import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const base = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(base + "/rest/v1/" + path, {
    ...init,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {})
    }
  });
  const t = await r.text();
  if (!r.ok) throw new Error("DATABASE_ERROR_" + r.status + ": " + t);
  return t ? JSON.parse(t) : null;
}
function digestHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, "0")).join("");
}
function localDateTimeToUtc(date: string, time: string, timezone: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [hh, mm, ss0] = time.split(":").map(Number);
  const ss = ss0 || 0;
  const target = Date.UTC(y, mo - 1, d, hh, mm, ss);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    const delta = target - represented;
    guess += delta;
    if (delta === 0) break;
  }
  return new Date(guess);
}
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const supplied = req.headers.get("x-tm-cron-secret") || "";
    if (supplied.length < 32) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const expectedRows = await db("tm_task_reminder_guard?id=eq.true&select=secret_hash");
    const actualHash = digestHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)));
    if (!expectedRows?.length || actualHash !== expectedRows[0].secret_hash) {
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }
    const now = new Date();
    const staleClaim = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const oldestAllowed = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const rows = await db(
      "tm_tasks?status=eq.pending&reminder_sent_at=is.null&due_date=not.is.null&due_time=not.is.null" +
      "&select=id,title,description,due_date,due_time,priority,studio_id,reminder_claimed_at,studio:tm_studios!inner(owner_telegram_user_id,timezone)" +
      "&limit=500"
    );
    let sent = 0, skipped = 0, failed = 0;
    for (const task of rows || []) {
      const studio = Array.isArray(task.studio) ? task.studio[0] : task.studio;
      const chatId = studio?.owner_telegram_user_id;
      if (!chatId) { skipped++; continue; }
      let due: Date;
      try { due = localDateTimeToUtc(String(task.due_date), String(task.due_time), String(studio.timezone || "Asia/Novosibirsk")); }
      catch { skipped++; continue; }
      if (due.getTime() > now.getTime() || due.getTime() < oldestAllowed.getTime()) { skipped++; continue; }
      const claim = await db(
        "tm_tasks?id=eq." + encodeURIComponent(task.id) +
        "&status=eq.pending&reminder_sent_at=is.null&or=" +
        encodeURIComponent("(reminder_claimed_at.is.null,reminder_claimed_at.lt." + staleClaim + ")"),
        { method: "PATCH", body: JSON.stringify({ reminder_claimed_at: now.toISOString() }) }
      );
      if (!claim?.length) { skipped++; continue; }
      const dueLabel = String(task.due_date).split("-").reverse().join(".") + " в " + String(task.due_time).slice(0, 5);
      const priority = task.priority === "high" ? "Высокий" : task.priority === "low" ? "Низкий" : "Средний";
      const message = "⏰ Напоминание о задаче\n\n" + String(task.title).slice(0, 180) +
        (task.description ? "\n" + String(task.description).slice(0, 500) : "") +
        "\n\nСрок: " + dueLabel + "\nПриоритет: " + priority;
      try {
        const tg = await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            reply_markup: { inline_keyboard: [[{ text: "Открыть TATTOO MANAGER", url: "https://t.me/TattooManagerAppBot/tattoo_manager" }]] }
          })
        });
        const result = await tg.json();
        if (!tg.ok || !result.ok) throw new Error("TELEGRAM_SEND_FAILED");
        await db("tm_tasks?id=eq." + encodeURIComponent(task.id), {
          method: "PATCH",
          body: JSON.stringify({ reminder_sent_at: new Date().toISOString(), reminder_claimed_at: null })
        });
        sent++;
      } catch (err) {
        await db("tm_tasks?id=eq." + encodeURIComponent(task.id), {
          method: "PATCH",
          body: JSON.stringify({ reminder_claimed_at: null })
        }).catch(() => {});
        failed++;
        console.error("TASK_REMINDER_FAILED", task.id, err);
      }
    }

    // Visit reminders: 24 hours and 2 hours before the scheduled local time.
    const dayFrom = new Date(now.getTime() - 36 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dayTo = new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [appointments, events] = await Promise.all([
      db("tm_appointments?status=eq.confirmed&requested_date=gte." + dayFrom + "&requested_date=lte." + dayTo +
        "&select=id,studio_id,client_id,client_telegram_user_id,client_name,project_type,requested_date,requested_time,studio:tm_studios!inner(owner_telegram_user_id,timezone),client:tm_clients(telegram_user_id,full_name)&limit=1000"),
      db("tm_calendar_events?event_date=gte." + dayFrom + "&event_date=lte." + dayTo +
        "&event_type=in.(session,correction,consult,student,model)&select=id,studio_id,client_id,event_date,event_time,event_type,name,note,studio:tm_studios!inner(owner_telegram_user_id,timezone),client:tm_clients(telegram_user_id,full_name)&limit=1000")
    ]);
    let visitChecked = 0, visitSent = 0, visitSkipped = 0, visitFailed = 0;
    const masterUrl = "https://tattoo-manager-recovery.onrender.com/?v=75";
    const clientUrl = "https://tattoo-manager-recovery.onrender.com/client.html?v=22";
    async function sendVisitReminder(targetType: string, targetId: string, offset: number, role: string, chatId: number, message: string, confirmButton?: {text:string;callback_data:string}, actionButtons?: {text:string;callback_data:string}[]) {
      const claim = await db("tm_visit_reminder_log?on_conflict=target_type,target_id,offset_minutes,recipient_role,recipient_telegram_user_id", {
        method: "POST",
        headers: { "Prefer": "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify([{ target_type: targetType, target_id: targetId, offset_minutes: offset, recipient_role: role, recipient_telegram_user_id: chatId }])
      });
      if (!claim?.length) { visitSkipped++; return; }
      try {
        const url = role === "master" ? masterUrl : clientUrl;
        const label = role === "master" ? "Открыть кабинет мастера" : "Открыть личный кабинет";
        const tg = await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true,
            reply_markup: { inline_keyboard: [...(role === "client" && confirmButton ? [[confirmButton]] : []), ...(role === "client" && actionButtons ? actionButtons.map(x => [x]) : []), [{ text: label, web_app: { url } }]] } })
        });
        const result = await tg.json();
        if (!tg.ok || !result.ok) throw new Error(result?.description || "TELEGRAM_SEND_FAILED");
        visitSent++;
      } catch (err) {
        await db("tm_visit_reminder_log?id=eq." + encodeURIComponent(claim[0].id), { method: "DELETE" }).catch(() => {});
        visitFailed++;
        console.error("VISIT_REMINDER_FAILED", targetType, targetId, role, err);
      }
    }
    function visitLabel(type: string) {
      const labels: Record<string, string> = { session: "Сеанс", correction: "Коррекция", consult: "Консультация", student: "Учёба", model: "Модель" };
      return labels[type] || type;
    }
    for (const ap of appointments || []) {
      visitChecked++;
      const studio = Array.isArray(ap.studio) ? ap.studio[0] : ap.studio;
      if (!studio) { visitSkipped++; continue; }
      const date = String(ap.requested_date), time = String(ap.requested_time).slice(0, 8);
      let due: Date;
      try { due = localDateTimeToUtc(date, time, String(studio.timezone || "Asia/Novosibirsk")); }
      catch { visitSkipped++; continue; }
      const diff = due.getTime() - now.getTime();
      const offsets = [1440, 120].filter(v => diff > v * 60000 - 65000 && diff <= v * 60000 + 5000);
      if (!offsets.length) continue;
      const dateLabel = date.split("-").reverse().join(".");
      const timeLabel = time.slice(0, 5);
      const name = String(ap.client_name || "Клиент");
      const title = String(ap.project_type || "Тату-сеанс");
      const ownerId = studio.owner_telegram_user_id ? Number(studio.owner_telegram_user_id) : null;
      const linked = Array.isArray(ap.client) ? ap.client[0] : ap.client;
      const clientId = ap.client_telegram_user_id || linked?.telegram_user_id;
      for (const offset of offsets) {
        const when = offset === 1440 ? "через 24 часа" : "через 2 часа";
        const common = "🖤 TATTOO MANAGER · НАПОМИНАНИЕ\n\nПривет, " + name + "! Твой визит уже скоро.\n\n🎨 " + title + "\n📅 " + dateLabel + "\n🕒 " + timeLabel + "\n\nДо встречи " + when + "! Если планы изменились, сообщи мастеру заранее.";
        if (ownerId) await sendVisitReminder("appointment", ap.id, offset, "master", ownerId,
          "🔔 НАПОМИНАНИЕ МАСТЕРУ\n\nКлиент: " + name + "\nПроект: " + title + "\n📅 " + dateLabel + " · 🕒 " + timeLabel + "\n\nДо визита " + when + ".");
        if (clientId) await sendVisitReminder("appointment", ap.id, offset, "client", Number(clientId), common,
          { text: "✅ Подтвердить визит", callback_data: "vc|a|" + ap.id },
          [{ text: "🕒 Предложить другое время", callback_data: "vr|a|" + ap.id }, { text: "❌ Отменить запись", callback_data: "vx|a|" + ap.id }]);
      }
    }
    for (const ev of events || []) {
      visitChecked++;
      const studio = Array.isArray(ev.studio) ? ev.studio[0] : ev.studio;
      if (!studio) { visitSkipped++; continue; }
      if (!ev.event_time) { visitSkipped++; continue; }
      const date = String(ev.event_date), time = String(ev.event_time).slice(0, 8);
      let due: Date;
      try { due = localDateTimeToUtc(date, time, String(studio.timezone || "Asia/Novosibirsk")); }
      catch { visitSkipped++; continue; }
      const diff = due.getTime() - now.getTime();
      const offsets = [1440, 120].filter(v => diff > v * 60000 - 65000 && diff <= v * 60000 + 5000);
      if (!offsets.length) continue;
      const dateLabel = date.split("-").reverse().join(".");
      const timeLabel = time.slice(0, 5);
      const type = visitLabel(String(ev.event_type));
      const person = String(ev.name || "Участник");
      const ownerId = studio.owner_telegram_user_id ? Number(studio.owner_telegram_user_id) : null;
      const linkedClient = Array.isArray(ev.client) ? ev.client[0] : ev.client;
      const clientId = linkedClient?.telegram_user_id ? Number(linkedClient.telegram_user_id) : null;
      for (const offset of offsets) {
        const when = offset === 1440 ? "через 24 часа" : "через 2 часа";
        const note = ev.note ? "\nКомментарий: " + String(ev.note).slice(0, 400) : "";
        if (clientId) await sendVisitReminder("calendar_event", ev.id, offset, "client", clientId,
          "🖤 TATTOO MANAGER · НАПОМИНАНИЕ\n\n" + type + "\n👤 " + person + "\n📅 " + dateLabel + " · 🕒 " + timeLabel + note + "\n\nДо визита " + when + ". Если планы изменились, сообщи мастеру.",
          { text: "✅ Подтвердить визит", callback_data: "vc|e|" + ev.id },
          [{ text: "🕒 Предложить другое время", callback_data: "vr|e|" + ev.id }, { text: "✉️ Не смогу прийти", callback_data: "vx|e|" + ev.id }]);
      }
    }

    // Queue birthday greetings using the client's local studio timezone.
    const birthdayClients = await db("tm_clients?telegram_user_id=not.is.null&select=id,studio_id,telegram_user_id,full_name,studio:tm_studios!inner(timezone)&limit=2000");
    const profileIds = [...new Set((birthdayClients||[]).map((x:any)=>Number(x.telegram_user_id)).filter((x:number)=>Number.isSafeInteger(x)&&x>0))];
    const profileRows = profileIds.length ? await db("tm_user_profiles?telegram_user_id=in.("+profileIds.join(",")+")&select=telegram_user_id,date_of_birth") : [];
    const birthdayMap = new Map((profileRows||[]).filter((x:any)=>x.date_of_birth).map((x:any)=>[Number(x.telegram_user_id),String(x.date_of_birth)]));
    for (const client of birthdayClients||[]) {
      const dob = birthdayMap.get(Number(client.telegram_user_id));
      if (!dob) continue;
      const studio = Array.isArray(client.studio)?client.studio[0]:client.studio;
      const timezone = String(studio?.timezone||"Asia/Novosibirsk");
      const todayParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now).map(p=>[p.type,p.value]));
      const localToday = String(todayParts.year)+"-"+String(todayParts.month)+"-"+String(todayParts.day);
      if (dob.slice(5)!==localToday.slice(5)) continue;
      const scheduled = localDateTimeToUtc(localToday,"09:00",timezone);
      await db("tm_client_message_queue?on_conflict=message_type,target_type,target_id,scheduled_at",{
        method:"POST",
        headers:{"Prefer":"resolution=ignore-duplicates,return=representation"},
        body:JSON.stringify([{message_type:"birthday",studio_id:client.studio_id,client_id:client.id,target_type:"birthday",target_id:client.id,telegram_user_id:Number(client.telegram_user_id),scheduled_at:scheduled.toISOString()}])
      });
    }

    // Deliver delayed review requests and birthday greetings.
    const dueMessages = await db("tm_client_message_queue?sent_at=is.null&scheduled_at=lte."+encodeURIComponent(now.toISOString())+"&select=id,message_type,studio_id,client_id,target_id,telegram_user_id&order=scheduled_at.asc&limit=200");
    let queuedSent = 0, queuedFailed = 0;
    for (const item of dueMessages||[]) {
      const clientRows = await db("tm_clients?id=eq."+encodeURIComponent(item.client_id)+"&studio_id=eq."+encodeURIComponent(item.studio_id)+"&select=full_name");
      const clientName = String(clientRows?.[0]?.full_name||"друг");
      const studioRows = await db("tm_studios?id=eq."+encodeURIComponent(item.studio_id)+"&select=review_url,artist_name");
      const studioSettings = studioRows?.[0] || {};
      const artistName = String(studioSettings.artist_name||"ваш мастер");
      const reviewUrl = String(studioSettings.review_url||"").trim();
      const message = item.message_type==="review"
        ? "⭐ TATTOO MANAGER · ВАШЕ МНЕНИЕ ВАЖНО\\n\\nПривет, "+clientName+"! Как проходит заживление и какое впечатление осталось от сеанса у мастера "+artistName+"? Будем благодарны за пару слов. 🖤"
        : item.message_type==="correction_reminder"
          ? "🖤 ПОРА ОБСУДИТЬ КОРРЕКЦИЮ\\n\\nПривет, "+clientName+"! После сеанса прошло около месяца. Если татуировка уже зажила, самое время связаться с мастером и обсудить, нужна ли коррекция. Решение о необходимости и сроках лучше принять вместе с мастером."
          : "🎂 С ДНЁМ РОЖДЕНИЯ, "+clientName.toUpperCase()+"!\\n\\nЖелаю вдохновения, ярких идей и исполнения желаний. Пусть впереди будет много красивых историй и отличных татуировок! 🖤";
      try {
        const keyboard = item.message_type==="review"
          ? [[...(reviewUrl ? [{text:"⭐ Оставить отзыв",url:reviewUrl}] : [{text:"⭐ Написать отзыв мастеру",callback_data:"review|"+item.id}])],[{text:"Открыть личный кабинет",web_app:{url:clientUrl}}]]
          : [[{text:"🖤 Открыть личный кабинет",web_app:{url:clientUrl}}]];
        const tg=await fetch("https://api.telegram.org/bot"+botToken+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:item.telegram_user_id,text:message,disable_web_page_preview:true,reply_markup:{inline_keyboard:keyboard}})});
        const result=await tg.json();
        if(!tg.ok||!result.ok)throw new Error(result?.description||"TELEGRAM_SEND_FAILED");
        await db("tm_client_message_queue?id=eq."+encodeURIComponent(item.id),{method:"PATCH",body:JSON.stringify({sent_at:new Date().toISOString()})});
        queuedSent++;
      } catch(err) {
        queuedFailed++;
        console.error("CLIENT_MESSAGE_QUEUE_FAILED",item.id,err);
      }
    }
    return Response.json({ ok: true, checked: rows?.length || 0, sent, skipped, failed, visit_checked: visitChecked, visit_sent: visitSent, visit_skipped: visitSkipped, visit_failed: visitFailed, queued_sent: queuedSent, queued_failed: queuedFailed });
  } catch (err) {
    console.error("TASK_REMINDER_CRON_ERROR", err);
    return Response.json({ error: "REMINDER_PROCESS_FAILED" }, { status: 500 });
  }
});