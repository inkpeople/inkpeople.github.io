import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const token = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const base = Deno.env.get("SUPABASE_URL") || "";
const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const masterUrl = "https://tattoo-manager-recovery.onrender.com/?v=82";
const clientUrl = "https://tattoo-manager-recovery.onrender.com/client.html?v=28";

function reply(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
async function db(path: string, method = "GET", body?: unknown, prefer?: string) {
  const headers: Record<string,string> = {
    apikey: service,
    Authorization: "Bearer " + service,
    "Content-Type": "application/json",
    Prefer: prefer || "return=representation",
  };
  const res = await fetch(base + "/rest/v1/" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error("DB_" + res.status + ": " + txt.slice(0,300));
  return txt ? JSON.parse(txt) : null;
}
async function bot(method: string, data: unknown) {
  const res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok || json.ok !== true) throw new Error("BOT_API_" + method);
  return json.result;
}
async function sha256Hex(value: string) {
 const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));
 return [...digest].map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function redeemClientLink(chat:number,id:number,rawToken:string) {
 if(!/^[a-f0-9]{48}$/i.test(rawToken)){await send(chat,"Ссылка привязки некорректна. Попросите мастера создать новую.");return;}
 const now=new Date().toISOString(),hash=await sha256Hex(rawToken.toLowerCase());
 const matches=await db("tm_client_link_tokens?token_hash=eq."+hash+"&used_at=is.null&expires_at=gt."+encodeURIComponent(now)+"&select=id,studio_id,client_id");
 if(!matches.length){await send(chat,"Ссылка уже использована или срок её действия истёк. Попросите мастера создать новую.");return;}
 const link=matches[0];
 const clients=await db("tm_clients?id=eq."+encodeURIComponent(link.client_id)+"&studio_id=eq."+link.studio_id+"&select=id,full_name,telegram_user_id");
 if(!clients.length){await send(chat,"Карточка клиента не найдена. Попросите мастера создать новую ссылку.");return;}
 const client=clients[0];
 if(client.telegram_user_id&&Number(client.telegram_user_id)!==id){await send(chat,"Эта карточка уже привязана к другому Telegram-аккаунту. Обратитесь к мастеру.");return;}
 const existing=await db("tm_clients?studio_id=eq."+link.studio_id+"&telegram_user_id=eq."+id+"&select=id");
 if(existing.some((x:any)=>x.id!==link.client_id)){await send(chat,"Ваш Telegram уже привязан к другой карточке этого мастера. Попросите мастера проверить CRM.");return;}
 const claimed=await db("tm_client_link_tokens?id=eq."+link.id+"&used_at=is.null&expires_at=gt."+encodeURIComponent(now),"PATCH",{used_at:now,redeemed_by_telegram_user_id:id});
 if(!claimed.length){await send(chat,"Ссылка уже использована. Если привязка не завершилась, попросите мастера создать новую.");return;}
 const filter=client.telegram_user_id?"telegram_user_id=eq."+id:"telegram_user_id=is.null";
 const updated=await db("tm_clients?id=eq."+encodeURIComponent(link.client_id)+"&studio_id=eq."+link.studio_id+"&"+filter,"PATCH",{telegram_user_id:id,updated_at:now});
 if(!updated.length&&Number(client.telegram_user_id)!==id){await send(chat,"Не удалось завершить привязку. Попросите мастера создать новую ссылку.");return;}
 await db("tm_user_profiles?telegram_user_id=eq."+id,"PATCH",{preferred_studio_id:link.studio_id,updated_at:now});
 await saveRole(id,"client",null);await clearReg(id);
 await send(chat,"Готово! Ваш Telegram привязан к карточке «"+safe(client.full_name,100)+"».\n\nТеперь в личном кабинете будут отображаться ваши записи и фотографии готовых татуировок, которые мастер добавит именно в вашу карточку.",[[{text:"Открыть личный кабинет клиента",web_app:{url:clientUrl}}]]);
}
function safe(value: unknown, max = 120) {
  return String(value || "").trim().slice(0, max);
}
async function send(chat: number, text: string, rows?: unknown[]) {
  const data: Record<string,unknown> = { chat_id: chat, text };
  if (rows) data.reply_markup = { inline_keyboard: rows };
  await bot("sendMessage", data);
}
async function askPhone(chat: number, text: string) {
  await bot("sendMessage", { chat_id: chat, text, reply_markup: { keyboard: [[{ text: "📱 Поделиться номером", request_contact: true }], [{ text: "Пропустить" }]], resize_keyboard: true, one_time_keyboard: true } });
}
async function confirmKeyboard(chat: number, text: string, callback: string) {
  await bot("sendMessage", { chat_id: chat, text: "Данные сохранены.", reply_markup: { remove_keyboard: true } });
  await send(chat, text, [[{ text: "Всё верно · продолжить", callback_data: callback }, { text: "Отменить регистрацию", callback_data: "registration_cancel" }]]);
}
async function finishClient(chat: number, id: number, draft: any) {
  await db("tm_user_profiles?telegram_user_id=eq." + id, "PATCH", { full_name: safe(draft.client_name), phone: safe(draft.phone, 40) || null, date_of_birth: draft.date_of_birth || null, preferred_studio_id: draft.preferred_studio_id || null, referral_code: draft.referral_code || null, updated_at: new Date().toISOString() });
  await saveRole(id, "client", null);
  await clearReg(id);
  const message = draft.preferred_studio_name ? "Готово! Ваш личный кабинет создан. Мастер " + safe(draft.preferred_studio_name, 100) + " уже добавлен в него." : "Готово! Ваш личный кабинет клиента создан.";
  await send(chat, "🖤 " + message + "\n\nВаш личный кабинет готов. Здесь будут ваши записи, референсы, история татуировок и связь с мастером.", [[{ text: "✨ Открыть мой кабинет", web_app: { url: clientUrl } }]]);
}
async function finishMaster(chat: number, id: number, draft: any) {
  let studio = await studioFor(id);
  if (!studio) {
    const artistName = safe(draft.artist_name) || "Индивидуальный мастер";
    // studio_name is a legacy database field; this account belongs to one independent artist, not a studio.
    const created = await db("tm_studios", "POST", [{ slug: "artist-" + id, studio_name: "Профиль мастера · " + artistName, artist_name: artistName, city: safe(draft.city, 100), owner_telegram_user_id: id, public_booking_enabled: true }]);
    studio = created[0];
  }
  await saveRole(id, "master", studio.id);
  await db("tm_user_profiles?telegram_user_id=eq." + id, "PATCH", { full_name: safe(draft.artist_name), phone: safe(draft.phone, 40) || null, updated_at: new Date().toISOString() });
  await clearReg(id);
  await send(chat, "🖤 ПРОФИЛЬ МАСТЕРА СОЗДАН\n\nДобро пожаловать в TATTOO MANAGER AI!\n\nТеперь у вас есть личное рабочее пространство: клиенты, календарь, записи, финансы и ИИ-помощник. Данные вашего кабинета отделены от кабинетов других мастеров.", [[{ text: "🚀 Открыть мой кабинет", web_app: { url: masterUrl } }]]);
}
async function profile(user: any) {
  await db("tm_user_profiles?on_conflict=telegram_user_id", "POST", [{
    telegram_user_id: user.id,
    username: user.username || null,
    first_name: user.first_name || null,
    last_name: user.last_name || null,
    updated_at: new Date().toISOString(),
  }], "resolution=merge-duplicates,return=representation");
}
async function studioFor(id: number) {
  const rows = await db("tm_studios?owner_telegram_user_id=eq." + id + "&select=id,artist_name,studio_name,city");
  return rows[0] || null;
}
async function studioBySlug(slug: string) {
  const rows = await db("tm_studios?slug=eq." + encodeURIComponent(slug) + "&public_booking_enabled=eq.true&select=id,slug,artist_name,studio_name,city,owner_telegram_user_id");
  return rows[0] || null;
}
async function roles(id: number) {
  return await db("tm_user_roles?telegram_user_id=eq." + id + "&select=role,studio_id");
}
async function saveRole(id: number, role: string, studioId: string | null) {
  await db("tm_user_roles?on_conflict=telegram_user_id,role", "POST", [{
    telegram_user_id: id, role, studio_id: studioId,
  }], "resolution=merge-duplicates,return=representation");
}
async function reg(id: number) {
  const rows = await db("tm_bot_registration?telegram_user_id=eq." + id + "&select=role,step,draft");
  return rows[0] || null;
}
async function saveReg(id: number, role: string, step: string, draft: any) {
  await db("tm_bot_registration?on_conflict=telegram_user_id", "POST", [{
    telegram_user_id: id, role, step, draft, updated_at: new Date().toISOString(),
  }], "resolution=merge-duplicates,return=representation");
}
async function clearReg(id: number) {
  await db("tm_bot_registration?telegram_user_id=eq." + id, "DELETE");
}
async function chooseRole(chat: number) {
  await send(chat, "🖤 TATTOO MANAGER AI\n\nВаша личная система для тату-индустрии.\n\nМастеру — клиенты, записи, календарь и финансы.\nКлиенту — личные записи, референсы и связь с мастером.\n\nДля продолжения выберите свой профиль:", [[
    { text: "🎨 Я тату-мастер", callback_data: "role_master" },
    { text: "👤 Я клиент", callback_data: "role_client" },
  ]]);
}
async function cabinetMenu(chat: number, id: number) {
  const list = await roles(id);
  const rows: any[] = [];
  if (list.some((x: any) => x.role === "master")) rows.push([{ text: "Открыть кабинет мастера", web_app: { url: masterUrl } }]);
  if (list.some((x: any) => x.role === "client")) {
    rows.push([{ text: "Открыть личный кабинет клиента", web_app: { url: clientUrl } }]);
    rows.push([{ text: "🎂 Указать дату рождения", callback_data: "birthday_set" }]);
  }
  const more: any[] = [];
  if (!list.some((x: any) => x.role === "master")) more.push({ text: "Регистрация мастера", callback_data: "role_master" });
  if (!list.some((x: any) => x.role === "client")) more.push({ text: "Регистрация клиента", callback_data: "role_client" });
  if (more.length) rows.push(more);
  rows.push([{ text: "Выбрать роль", callback_data: "choose_role" }]);
  await send(chat, "🖤 ВАШИ КАБИНЕТЫ\n\nВыберите, куда перейти:", rows);
}
async function startRole(chat: number, id: number, role: string) {
  if (role === "master") {
    await clearReg(id);
    const studio = await studioFor(id);
    if (studio) {
      await saveRole(id, "master", studio.id);
      await send(chat, "Ваш кабинет мастера уже зарегистрирован.", [[{ text: "Открыть кабинет мастера", web_app: { url: masterUrl } }]]);
    } else {
      await saveReg(id, "master", "artist", {});
      await send(chat, "🎨 СОЗДАНИЕ ПРОФИЛЯ МАСТЕРА\\nЭтап 1 из 3\\n\\nКак вас представить клиентам? Напишите имя или творческий псевдоним.");
    }
    return;
  }
  const pending = await reg(id);
  const draft = pending?.draft || {};
  const preferredStudioId = draft.preferred_studio_id || null;
  const list = await roles(id);
  if (preferredStudioId) await db("tm_user_profiles?telegram_user_id=eq." + id, "PATCH", { preferred_studio_id: preferredStudioId, updated_at: new Date().toISOString() });
  if (list.some((x: any) => x.role === "client")) {
    await clearReg(id);
    await send(chat, preferredStudioId ? "🖤 Мастер добавлен в ваш личный кабинет." : "🖤 Ваш личный кабинет клиента уже создан.", [[{ text: "✨ Открыть кабинет клиента", web_app: { url: clientUrl } }],[{ text: "🎂 Указать дату рождения", callback_data: "birthday_set" }]]);
  } else {
    await saveReg(id, "client", "client_name", draft);
    const studioText = draft.preferred_studio_name ? "\\nВаш мастер: " + safe(draft.preferred_studio_name, 100) : "";
    await send(chat, "👤 СОЗДАНИЕ ЛИЧНОГО КАБИНЕТА\n\nРады видеть вас в TATTOO MANAGER AI!" + studioText + "\n\nКак к вам обращаться? Напишите имя или имя и фамилию.");
  }
}
async function onText(chat: number, user: any, text: string) {
  const id = Number(user.id);
  const startMatch = text.match(/^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]+))?$/i);
  if (startMatch) {
    const ownStudio = await studioFor(id);
    if (ownStudio) await saveRole(id, "master", ownStudio.id);
    const payload = startMatch[1] || "";
    if(payload.startsWith("link_")){await redeemClientLink(chat,id,payload.slice(5));return;}
    if (payload.startsWith("studio_")) {
      let studioPayload = payload.slice(7), referralCode = "";
      const referralMarker = studioPayload.lastIndexOf("_ref_");
      if (referralMarker > 0) { referralCode = studioPayload.slice(referralMarker + 5).toUpperCase(); studioPayload = studioPayload.slice(0, referralMarker); }
      const referred = await studioBySlug(studioPayload);
      if (referred) {
        let validReferralCode = "";
        let referralInviter: any = null;
        if (referralCode && /^[A-F0-9]{10,16}$/.test(referralCode)) {
          const owners = await db("tm_clients?studio_id=eq." + referred.id + "&referral_code=eq." + encodeURIComponent(referralCode) + "&select=id,full_name,telegram_user_id");
          if (owners.length && Number(owners[0].telegram_user_id) !== id) {
            validReferralCode = referralCode;
            referralInviter = owners[0];
          }
        }
        if (validReferralCode && referralInviter && referred.owner_telegram_user_id) {
          try {
            const visit = await db(
              "tm_referral_visits?on_conflict=studio_id,referred_telegram_user_id",
              "POST",
              [{
                studio_id: referred.id,
                referrer_client_id: referralInviter.id,
                referred_telegram_user_id: id,
                referred_name: safe([user.first_name, user.last_name].filter(Boolean).join(" ") || user.first_name || "Новый пользователь", 120),
                referred_username: user.username || null
              }],
              "resolution=ignore-duplicates,return=representation"
            );
            if (visit.length) {
              const inviterName = safe(referralInviter.full_name, 100) || "Клиент";
              const visitorName = safe([user.first_name, user.last_name].filter(Boolean).join(" ") || user.first_name || "Пользователь Telegram", 120);
              const visitorHandle = user.username ? " (@" + safe(user.username, 50) + ")" : "";
              await send(Number(referred.owner_telegram_user_id),
                "🔔 Переход по реферальной ссылке\n\nНовый пользователь: " + visitorName + visitorHandle +
                "\nПригласил: " + inviterName +
                "\n\nПользователь открыл приложение по реферальной ссылке. Он ещё может не заполнить регистрацию и не записаться."
              );
            }
          } catch (err) {
            console.error("REFERRAL_VISIT_NOTIFICATION_ERROR", err);
          }
        }
        const currentRoles = await roles(id);
        if (currentRoles.some((x: any) => x.role === "client")) {
          await db("tm_user_profiles?telegram_user_id=eq." + id, "PATCH", { preferred_studio_id: referred.id, referral_code: validReferralCode || null, updated_at: new Date().toISOString() });
          await send(chat, "Мастер " + safe(referred.artist_name || referred.studio_name, 100) + " добавлен в ваш личный кабинет." + (validReferralCode ? "\n\nСсылка друга активирована. После его первого завершённого сеанса вам начислится скидка 3 000 ₽ на следующий сеанс." : ""), [[{ text: "Открыть кабинет клиента", web_app: { url: clientUrl } }]]);
        } else {
          await saveReg(id, "client", "client_name", { preferred_studio_id: referred.id, preferred_studio_name: referred.artist_name || referred.studio_name || "Мастер", referral_code: validReferralCode || null });
          await send(chat, "Вы перешли по персональной ссылке мастера " + safe(referred.artist_name || referred.studio_name, 100) + "." + (validReferralCode ? "\n\nПосле первого завершённого сеанса вашего друга ему начислится скидка 3 000 ₽ на следующий сеанс." : "") + "\n\nСоздадим ваш личный кабинет. Напишите, как вас зовут.");
        }
        return;
      }
    }
    await chooseRole(chat);
    return;
  }
  if (/^\/cancel(?:@\w+)?$/i.test(text)) {
    await clearReg(id);
    await send(chat, "Регистрация отменена. Для начала отправьте /start.");
    return;
  }
  const state = await reg(id);
  if (!state) { await send(chat, "Отправьте /start, чтобы открыть или создать личный кабинет."); return; }
  const value = safe(text);
  if (!value) { await send(chat, "Отправьте ответ текстом."); return; }
  if (state.step === "birthday_update") {
    const m=value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if(!m){await send(chat,"Введите дату в формате ДД.ММ.ГГГГ.");return;}
    const d=new Date(Date.UTC(Number(m[3]),Number(m[2])-1,Number(m[1])));
    if(d.getUTCFullYear()!==Number(m[3])||d.getUTCMonth()!==Number(m[2])-1||d.getUTCDate()!==Number(m[1])){await send(chat,"Дата указана неверно. Проверьте её и отправьте ещё раз.");return;}
    const dob=m[3]+"-"+m[2]+"-"+m[1];
    await db("tm_user_profiles?telegram_user_id=eq."+id,"PATCH",{date_of_birth:dob,updated_at:new Date().toISOString()});
    await clearReg(id);
    await send(chat,"🎂 Дата рождения сохранена! В день рождения придёт поздравление. 🖤");
    return;
  }
  if (["visit_reschedule","visit_cancel_request","review_feedback"].includes(state.step)) {
    const d = state.draft || {}, masterId = Number(d.master_id || 0);
    if (masterId) {
      const heading = state.step === "visit_reschedule" ? "🕒 ЗАПРОС НА ПЕРЕНОС ВИЗИТА" : state.step === "visit_cancel_request" ? "❌ ЗАПРОС НА ОТМЕНУ ВИЗИТА" : "⭐ ОТЗЫВ КЛИЕНТА";
      await send(masterId, heading + "\n\nКлиент: " + safe(d.client_name || "Клиент",100) + (d.date ? "\nТекущая запись: "+d.date+" в "+safe(d.time,5) : "") + "\n\nСообщение: " + value.slice(0,1000));
    }
    await clearReg(id);
    await send(chat, state.step === "review_feedback" ? "Спасибо за отзыв! Я передал его мастеру. 🖤" : "Готово! Сообщение отправлено мастеру. Он свяжется с вами для уточнения деталей.");
    return;
  }
  if (state.step === "client_name") {
    const draft = state.draft || {};
    draft.client_name = value;
    await saveReg(id, "client", "client_phone", draft);
    await askPhone(chat, "Имя сохранено: " + value + ".\n\nМожете поделиться номером телефона, чтобы мастеру было проще связаться с вами по записи. Это необязательно.");
    return;
  }
  if (state.step === "client_phone") {
    const draft = state.draft || {};
    if (value.toLowerCase() !== "пропустить" && value !== "Продолжить") draft.phone = value;
    await saveReg(id, "client", "client_birthday", draft);
    await send(chat, "🎂 Хотите получать поздравление с днём рождения и специальные сообщения от мастера?\n\nУкажите дату рождения в формате ДД.ММ.ГГГГ или нажмите «Пропустить». Это необязательно.");
    return;
  }
  const draft = state.draft || {};
  if (state.step === "client_birthday") {
    if (value.toLowerCase() !== "пропустить" && value !== "Продолжить") {
      const m = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (!m) { await send(chat, "Введите дату в формате ДД.ММ.ГГГГ или нажмите «Пропустить»."); return; }
      const d = new Date(Date.UTC(Number(m[3]), Number(m[2])-1, Number(m[1])));
      if (d.getUTCFullYear() !== Number(m[3]) || d.getUTCMonth() !== Number(m[2])-1 || d.getUTCDate() !== Number(m[1])) { await send(chat, "Похоже, дата указана неверно. Проверьте её или нажмите «Пропустить»."); return; }
      draft.date_of_birth = m[3] + "-" + m[2] + "-" + m[1];
    }
    await saveReg(id, "client", "client_confirm", draft);
    const masterLine = draft.preferred_studio_name ? "\nМастер: " + safe(draft.preferred_studio_name, 100) : "\nМастер: выберете в приложении";
    const phoneLine = draft.phone ? "\nТелефон: " + safe(draft.phone, 40) : "\nТелефон: не указан";
    const birthdayLine = draft.date_of_birth ? "\nДата рождения: " + draft.date_of_birth.split("-").reverse().join(".") : "\nДата рождения: не указана";
    await confirmKeyboard(chat, "🖤 ПРОВЕРЬТЕ ДАННЫЕ\n\nИмя: " + safe(draft.client_name) + masterLine + phoneLine + birthdayLine, "client_confirm");
    return;
  }
  if (state.step === "artist") {
    draft.artist_name = value;
    await saveReg(id, "master", "city", draft);
    await send(chat, "Регистрация мастера · 2/3\n\nВ каком городе вы работаете?");
    return;
  }
  if (state.step === "city") {
    draft.city = value;
    await saveReg(id, "master", "master_phone", draft);
    await askPhone(chat, "Город сохранён.\n\nРегистрация мастера · 3/3\nПоделитесь рабочим номером, чтобы клиенты могли связаться с вами по записи. Это необязательно — номер можно добавить позже.");
    return;
  }
  if (state.step === "studio") {
    // Finish an older in-progress registration without asking for a studio name.
    await saveReg(id, "master", "master_phone", draft);
    await askPhone(chat, "Название студии не требуется.\n\nУкажите рабочий номер телефона или нажмите «Пропустить». Это необязательно.");
    return;
  }
  if (state.step === "master_phone") {
    if (value.toLowerCase() !== "пропустить" && value !== "Продолжить") draft.phone = value;
    await saveReg(id, "master", "master_confirm", draft);
    const phoneLine = draft.phone ? "\nКонтакт: " + safe(draft.phone, 40) : "\nКонтакт: не указан";
    await confirmKeyboard(chat, "Проверьте данные вашего профиля мастера:\nИмя или псевдоним: " + safe(draft.artist_name) + "\nГород: " + safe(draft.city) + phoneLine, "master_confirm");
    return;
  }
}
async function handleVisitConfirmation(q: any, chat: number, telegramUserId: number, data: string) {
  const parts = data.split("|"), kind = parts[1], id = parts[2];
  if (!id || !["a","e"].includes(kind)) return;
  let masterId: number | null = null, clientTelegramId: number | null = null;
  let person = "Клиент", label = "", date = "", time = "";
  if (kind === "a") {
    const rows = await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&status=eq.confirmed&select=id,studio_id,client_telegram_user_id,client_name,project_type,requested_date,requested_time,studio:tm_studios(owner_telegram_user_id),client:tm_clients(telegram_user_id)");
    if (!rows.length) { await bot("answerCallbackQuery",{callback_query_id:q.id,text:"Запись не найдена или уже недоступна.",show_alert:true}); return; }
    const a=rows[0], c=Array.isArray(a.client)?a.client[0]:a.client, st=Array.isArray(a.studio)?a.studio[0]:a.studio;
    clientTelegramId=Number(a.client_telegram_user_id || c?.telegram_user_id || 0) || null;
    masterId=Number(st?.owner_telegram_user_id||0)||null;
    person=safe(a.client_name||"Клиент",120); label=safe(a.project_type||"Сеанс",80);
    date=String(a.requested_date||""); time=String(a.requested_time||"").slice(0,5);
  } else {
    const rows = await db("tm_calendar_events?id=eq."+encodeURIComponent(id)+"&event_type=in.(session,correction,consult,student,model)&select=id,studio_id,name,event_type,event_date,event_time,studio:tm_studios(owner_telegram_user_id),client:tm_clients(telegram_user_id)");
    if (!rows.length) { await bot("answerCallbackQuery",{callback_query_id:q.id,text:"Событие не найдено.",show_alert:true}); return; }
    const e=rows[0], c=Array.isArray(e.client)?e.client[0]:e.client, st=Array.isArray(e.studio)?e.studio[0]:e.studio;
    clientTelegramId=Number(c?.telegram_user_id||0)||null; masterId=Number(st?.owner_telegram_user_id||0)||null;
    person=safe(e.name||"Клиент",120);
    const labels:Record<string,string>={session:"Сеанс",correction:"Коррекция",consult:"Консультация",student:"Учёба",model:"Модель"};
    label=labels[e.event_type]||"Визит"; date=String(e.event_date||""); time=String(e.event_time||"").slice(0,5);
  }
  if (!clientTelegramId || clientTelegramId !== telegramUserId) {
    await bot("answerCallbackQuery",{callback_query_id:q.id,text:"Эта кнопка предназначена для клиента, которому отправлено напоминание.",show_alert:true}); return;
  }
  await bot("answerCallbackQuery",{callback_query_id:q.id,text:"Визит подтверждён!"});
  if (masterId) await send(masterId,"✅ Клиент подтвердил визит\n\n"+person+"\n"+label+"\nДата: "+date+" в "+time+"\n\nКлиент подтвердил запись через напоминание.");
  if (q.message?.message_id) await bot("editMessageReplyMarkup",{chat_id:chat,message_id:q.message.message_id,reply_markup:{inline_keyboard:[]}});
  await send(chat,"Спасибо! Ваш визит подтверждён. Мастер получил уведомление.");
}
async function onCallback(q: any) {
  const user = q.from;
  const chat = q.message?.chat?.id;
  if (!user || !chat) return;
  if (String(q.data||"").startsWith("vc|")) { await handleVisitConfirmation(q, Number(chat), Number(user.id), String(q.data)); return; }
  if (String(q.data||"").startsWith("vr|") || String(q.data||"").startsWith("vx|")) {
    const [action, kind, targetId] = String(q.data).split("|");
    if (!targetId || !["a","e"].includes(kind)) { await bot("answerCallbackQuery",{callback_query_id:q.id,text:"Действие недоступно.",show_alert:true}); return; }
    const rows = kind === "a"
      ? await db("tm_appointments?id=eq."+encodeURIComponent(targetId)+"&select=id,studio_id,status,client_telegram_user_id,client_name,requested_date,requested_time,studio:tm_studios(owner_telegram_user_id),client:tm_clients(telegram_user_id)")
      : await db("tm_calendar_events?id=eq."+encodeURIComponent(targetId)+"&select=id,studio_id,name,event_date,event_time,event_type,studio:tm_studios(owner_telegram_user_id),client:tm_clients(telegram_user_id)");
    if (!rows.length) { await bot("answerCallbackQuery",{callback_query_id:q.id,text:"Визит не найден.",show_alert:true}); return; }
    const item=rows[0], studio=Array.isArray(item.studio)?item.studio[0]:item.studio, linked=Array.isArray(item.client)?item.client[0]:item.client;
    const clientId=Number(item.client_telegram_user_id||linked?.telegram_user_id||0);
    if (!clientId || clientId!==Number(user.id)) { await bot("answerCallbackQuery",{callback_query_id:q.id,text:"Это действие доступно только клиенту из записи.",show_alert:true}); return; }
    const masterId=Number(studio?.owner_telegram_user_id||0);
    if (action==="vx" && kind==="a") {
      if (item.status!=="confirmed") { await bot("answerCallbackQuery",{callback_query_id:q.id,text:"Эту запись уже нельзя отменить через напоминание.",show_alert:true}); return; }
      const changed=await db("tm_appointments?id=eq."+encodeURIComponent(targetId)+"&status=eq.confirmed","PATCH",{status:"cancelled",updated_at:new Date().toISOString()});
      if (!changed.length) { await bot("answerCallbackQuery",{callback_query_id:q.id,text:"Не удалось отменить запись.",show_alert:true}); return; }
      if (masterId) await send(masterId,"❌ КЛИЕНТ ОТМЕНИЛ СЕАНС\n\n"+safe(item.client_name||"Клиент",100)+"\n"+String(item.requested_date)+" в "+String(item.requested_time).slice(0,5));
      await bot("answerCallbackQuery",{callback_query_id:q.id,text:"Запись отменена."});
      await send(chat,"❌ Запись отменена. Мастер получил уведомление.");
      if (q.message?.message_id) await bot("editMessageReplyMarkup",{chat_id:chat,message_id:q.message.message_id,reply_markup:{inline_keyboard:[]}});
      return;
    }
    await saveReg(Number(user.id),"client",action==="vr"?"visit_reschedule":"visit_cancel_request",{master_id:masterId,target_id:targetId,kind,client_name:safe(item.client_name||item.name||"Клиент",100),date:String(item.requested_date||item.event_date||""),time:String(item.requested_time||item.event_time||"").slice(0,5)});
    await bot("answerCallbackQuery",{callback_query_id:q.id});
    await send(chat,action==="vr"?"🕒 Напишите, на какую дату и время вам удобнее перенести визит. Мастер получит ваше сообщение.":"✉️ Напишите коротко, почему не сможете прийти. Мастер получит запрос на отмену и свяжется с вами.");
    return;
  }
  if (String(q.data||"").startsWith("review|")) {
    const queueId=String(q.data).split("|")[1]||"";
    const rows=await db("tm_client_message_queue?id=eq."+encodeURIComponent(queueId)+"&message_type=eq.review&sent_at=not.is.null&telegram_user_id=eq."+Number(user.id)+"&select=id,studio_id");
    if (!rows.length) { await bot("answerCallbackQuery",{callback_query_id:q.id,text:"Ссылка на отзыв недоступна.",show_alert:true}); return; }
    const st=await db("tm_studios?id=eq."+rows[0].studio_id+"&select=owner_telegram_user_id");
    await saveReg(Number(user.id),"client","review_feedback",{master_id:Number(st?.[0]?.owner_telegram_user_id||0),queue_id:queueId});
    await bot("answerCallbackQuery",{callback_query_id:q.id});
    await send(chat,"⭐ Буду рад вашему отзыву! Напишите пару слов о впечатлениях от сеанса. Я передам сообщение мастеру.");
    return;
  }
  await bot("answerCallbackQuery", { callback_query_id: q.id });
  if (q.data === "birthday_set") {
    await saveReg(Number(user.id),"client","birthday_update",{});
    await send(chat,"🎂 УКАЖИТЕ ДАТУ РОЖДЕНИЯ\\n\\nФормат: ДД.ММ.ГГГГ. Это необязательно — дата нужна только для поздравления от мастера.");
  } else if (q.data === "choose_role") await chooseRole(chat);
  else if (q.data === "role_master") await startRole(chat, Number(user.id), "master");
  else if (q.data === "role_client") await startRole(chat, Number(user.id), "client");
  else if (q.data === "client_confirm" || q.data === "master_confirm") {
    const state = await reg(Number(user.id));
    if (!state) { await cabinetMenu(chat, Number(user.id)); return; }
    if (q.data === "client_confirm" && state.role === "client" && state.step === "client_confirm") await finishClient(chat, Number(user.id), state.draft || {});
    else if (q.data === "master_confirm" && state.role === "master" && state.step === "master_confirm") await finishMaster(chat, Number(user.id), state.draft || {});
  } else if (q.data === "registration_cancel") {
    await clearReg(Number(user.id));
    await bot("sendMessage", { chat_id: chat, text: "Регистрация отменена. Вы можете начать заново командой /start.", reply_markup: { remove_keyboard: true } });
  }
}
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("setup") === "1") {
    try {
      const existing = await db("tm_bot_settings?setting_key=eq.webhook_secret&select=setting_value");
      if (existing.length) return reply({ ok: true, already_configured: true });
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      await db("tm_bot_settings", "POST", [{ setting_key: "webhook_secret", setting_value: secret }]);
      const result = await bot("setWebhook", {
        url: base + "/functions/v1/tattoo-manager-bot?hook=" + secret,
        secret_token: secret,
        allowed_updates: ["message", "callback_query"],
      });
      return reply({ ok: true, webhook_configured: result === true });
    } catch (e) {
      return reply({ ok: false, error: e instanceof Error ? e.message : "SETUP_FAILED" }, 500);
    }
  }
  if (req.method === "GET") return reply({ ok: true, service: "tattoo-manager-bot" });
  if (req.method !== "POST") return reply({ error: "METHOD_NOT_ALLOWED" }, 405);
  const saved = await db("tm_bot_settings?setting_key=eq.webhook_secret&select=setting_value");
  const secret = saved[0]?.setting_value;
  if (!secret || url.searchParams.get("hook") !== secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return reply({ error: "UNAUTHORIZED" }, 401);
  }
  try {
    const update = await req.json();
    if (update.callback_query) {
      await onCallback(update.callback_query);
    } else if (update.message?.from && update.message?.chat?.id) {
      await profile(update.message.from);
      const state = await reg(Number(update.message.from.id));
      if (update.message.contact && state && ["client_phone", "master_phone"].includes(state.step)) {
        const contact = update.message.contact;
        if (contact.user_id && Number(contact.user_id) !== Number(update.message.from.id)) {
          await send(update.message.chat.id, "Пожалуйста, отправьте именно свой контакт или нажмите «Пропустить».");
        } else {
          const draft = state.draft || {};
          draft.phone = safe(contact.phone_number, 40);
          await saveReg(Number(update.message.from.id), state.role, state.step, draft);
          await onText(update.message.chat.id, update.message.from, "Продолжить");
        }
      } else {
        await onText(update.message.chat.id, update.message.from, String(update.message.text || ""));
      }
    }
    return reply({ ok: true });
  } catch (e) {
    console.error("BOT_UPDATE_ERROR", e);
    return reply({ ok: false });
  }
});
