import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.5";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"content-type, x-telegram-init-data, x-tm-role, x-tm-skip-photos","Access-Control-Allow-Methods":"GET, POST, PATCH, DELETE, OPTIONS"};
function out(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json"}})}
async function telegramUser(initData:string){
 const token=Deno.env.get("TELEGRAM_BOT_TOKEN");if(!token)throw new Error("TELEGRAM_BOT_TOKEN_NOT_CONFIGURED");
 const p=new URLSearchParams(initData);const hash=p.get("hash");if(!hash)throw new Error("INVALID_TELEGRAM_INIT_DATA");p.delete("hash");
 const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+"="+v).join("\n");const enc=new TextEncoder();
 const webAppKey=await crypto.subtle.importKey("raw",enc.encode("WebAppData"),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const secret=await crypto.subtle.sign("HMAC",webAppKey,enc.encode(token));
 const key=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const digest=new Uint8Array(await crypto.subtle.sign("HMAC",key,enc.encode(check)));
 const actual=[...digest].map(b=>b.toString(16).padStart(2,"0")).join("");
 if(actual!==hash)throw new Error("INVALID_TELEGRAM_SIGNATURE");
 const authDate=Number(p.get("auth_date")||0);if(!authDate||Math.abs(Date.now()/1000-authDate)>86400)throw new Error("TELEGRAM_INIT_DATA_EXPIRED");
 const raw=p.get("user");if(!raw)throw new Error("TELEGRAM_USER_MISSING");return JSON.parse(raw) as {id:number;first_name?:string;username?:string};
}
const base=Deno.env.get("SUPABASE_URL")!,key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
let directSql:ReturnType<typeof postgres>|null=null;function pg(){if(!directSql){const url=Deno.env.get("DATABASE_URL");if(!url)throw new Error("DATABASE_URL_MISSING");directSql=postgres(url,{ssl:"require",max:2,idle_timeout:10,connect_timeout:10});}return directSql;}
const MASTER_APP_URL="https://inkpeople.github.io/tattoo-manager-v2/?v=89";const CLIENT_APP_URL="https://inkpeople.github.io/tattoo-manager-v2/client.html?v=75";

async function decryptVkToken(ciphertext:string){
 const raw=Deno.env.get("SOCIAL_TOKEN_ENCRYPTION_KEY");if(!raw)throw new Error("SOCIAL_TOKEN_ENCRYPTION_KEY_NOT_CONFIGURED");
 const bytes=Uint8Array.from(atob(raw),c=>c.charCodeAt(0));if(bytes.length!==32)throw new Error("SOCIAL_TOKEN_ENCRYPTION_KEY_INVALID");
 const k=await crypto.subtle.importKey("raw",bytes,"AES-GCM",false,["decrypt"]);const packed=Uint8Array.from(atob(ciphertext),c=>c.charCodeAt(0));
 const clear=await crypto.subtle.decrypt({name:"AES-GCM",iv:packed.slice(0,12)},k,packed.slice(12));return new TextDecoder().decode(clear);
}
async function notifyClient(studioId:string,clientId:string|null,telegramId:number|null|undefined,text:string){
 if(!clientId)return false;
 const clients=await db("tm_clients?id=eq."+encodeURIComponent(clientId)+"&studio_id=eq."+encodeURIComponent(studioId)+"&select=telegram_user_id,vk_user_id,preferred_notification_channel,notifications_enabled");
 const c=clients?.[0];if(!c||c.notifications_enabled!==true)return false;
 const channel=String(c.preferred_notification_channel||"telegram");
 if(channel==="vk"){
  if(!c.vk_user_id)throw new Error("VK_CLIENT_ID_MISSING");
  const rows=await pg()`select access_token_ciphertext from private.tm_social_vk_communities where studio_id=${studioId}::uuid and status=${"connected"} order by created_at desc limit 1`;
  if(!rows?.length)throw new Error("VK_COMMUNITY_NOT_CONNECTED");
  const token=await decryptVkToken(String(rows[0].access_token_ciphertext));
  const params=new URLSearchParams({peer_id:String(c.vk_user_id),random_id:String(crypto.getRandomValues(new Uint32Array(1))[0]),message:text,access_token:token,v:"5.199"});
  const response=await fetch("https://api.vk.com/method/messages.send?"+params.toString());const result=await response.json().catch(()=>({}));
  if(!response.ok||result.error)throw new Error("VK_SEND_FAILED:"+(result.error?.error_msg||response.status));
  return true;
 }
 if(channel==="telegram"){
  const chat=Number(c.telegram_user_id||telegramId||0);if(!chat)throw new Error("TELEGRAM_CLIENT_ID_MISSING");
  return await notifyTelegram(chat,text,"client");
 }
 if(channel==="none")return false;
 throw new Error("CLIENT_NOTIFICATION_CHANNEL_INVALID");
}
async function notifyTelegram(chatId:number|string|null|undefined,text:string,recipientRole?:"master"|"client"){const token=Deno.env.get("TELEGRAM_BOT_TOKEN")||"";if(!token||!chatId)return false;try{let role=recipientRole;if(!role){const owners=await db("tm_studios?owner_telegram_user_id=eq."+encodeURIComponent(String(chatId))+"&select=id");role=owners?.length?"master":"client";}const url=role==="master"?MASTER_APP_URL:CLIENT_APP_URL;const button=role==="master"?"Открыть кабинет мастера":"Открыть личный кабинет";const r=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:text.replace(/\\r\\n/g,"\n").replace(/\\n/g,"\n").replace(/\\r/g,"\n"),disable_web_page_preview:true,reply_markup:{inline_keyboard:[[{text:button,web_app:{url}}]]}})});const j=await r.json();if(!j?.ok)console.warn("TELEGRAM_NOTIFY_REJECTED",j?.description||"unknown");return !!j?.ok;}catch(err){console.error("TELEGRAM_NOTIFY_FAILED",err);return false;}}
const telegramPhotoCache=new Map<number,{expiresAt:number,value:string|null}>();
async function cachedTelegramPhoto(userId:number,token:string):Promise<string|null>{const cached=telegramPhotoCache.get(userId);if(cached&&cached.expiresAt>Date.now())return cached.value;const value=await telegramPhoto(userId,token);telegramPhotoCache.set(userId,{expiresAt:Date.now()+12*60*60*1000,value});return value;}
async function telegramPhoto(userId:number,token:string):Promise<string|null>{try{const pr=await fetch("https://api.telegram.org/bot"+token+"/getUserProfilePhotos?user_id="+userId+"&limit=1");if(!pr.ok)return null;const pj=await pr.json();const sizes=pj?.result?.photos?.[0];if(!pj.ok||!sizes?.length)return null;const best=sizes[sizes.length-1];const fr=await fetch("https://api.telegram.org/bot"+token+"/getFile?file_id="+encodeURIComponent(best.file_id));const fj=await fr.json();const filePath=fj?.result?.file_path;if(!fj.ok||!filePath)return null;const imageResponse=await fetch("https://api.telegram.org/file/bot"+token+"/"+filePath);if(!imageResponse.ok)return null;const bytes=new Uint8Array(await imageResponse.arrayBuffer());if(bytes.length>500000)return null;let binary="";for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));const mime=imageResponse.headers.get("content-type")||"image/jpeg";return "data:"+mime+";base64,"+btoa(binary)}catch{return null}}
async function storageRequest(path:string,init:RequestInit={}){const r=await fetch(base+"/storage/v1/"+path,{...init,headers:{apikey:key,Authorization:"Bearer "+key,...(init.headers||{})}});const t=await r.text();if(!r.ok)throw new Error("STORAGE_ERROR_"+r.status+": "+t);return t?JSON.parse(t):null}
async function masterPortfolio(studioId:string){
 const rows=await storageRequest("object/list/tm-master-portfolio",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prefix:studioId,limit:20,offset:0,sortBy:{column:"created_at",order:"desc"}})});
 const files=(Array.isArray(rows)?rows:[]).filter((x:any)=>x&&x.name&&x.id);
 const result=[];
 for(const file of files){
  const path=String(file.name).includes("/")?String(file.name):studioId+"/"+String(file.name);
  const signedUrl=await cachedSignedUrl("tm-master-portfolio",path);
  result.push({path,url:signedUrl,created_at:file.created_at||null});
 }
 return result;
}

const signedObjectUrlCache=new Map<string,{expiresAt:number,url:string}>();
async function cachedSignedUrl(bucket:string,path:string):Promise<string>{const cacheKey=bucket+":"+path;const cached=signedObjectUrlCache.get(cacheKey);if(cached&&cached.expiresAt>Date.now()+60_000)return cached.url;const encoded=path.split("/").map(encodeURIComponent).join("/");const signed=await storageRequest("object/sign/"+bucket+"/"+encoded,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expiresIn:3600})});const signedPath=String(signed?.signedURL||signed?.signedUrl||"");if(!signedPath)throw new Error("STORAGE_SIGNED_URL_MISSING");const url=signedPath.startsWith("http")?signedPath:base+"/storage/v1"+(signedPath.startsWith("/")?signedPath:"/"+signedPath);signedObjectUrlCache.set(cacheKey,{expiresAt:Date.now()+50*60*1000,url});return url;}
async function db(path:string,init:RequestInit={}){const r=await fetch(base+"/rest/v1/"+path,{...init,headers:{apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json",Prefer:"return=representation",...(init.headers||{})}});const t=await r.text();if(!r.ok)throw new Error("DATABASE_ERROR_"+r.status+": "+t);return t?JSON.parse(t):null}
async function scheduleConflictsServer(studioId:string,date:string,time:string,duration:number,excludeId?:string){
 const start=Number(time.slice(0,2))*60+Number(time.slice(3,5)),end=start+duration,issues:string[]=[];
 const appointments=await db("tm_appointments?studio_id=eq."+encodeURIComponent(studioId)+"&requested_date=eq."+encodeURIComponent(date)+"&status=not.in.(cancelled,declined)&select=id,client_name,requested_time,duration_minutes");
 for(const a of appointments||[]){if(excludeId&&String(a.id)===excludeId)continue;const t=String(a.requested_time||"").slice(0,5);if(!/^\d{2}:\d{2}$/.test(t))continue;const otherStart=Number(t.slice(0,2))*60+Number(t.slice(3,5)),otherEnd=otherStart+(Number(a.duration_minutes)||120),overlap=start<otherEnd&&end>otherStart,gap=overlap?0:Math.min(Math.abs(start-otherEnd),Math.abs(otherStart-end));if(overlap)issues.push("Пересечение с записью «"+(a.client_name||"Клиент")+"» ("+t+"–"+String(Math.floor(otherEnd/60)%24).padStart(2,"0")+":"+String(otherEnd%60).padStart(2,"0")+")");else if(gap<30)issues.push("Перерыв до/после записи «"+(a.client_name||"Клиент")+"» менее 30 минут");}
 const events=await db("tm_calendar_events?studio_id=eq."+encodeURIComponent(studioId)+"&event_date=eq."+encodeURIComponent(date)+"&select=event_time,event_type,name");
 for(const e of events||[]){if(!e.event_time){issues.push("Весь день занято событием «"+(e.name||e.event_type||"календаря")+"»");continue;}const t=String(e.event_time).slice(0,5);if(!/^\d{2}:\d{2}$/.test(t))continue;const point=Number(t.slice(0,2))*60+Number(t.slice(3,5));if(point>=start-30&&point<=end+30)issues.push("Рядом по времени событие «"+(e.name||e.event_type||"календаря")+"» в "+t);}
 return issues;
}
Deno.serve(async req=>{if(req.method==="OPTIONS")return new Response("ok",{headers:cors});try{
 const user=await telegramUser(req.headers.get("x-telegram-init-data")||"");
 if(req.method==="POST"){
  const b=await req.json();
  if(b.action==="get_social_connections"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=String(own[0].id);
   const rows=await db("tm_social_connections?studio_id=eq."+encodeURIComponent(studioId)+"&select=provider,status,account_name,connected_at,last_checked_at,last_error,granted_scopes&order=provider.asc");
   return out({ok:true,connections:rows||[]});
  }
  if(b.action==="get_client_referral_link"){
   if(req.headers.get("x-tm-role")!=="client")return out({error:"CLIENT_ROLE_REQUIRED"},403);
   const studioId=String(b.studio_id||"");if(!studioId)return out({error:"STUDIO_REQUIRED"},400);
   const studios=await db("tm_studios?id=eq."+encodeURIComponent(studioId)+"&public_booking_enabled=eq.true&select=id,slug,artist_name");
   if(!studios?.length)return out({error:"STUDIO_NOT_FOUND"},404);
   let client=await db("tm_clients?studio_id=eq."+encodeURIComponent(studioId)+"&telegram_user_id=eq."+user.id+"&select=id,full_name,telegram_user_id,referral_code");
   if(!client?.length){
    const profile=await db("tm_user_profiles?telegram_user_id=eq."+user.id+"&select=full_name,first_name,last_name");
    const fullName=profile?.[0]?.full_name||[profile?.[0]?.first_name,profile?.[0]?.last_name].filter(Boolean).join(" ")||user.first_name||"Клиент";
    client=await db("tm_clients",{method:"POST",body:JSON.stringify([{studio_id:studioId,telegram_user_id:user.id,full_name:String(fullName).slice(0,120),description:""}])});
   }
   let code=String(client?.[0]?.referral_code||"");
   if(!code){
    const bytes=new Uint8Array(6);crypto.getRandomValues(bytes);code=[...bytes].map(x=>x.toString(16).padStart(2,"0")).join("").toUpperCase();
    const updated=await db("tm_clients?id=eq."+encodeURIComponent(client[0].id)+"&studio_id=eq."+encodeURIComponent(studioId)+"&referral_code=is.null",{method:"PATCH",body:JSON.stringify({referral_code:code,updated_at:new Date().toISOString()})});
    if(updated?.[0]?.referral_code)code=updated[0].referral_code;
    else {const fresh=await db("tm_clients?id=eq."+encodeURIComponent(client[0].id)+"&select=referral_code");code=String(fresh?.[0]?.referral_code||"");}
   }
   if(!code)return out({error:"REFERRAL_CODE_CREATE_FAILED"},500);
   const link="https://t.me/TattooManagerAppBot?start=studio_"+studios[0].slug+"_ref_"+code;
   return out({ok:true,link,code,discount_amount:3000});
  }
  if(b.action==="award_referral_reward"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=String(own[0].id),referralId=String(b.referral_id||""),amount=Number(b.amount);
   if(!referralId)return out({error:"REFERRAL_ID_REQUIRED"},400);
   if(!Number.isFinite(amount)||amount<=0||amount>100000000)return out({error:"INVALID_REWARD_AMOUNT"},400);
   const pending=await db("tm_referrals?id=eq."+encodeURIComponent(referralId)+"&studio_id=eq."+encodeURIComponent(studioId)+"&status=eq.pending&select=id,referrer_client_id,referrer_telegram_user_id,referred_client_id,referred_telegram_user_id,reward_amount");
   if(!pending?.length)return out({error:"REFERRAL_NOT_PENDING"},409);
   const referral=pending[0];
   const inviter=await db("tm_clients?id=eq."+encodeURIComponent(String(referral.referrer_client_id))+"&studio_id=eq."+encodeURIComponent(studioId)+"&select=id,full_name,telegram_user_id");
   if(!inviter?.length)return out({error:"REFERRER_NOT_FOUND"},404);
   const updated=await db("tm_referrals?id=eq."+encodeURIComponent(referralId)+"&studio_id=eq."+encodeURIComponent(studioId)+"&status=eq.pending",{method:"PATCH",body:JSON.stringify({status:"earned",reward_amount:amount,earned_at:new Date().toISOString()})});
   if(!updated?.length)return out({error:"REFERRAL_ALREADY_PROCESSED"},409);
   const earned=await db("tm_referrals?studio_id=eq."+encodeURIComponent(studioId)+"&referrer_client_id=eq."+encodeURIComponent(String(referral.referrer_client_id))+"&status=eq.earned&select=reward_amount");
   const transactions=await db("tm_referral_transactions?studio_id=eq."+encodeURIComponent(studioId)+"&client_id=eq."+encodeURIComponent(String(referral.referrer_client_id))+"&select=amount,transaction_type");
   const balance=Math.max(0,(earned||[]).reduce((sum:number,x:any)=>sum+Number(x.reward_amount||0),0)+(transactions||[]).filter((x:any)=>x.transaction_type==="credited").reduce((sum:number,x:any)=>sum+Number(x.amount||0),0)-(transactions||[]).filter((x:any)=>x.transaction_type==="redeemed").reduce((sum:number,x:any)=>sum+Number(x.amount||0),0));
   if(referral.referrer_telegram_user_id)await notifyTelegram(Number(referral.referrer_telegram_user_id),"🎁 Вам начислены реферальные баллы за приглашённого клиента: "+Math.round(amount).toLocaleString("ru-RU")+" ₽. Текущий баланс: "+Math.round(balance).toLocaleString("ru-RU")+" ₽.","client");
   return out({ok:true,credited_amount:amount,balance});
  }
  if(b.action==="credit_referral_balance"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=String(own[0].id),clientId=String(b.client_id||""),amount=Number(b.amount),note=String(b.note||"Начисление мастером").trim().slice(0,180);
   if(!clientId)return out({error:"CLIENT_ID_REQUIRED"},400);
   if(!Number.isFinite(amount)||amount<=0||amount>100000000)return out({error:"INVALID_CREDIT_AMOUNT"},400);
   const client=await db("tm_clients?id=eq."+encodeURIComponent(clientId)+"&studio_id=eq."+encodeURIComponent(studioId)+"&select=id,telegram_user_id,full_name");
   if(!client?.length)return out({error:"CLIENT_NOT_FOUND"},404);
   const rows=await db("tm_referral_transactions",{method:"POST",body:JSON.stringify([{studio_id:studioId,client_id:clientId,transaction_type:"credited",amount,note}])});
   if(!rows?.length)return out({error:"CREDIT_FAILED"},500);
   const earned=await db("tm_referrals?studio_id=eq."+encodeURIComponent(studioId)+"&referrer_client_id=eq."+encodeURIComponent(clientId)+"&status=eq.earned&select=reward_amount");
   const transactions=await db("tm_referral_transactions?studio_id=eq."+encodeURIComponent(studioId)+"&client_id=eq."+encodeURIComponent(clientId)+"&select=amount,transaction_type");
   const balance=Math.max(0,(earned||[]).reduce((sum:number,x:any)=>sum+Number(x.reward_amount||0),0)+(transactions||[]).filter((x:any)=>x.transaction_type==="credited").reduce((sum:number,x:any)=>sum+Number(x.amount||0),0)-(transactions||[]).filter((x:any)=>x.transaction_type==="redeemed").reduce((sum:number,x:any)=>sum+Number(x.amount||0),0));
   if(client[0].telegram_user_id)await notifyTelegram(Number(client[0].telegram_user_id),"🎁 Вам начислены бонусы мастером: "+Math.round(amount).toLocaleString("ru-RU")+" ₽. Причина: "+(note||"не указана")+". Текущий баланс: "+Math.round(balance).toLocaleString("ru-RU")+" ₽.","client");
   return out({ok:true,credited_amount:amount,balance});
  }
  if(b.action==="redeem_referral_discount"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=String(own[0].id),clientId=String(b.client_id||"");
   if(!clientId)return out({error:"CLIENT_ID_REQUIRED"},400);
   const client=await db("tm_clients?id=eq."+encodeURIComponent(clientId)+"&studio_id=eq."+encodeURIComponent(studioId)+"&select=id,telegram_user_id,full_name");
   if(!client?.length)return out({error:"CLIENT_NOT_FOUND"},404);
   const amount=Number(b.amount);
   if(!Number.isFinite(amount)||amount<=0||amount>100000000)return out({error:"INVALID_REDEMPTION_AMOUNT"},400);
   const result=await db("rpc/tm_redeem_referral_balance",{method:"POST",body:JSON.stringify({p_studio_id:studioId,p_client_id:clientId,p_amount:amount})});
   const balance=Number(result?.balance)||0;
   if(client[0].telegram_user_id)await notifyTelegram(Number(client[0].telegram_user_id),"🎁 Мастер списал с вашего реферального баланса: "+Math.round(amount).toLocaleString("ru-RU")+" ₽. Остаток: "+Math.round(balance).toLocaleString("ru-RU")+" ₽.","client");
   return out({ok:true,redeemed_amount:amount,balance});
  }
  if(["search_masters","find_masters_by_contacts","list_master_friends","send_master_friend_request","list_master_chats","get_master_chat","send_master_message","respond_master_friend_request","remove_master_friend","get_master_public_profile","get_my_master_portfolio","add_master_portfolio_photo","delete_master_portfolio_photo"].includes(String(b.action||""))){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=String(own[0].id);
   const profile=async(id:string)=>{const rows=await db("tm_studios?id=eq."+encodeURIComponent(id)+"&select=id,artist_name,studio_name,city");return rows?.[0]||null;};
   const profileList=async(ids:string[])=>{const unique=[...new Set(ids.filter(Boolean))];if(!unique.length)return [];const rows=await db("tm_studios?id=in.("+unique.map(encodeURIComponent).join(",")+")&select=id,artist_name,studio_name,city");return rows||[];};
   const relationRows=await db("tm_master_friendships?or=(studio_low_id.eq."+studioId+",studio_high_id.eq."+studioId+")&select=id,studio_low_id,studio_high_id,requested_by_studio_id,status,created_at&order=created_at.desc");
   const relations=relationRows||[];
   const otherId=(r:any)=>String(r.studio_low_id)===studioId?String(r.studio_high_id):String(r.studio_low_id);
   const pack=async(r:any)=>{const p=await profile(otherId(r));return p?{...p,friendship_id:r.id,status:r.status,requested_by_studio_id:r.requested_by_studio_id}:null;};
   if(b.action==="get_master_public_profile"){
    const target=String(b.studio_id||"");
    if(!/^[0-9a-f-]{36}$/i.test(target)||target===studioId)return out({error:"INVALID_MASTER"},400);
    const rows=await db("tm_studios?id=eq."+encodeURIComponent(target)+"&select=id,artist_name,studio_name,city,slug,public_booking_enabled");
    if(!rows?.length)return out({error:"MASTER_NOT_FOUND"},404);
    const studio=rows[0];
    const users=studio.owner_telegram_user_id?await db("tm_user_profiles?telegram_user_id=eq."+encodeURIComponent(String(studio.owner_telegram_user_id))+"&select=username,full_name,first_name,last_name"): [];
    const p=users?.[0]||{};
    const relation=relations.find((x:any)=>String(x.studio_low_id)===target||String(x.studio_high_id)===target);
    const portfolio=await masterPortfolio(target);
    return out({ok:true,master:{id:studio.id,artist_name:studio.artist_name,studio_name:studio.studio_name,city:studio.city,slug:studio.slug,public_booking_enabled:studio.public_booking_enabled,username:p.username||null,full_name:p.full_name||[p.first_name,p.last_name].filter(Boolean).join(" ")||null,friendship_id:relation?.id||null,friendship_status:relation?.status||"none",requested_by_studio_id:relation?.requested_by_studio_id||null,portfolio}});
   }
   if(b.action==="get_my_master_portfolio"){
    return out({ok:true,portfolio:await masterPortfolio(studioId)});
   }
   if(b.action==="add_master_portfolio_photo"){
    const existing=await masterPortfolio(studioId);
    if(existing.length>=12)return out({error:"PORTFOLIO_LIMIT_REACHED"},409);
    const encoded=String(b.image_base64||"");
    const match=encoded.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if(!match)return out({error:"INVALID_IMAGE_FORMAT"},400);
    const binary=atob(match[2]);
    if(binary.length>8*1024*1024)return out({error:"IMAGE_TOO_LARGE"},413);
    const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    const extension=match[1]==="image/png"?"png":match[1]==="image/webp"?"webp":"jpg";
    const path=studioId+"/"+crypto.randomUUID()+"."+extension;
    await storageRequest("object/tm-master-portfolio/"+path.split("/").map(encodeURIComponent).join("/"),{method:"POST",headers:{"Content-Type":match[1],"x-upsert":"false"},body:bytes});
    return out({ok:true,portfolio:await masterPortfolio(studioId)});
   }
   if(b.action==="delete_master_portfolio_photo"){
    const path=String(b.path||"");
    if(!path.startsWith(studioId+"/")||path.includes(".."))return out({error:"PORTFOLIO_FILE_NOT_OWNED"},403);
    await storageRequest("object/tm-master-portfolio",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({prefixes:[path]})});
    return out({ok:true,portfolio:await masterPortfolio(studioId)});
   }
   if(b.action==="list_master_friends"){
    const accepted=await Promise.all(relations.filter((r:any)=>r.status==="accepted").map(pack));
    const incoming=await Promise.all(relations.filter((r:any)=>r.status==="pending"&&String(r.requested_by_studio_id)!==studioId).map(pack));
    const outgoing=await Promise.all(relations.filter((r:any)=>r.status==="pending"&&String(r.requested_by_studio_id)===studioId).map(pack));
    return out({ok:true,friends:accepted.filter(Boolean),incoming:incoming.filter(Boolean),outgoing:outgoing.filter(Boolean)});
   }
   if(b.action==="list_master_chats"){
    const accepted=relations.filter((r:any)=>r.status==="accepted");
    const chats=await Promise.all(accepted.map(async(r:any)=>{
     const friend=await profile(otherId(r));if(!friend)return null;
     const latest=await db("tm_master_messages?friendship_id=eq."+encodeURIComponent(String(r.id))+"&select=id,sender_studio_id,recipient_studio_id,body,created_at,read_at&order=created_at.desc&limit=1");
     const unread=await db("tm_master_messages?friendship_id=eq."+encodeURIComponent(String(r.id))+"&recipient_studio_id=eq."+encodeURIComponent(studioId)+"&read_at=is.null&select=id&limit=1000");
     return {...friend,friendship_id:r.id,last_message:latest?.[0]||null,unread_count:(unread||[]).length};
    }));
    return out({ok:true,chats:chats.filter(Boolean).sort((x:any,y:any)=>String(y.last_message?.created_at||"").localeCompare(String(x.last_message?.created_at||"")))});
   }
   if(b.action==="get_master_chat"){
    const friendshipId=String(b.friendship_id||"");
    if(!/^[0-9a-f-]{36}$/i.test(friendshipId))return out({error:"INVALID_FRIENDSHIP"},400);
    const relation=relations.find((r:any)=>String(r.id)===friendshipId&&r.status==="accepted");
    if(!relation)return out({error:"CHAT_NOT_AVAILABLE"},403);
    const friendId=otherId(relation),friend=await profile(friendId);
    if(!friend)return out({error:"MASTER_NOT_FOUND"},404);
    const after=String(b.after_created_at||"");
    let messages:any[]=[];
    if(after&&Number.isFinite(Date.parse(after))){
     messages=await db("tm_master_messages?friendship_id=eq."+encodeURIComponent(friendshipId)+"&created_at=gt."+encodeURIComponent(after)+"&select=id,sender_studio_id,recipient_studio_id,body,created_at,read_at&order=created_at.asc&limit=100")||[];
    }else{
     const recent=await db("tm_master_messages?friendship_id=eq."+encodeURIComponent(friendshipId)+"&select=id,sender_studio_id,recipient_studio_id,body,created_at,read_at&order=created_at.desc&limit=200");
     messages=(recent||[]).reverse();
    }
    if(messages.length)await db("tm_master_messages?friendship_id=eq."+encodeURIComponent(friendshipId)+"&recipient_studio_id=eq."+encodeURIComponent(studioId)+"&read_at=is.null",{method:"PATCH",body:JSON.stringify({read_at:new Date().toISOString()})});
    return out({ok:true,friend,friendship_id:friendshipId,messages,server_time:new Date().toISOString()});
   }
   if(b.action==="send_master_message"){
    const friendshipId=String(b.friendship_id||""),body=String(b.body||"").trim();
    if(!/^[0-9a-f-]{36}$/i.test(friendshipId))return out({error:"INVALID_FRIENDSHIP"},400);
    if(!body||body.length>4000)return out({error:"MESSAGE_LENGTH_INVALID"},400);
    const relation=relations.find((r:any)=>String(r.id)===friendshipId&&r.status==="accepted");
    if(!relation)return out({error:"CHAT_NOT_AVAILABLE"},403);
    const recipientStudioId=otherId(relation);
    const inserted=await db("tm_master_messages",{method:"POST",body:JSON.stringify([{friendship_id:friendshipId,sender_studio_id:studioId,recipient_studio_id:recipientStudioId,body}])});
    const recipient=await db("tm_studios?id=eq."+encodeURIComponent(recipientStudioId)+"&select=owner_telegram_user_id");
    const sender=await profile(studioId);
    const recipientTelegramId=recipient?.[0]?.owner_telegram_user_id;
    if(recipientTelegramId){
     const preview=body.length>700?body.slice(0,697)+"…":body;
     await notifyTelegram(String(recipientTelegramId),"💬 Новое сообщение от мастера «"+(sender?.artist_name||sender?.studio_name||"Мастер")+"»:\n\n"+preview,"master");
    }
    return out({ok:true,message:inserted?.[0]||null});
   }
   if(b.action==="find_masters_by_contacts"){
    const raw=Array.isArray(b.contacts)?b.contacts.slice(0,100):[];
    const normalizePhone=(value:string)=>{
     let digits=String(value||"").replace(/\D/g,"");
     if(digits.length===11&&digits.startsWith("8"))digits="7"+digits.slice(1);
     if(digits.length===10)digits="7"+digits;
     return digits.length>=10&&digits.length<=15?digits:"";
    };
    const wanted=new Map<string,string>();
    for(const c of raw){const phone=normalizePhone(String(c?.tel||""));if(phone&&!wanted.has(phone))wanted.set(phone,String(c?.name||"").trim().slice(0,120));}
    if(!wanted.size)return out({ok:true,masters:[]});
    const suffixes=[...new Set([...wanted.keys()].map(x=>x.slice(-7)))];
    const profileRows:any[]=[];
    for(let i=0;i<suffixes.length;i+=20){
     const batch=suffixes.slice(i,i+20);
     const filters=batch.map(x=>"phone.ilike.*"+x+"*").join(",");
     const rows=await db("tm_user_profiles?or=("+filters+")&select=telegram_user_id,phone&limit=500");
     profileRows.push(...(rows||[]));
    }
    const matches=new Map<string,string>();
    for(const p of profileRows){
     const normalized=normalizePhone(String(p.phone||""));
     if(normalized&&wanted.has(normalized))matches.set(String(p.telegram_user_id),wanted.get(normalized)||"");
    }
    const ownerIds=[...matches.keys()].filter(Boolean);
    if(!ownerIds.length)return out({ok:true,masters:[]});
    const studios=await db("tm_studios?owner_telegram_user_id=in.("+ownerIds.map(encodeURIComponent).join(",")+")&select=id,owner_telegram_user_id,artist_name,studio_name,city");
    const masters=(studios||[]).filter((p:any)=>String(p.id)!==studioId).map((p:any)=>{
     const r=relations.find((x:any)=>String(x.studio_low_id)===String(p.id)||String(x.studio_high_id)===String(p.id));
     return {...p,matched_contact_name:matches.get(String(p.owner_telegram_user_id))||"",friendship_id:r?.id||null,friendship_status:r?.status||"none",requested_by_studio_id:r?.requested_by_studio_id||null};
    });
    return out({ok:true,masters});
   }
   if(b.action==="search_masters"){
    const query=String(b.query||"").trim().replace(/^@/,"").slice(0,80);
    if(query.length<2)return out({ok:true,masters:[]});
    const safe=encodeURIComponent(query);
    const found=await db("tm_studios?or=(artist_name.ilike.*"+safe+"*,studio_name.ilike.*"+safe+"*,city.ilike.*"+safe+"*)&select=id,owner_telegram_user_id,artist_name,studio_name,city&order=artist_name.asc&limit=40");
    const usernameRows=await db("tm_user_profiles?username=ilike.*"+safe+"*&select=telegram_user_id,username&limit=40");
    const ownerIds=[...new Set((usernameRows||[]).map((x:any)=>String(x.telegram_user_id)).filter(Boolean))];
    const byUsername=ownerIds.length?await db("tm_studios?owner_telegram_user_id=in.("+ownerIds.map(encodeURIComponent).join(",")+")&select=id,owner_telegram_user_id,artist_name,studio_name,city&limit=40"):[];
    const candidates=new Map<string,any>();for(const p of [...(found||[]),...(byUsername||[])])candidates.set(String(p.id),p);
    const candidateRows=[...candidates.values()].filter((p:any)=>String(p.id)!==studioId).slice(0,40);
    const candidateIds=candidateRows.map((p:any)=>String(p.owner_telegram_user_id)).filter(Boolean);
    const profiles=candidateIds.length?await db("tm_user_profiles?telegram_user_id=in.("+[...new Set(candidateIds)].map(encodeURIComponent).join(",")+")&select=telegram_user_id,username"):[];
    const usernames=new Map((profiles||[]).map((p:any)=>[String(p.telegram_user_id),p.username||null]));
    const map=new Map(relations.map((r:any)=>[otherId(r),r]));
    const masters=candidateRows.map((p:any)=>{const r=map.get(String(p.id));return {...p,username:usernames.get(String(p.owner_telegram_user_id))||null,friendship_id:r?.id||null,friendship_status:r?.status||"none",requested_by_studio_id:r?.requested_by_studio_id||null};});
    return out({ok:true,masters});
   }
   if(b.action==="send_master_friend_request"){
    const target=String(b.studio_id||"");
    if(!/^[0-9a-f-]{36}$/i.test(target)||target===studioId)return out({error:"INVALID_MASTER"},400);
    const recipientRows=await db("tm_studios?id=eq."+encodeURIComponent(target)+"&select=id,owner_telegram_user_id,artist_name,studio_name");
    const recipient=recipientRows?.[0];if(!recipient)return out({error:"MASTER_NOT_FOUND"},404);
    const sender=await profile(studioId);
    const low=studioId<target?studioId:target,high=studioId<target?target:studioId;
    const existing=await db("tm_master_friendships?studio_low_id=eq."+low+"&studio_high_id=eq."+high+"&select=*");
    if(existing?.length){const row=existing[0];if(row.status==="accepted")return out({error:"ALREADY_FRIENDS"},409);return out({error:String(row.requested_by_studio_id)===studioId?"REQUEST_ALREADY_SENT":"INCOMING_REQUEST_EXISTS"},409);}
    const created=await db("tm_master_friendships",{method:"POST",body:JSON.stringify([{studio_low_id:low,studio_high_id:high,requested_by_studio_id:studioId,status:"pending"}])});
    if(recipient.owner_telegram_user_id)await notifyTelegram(String(recipient.owner_telegram_user_id),"🤝 Новый запрос в друзья от мастера «"+(sender?.artist_name||"Мастер")+"». Откройте TATTOO MANAGER, чтобы посмотреть профиль и подтвердить заявку.","master");
    return out({ok:true,friendship:created?.[0]||null});
   }
   if(b.action==="respond_master_friend_request"){
    const id=String(b.friendship_id||""),accept=b.accept===true;
    if(!/^[0-9a-f-]{36}$/i.test(id))return out({error:"INVALID_REQUEST"},400);
    const found=await db("tm_master_friendships?id=eq."+encodeURIComponent(id)+"&studio_low_id=eq."+ (studioId<"ffffffff-ffff-ffff-ffff-ffffffffffff"?studioId:studioId)+"&select=*");
    let row=found?.[0];
    if(!row){const rows=await db("tm_master_friendships?id=eq."+encodeURIComponent(id)+"&studio_high_id=eq."+studioId+"&select=*");row=rows?.[0];}
    if(!row||String(row.requested_by_studio_id)===studioId||row.status!=="pending")return out({error:"FRIEND_REQUEST_NOT_FOUND"},404);
    if(accept){const changed=await db("tm_master_friendships?id=eq."+encodeURIComponent(id)+"&studio_low_id=eq."+row.studio_low_id+"&studio_high_id=eq."+row.studio_high_id,{method:"PATCH",body:JSON.stringify({status:"accepted",updated_at:new Date().toISOString()})});const requesterRows=await db("tm_studios?id=eq."+encodeURIComponent(String(row.requested_by_studio_id))+"&select=owner_telegram_user_id,artist_name");const requester=requesterRows?.[0];if(requester?.owner_telegram_user_id)await notifyTelegram(String(requester.owner_telegram_user_id),"✅ Мастер «"+(requesterRows?.[0]?.artist_name||"Ваш коллега")+"» принял вашу заявку в друзья. Теперь вы можете видеть профили друг друга в TATTOO MANAGER.","master");return out({ok:true,friendship:changed?.[0]||null});}
    await db("tm_master_friendships?id=eq."+encodeURIComponent(id)+"&studio_low_id=eq."+row.studio_low_id+"&studio_high_id=eq."+row.studio_high_id,{method:"DELETE"});
    return out({ok:true});
   }
   if(b.action==="remove_master_friend"){
    const id=String(b.friendship_id||"");
    if(!/^[0-9a-f-]{36}$/i.test(id))return out({error:"INVALID_FRIENDSHIP"},400);
    const found=await db("tm_master_friendships?id=eq."+encodeURIComponent(id)+"&or=(studio_low_id.eq."+studioId+",studio_high_id.eq."+studioId+")&status=eq.accepted&select=id");
    if(!found?.length)return out({error:"FRIENDSHIP_NOT_FOUND"},404);
    await db("tm_master_friendships?id=eq."+encodeURIComponent(id),{method:"DELETE"});
    return out({ok:true});
   }
  }


  if(b.action==="save_master_deposit_settings"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const amount=Number(b.deposit_amount),method=String(b.deposit_method||"").trim(),recipient=String(b.deposit_recipient||"").trim(),details=String(b.deposit_details||"").trim();
   if(!Number.isFinite(amount)||amount<0||amount>10000000)return out({error:"INVALID_DEPOSIT_AMOUNT"},400);
   if(method.length>100||recipient.length>160||details.length>2000)return out({error:"DEPOSIT_DETAILS_TOO_LONG"},400);
   if(amount>0&&(!method||!recipient||!details))return out({error:"DEPOSIT_DETAILS_REQUIRED"},400);
   const saved=await db("tm_studios?id=eq."+own[0].id,{method:"PATCH",body:JSON.stringify({deposit_amount:amount||null,deposit_method:method||null,deposit_recipient:recipient||null,deposit_details:details||null})});
   return out({ok:true,studio:saved?.[0]||null});
  }
  if(b.action==="client_reschedule_appointment"){
   if(req.headers.get("x-tm-role")!=="client")return out({error:"CLIENT_ROLE_REQUIRED"},403);
   const id=String(b.id||""),date=String(b.date||""),time=String(b.time||"").slice(0,5);
   if(!id||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(time))return out({error:"INVALID_RESCHEDULE_DATA"},400);
   const found=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&select=*");
   if(!found?.length)return out({error:"APPOINTMENT_NOT_FOUND"},404);
   const ap=found[0];let owned=Number(ap.client_telegram_user_id)===user.id;
   if(!owned&&ap.client_id){const linked=await db("tm_clients?id=eq."+encodeURIComponent(ap.client_id)+"&studio_id=eq."+encodeURIComponent(ap.studio_id)+"&telegram_user_id=eq."+user.id+"&select=id");owned=!!linked?.length;}
   if(!owned)return out({error:"APPOINTMENT_NOT_OWNED_BY_CLIENT"},403);
   if(!["confirmed","pending"].includes(ap.status))return out({error:"APPOINTMENT_NOT_RESCHEDULABLE"},409);
   if(Number(ap.reschedule_count||0)>=3)return out({error:"RESCHEDULE_LIMIT_REACHED"},409);
   const conflicts=await scheduleConflictsServer(ap.studio_id,date,time,Number(ap.duration_minutes)||120,id);if(conflicts.length)return out({error:"SCHEDULE_CONFLICT",conflicts},409);
   const rows=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&reschedule_count=eq."+Number(ap.reschedule_count||0),{method:"PATCH",body:JSON.stringify({requested_date:date,requested_time:time,client_telegram_user_id:user.id,reschedule_count:Number(ap.reschedule_count||0)+1,updated_at:new Date().toISOString()})});
   if(!rows?.length)return out({error:"RESCHEDULE_CONFLICT"},409);
   const studio=await db("tm_studios?id=eq."+encodeURIComponent(ap.studio_id)+"&select=owner_telegram_user_id");
   if(studio?.[0]?.owner_telegram_user_id)await notifyTelegram(studio[0].owner_telegram_user_id,"🔁 Клиент перенёс сеанс самостоятельно\n"+ap.client_name+"\nНовая дата: "+date+" в "+time+"\nИспользовано переносов: "+(Number(ap.reschedule_count||0)+1)+"/3","master");
   return out({ok:true,appointment:rows[0]});
  }
  if(b.action==="client_request_deposit_rebooking"){
   if(req.headers.get("x-tm-role")!=="client")return out({error:"CLIENT_ROLE_REQUIRED"},403);
   const id=String(b.id||"");const found=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&select=*");
   if(!found?.length)return out({error:"APPOINTMENT_NOT_FOUND"},404);const ap=found[0];
   let owned=Number(ap.client_telegram_user_id)===user.id;if(!owned&&ap.client_id){const linked=await db("tm_clients?id=eq."+encodeURIComponent(ap.client_id)+"&studio_id=eq."+encodeURIComponent(ap.studio_id)+"&telegram_user_id=eq."+user.id+"&select=id");owned=!!linked?.length;}
   if(!owned)return out({error:"APPOINTMENT_NOT_OWNED_BY_CLIENT"},403);
   if(Number(ap.reschedule_count||0)<3)return out({error:"RESCHEDULE_LIMIT_NOT_REACHED"},409);
   if(ap.status!=="confirmed"&&ap.status!=="pending")return out({error:"APPOINTMENT_NOT_ACTIVE"},409);
   const st=await db("tm_studios?id=eq."+encodeURIComponent(ap.studio_id)+"&select=deposit_amount,deposit_method,deposit_recipient,deposit_details,owner_telegram_user_id");
   const studio=st?.[0];if(!studio||!Number(studio.deposit_amount)||!studio.deposit_method||!studio.deposit_recipient||!studio.deposit_details)return out({error:"MASTER_DEPOSIT_NOT_CONFIGURED"},409);
   await db("tm_appointments?id=eq."+encodeURIComponent(id),{method:"PATCH",body:JSON.stringify({deposit_rebooking_required:true,deposit_rebooking_requested_at:new Date().toISOString(),client_telegram_user_id:user.id,updated_at:new Date().toISOString()})});
   const paymentText="💳 Повторная бронь сеанса\nСумма: "+studio.deposit_amount+" ₽\nСпособ: "+studio.deposit_method+"\nПолучатель: "+studio.deposit_recipient+"\nРеквизиты: "+studio.deposit_details+"\n\nПосле перевода дождитесь подтверждения мастера. Не отправляйте данные карты в ответ.";
   if(studio.owner_telegram_user_id)await notifyTelegram(studio.owner_telegram_user_id,"💳 Клиент запросил повторную бронь после исчерпания лимита переносов: "+ap.client_name+" · "+ap.requested_date+" в "+String(ap.requested_time).slice(0,5),"master");
   await notifyTelegram(user.id,paymentText,"client");
   return out({ok:true,payment:{amount:studio.deposit_amount,method:studio.deposit_method,recipient:studio.deposit_recipient,details:studio.deposit_details}});
  }
  if(b.action==="client_cancel_appointment"){
   if(req.headers.get("x-tm-role")!=="client")return out({error:"CLIENT_ROLE_REQUIRED"},403);
   const id=String(b.id||"");const found=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&select=*");if(!found?.length)return out({error:"APPOINTMENT_NOT_FOUND"},404);const ap=found[0];
   let owned=Number(ap.client_telegram_user_id)===user.id;if(!owned&&ap.client_id){const linked=await db("tm_clients?id=eq."+encodeURIComponent(ap.client_id)+"&studio_id=eq."+encodeURIComponent(ap.studio_id)+"&telegram_user_id=eq."+user.id+"&select=id");owned=!!linked?.length;}
   if(!owned)return out({error:"APPOINTMENT_NOT_OWNED_BY_CLIENT"},403);if(!["confirmed","pending"].includes(ap.status))return out({error:"APPOINTMENT_NOT_ACTIVE"},409);
   const rows=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&status=in.(confirmed,pending)",{method:"PATCH",body:JSON.stringify({status:"cancelled",updated_at:new Date().toISOString()})});if(!rows?.length)return out({error:"CANCEL_CONFLICT"},409);
   await db("tm_referrals?referred_appointment_id=eq."+encodeURIComponent(id)+"&status=eq.pending",{method:"PATCH",body:JSON.stringify({status:"cancelled"})});
   const st=await db("tm_studios?id=eq."+encodeURIComponent(ap.studio_id)+"&select=owner_telegram_user_id");if(st?.[0]?.owner_telegram_user_id)await notifyTelegram(st[0].owner_telegram_user_id,"❌ Клиент отменил сеанс. Бронь сгорает.\n"+ap.client_name+" · "+ap.requested_date+" в "+String(ap.requested_time).slice(0,5),"master");
   return out({ok:true});
  }
  if(b.action==="master_confirm_deposit_rebooking"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const id=String(b.id||"");const found=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+own[0].id+"&deposit_rebooking_required=eq.true&select=*");if(!found?.length)return out({error:"DEPOSIT_REQUEST_NOT_FOUND"},404);
   const ap=found[0];const rows=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+own[0].id,{method:"PATCH",body:JSON.stringify({reschedule_count:0,deposit_rebooking_required:false,deposit_rebooking_requested_at:null,updated_at:new Date().toISOString()})});
   if(ap.client_telegram_user_id)await notifyTelegram(ap.client_telegram_user_id,"✅ Мастер подтвердил получение повторной брони. Лимит переносов обновлён: вам снова доступны 3 переноса.","client");
   return out({ok:true,appointment:rows?.[0]||null});
  }
  if(b.action==="update_master_review_link"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const reviewUrl=String(b.review_url||"").trim();
   if(reviewUrl){
    let parsed:URL;try{parsed=new URL(reviewUrl)}catch{return out({error:"INVALID_REVIEW_URL"},400)}
    if(!["https:","http:"].includes(parsed.protocol)||parsed.username||parsed.password||reviewUrl.length>500)return out({error:"INVALID_REVIEW_URL"},400);
   }
   const saved=await db("tm_studios?id=eq."+encodeURIComponent(own[0].id),{method:"PATCH",body:JSON.stringify({review_url:reviewUrl||null})});
   return out({ok:true,review_url:saved?.[0]?.review_url||null});
  }

  if(["create_project","update_project","delete_project","upload_project_image","set_project_session"].includes(String(b.action||""))){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=own[0].id,action=String(b.action);
   if(action==="create_project"||action==="update_project"){
    const title=String(b.title||"").trim().slice(0,180),clientId=b.client_id?String(b.client_id):null,status=String(b.status||"new"),price=b.price===""||b.price==null?null:Number(b.price);
    if(!title)return out({error:"PROJECT_TITLE_REQUIRED"},400);
    if(!["new","sketch","approved","in_progress","completed","cancelled"].includes(status))return out({error:"INVALID_PROJECT_STATUS"},400);
    if(price!==null&&(!Number.isFinite(price)||price<0||price>100000000))return out({error:"INVALID_PROJECT_PRICE"},400);
    if(clientId){const c=await db("tm_clients?id=eq."+encodeURIComponent(clientId)+"&studio_id=eq."+studioId+"&select=id");if(!c?.length)return out({error:"CLIENT_NOT_FOUND"},404);}
    const plannedCount=Number(b.planned_sessions_count??1);if(!Number.isInteger(plannedCount)||plannedCount<1||plannedCount>50)return out({error:"INVALID_PLANNED_SESSIONS_COUNT"},400);
    const payload={title,client_id:clientId,description:String(b.description||"").slice(0,8000),body_placement:String(b.body_placement||"").slice(0,160),price,status,updated_at:new Date().toISOString()};
    if(action==="create_project"){
     const rows=await db("tm_projects",{method:"POST",body:JSON.stringify([{...payload,studio_id:studioId,completion_percent:0}])});
     const project=rows?.[0];if(!project)return out({error:"PROJECT_CREATE_FAILED"},500);
     const sessions=Array.from({length:plannedCount},(_,i)=>({studio_id:studioId,project_id:project.id,session_number:i+1,completed:false}));
     await db("tm_project_sessions",{method:"POST",body:JSON.stringify(sessions)});
     return out({ok:true,project:{...project,sessions,completion_percent:0}});
    }
    const id=String(b.id||"");if(!id)return out({error:"PROJECT_ID_REQUIRED"},400);
    const existing=await db("tm_projects?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId+"&select=id");
    if(!existing?.length)return out({error:"PROJECT_NOT_FOUND"},404);
    const currentSessions=await db("tm_project_sessions?project_id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId+"&select=id,session_number,completed&order=session_number.asc");
    const completedCount=(currentSessions||[]).filter((x:any)=>x.completed).length;
    if(plannedCount<completedCount||(currentSessions||[]).some((x:any)=>x.completed&&x.session_number>plannedCount))return out({error:"COUNT_BELOW_COMPLETED_SESSIONS",completed_count:completedCount},409);
    const updateRows=await db("tm_projects?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId,{method:"PATCH",body:JSON.stringify(payload)});
    if(!updateRows?.length)return out({error:"PROJECT_NOT_FOUND"},404);
    const sessionsNow=currentSessions||[];
    const excess=sessionsNow.filter((x:any)=>x.session_number>plannedCount&&!x.completed);
    for(const x of excess)await db("tm_project_sessions?id=eq."+encodeURIComponent(x.id)+"&studio_id=eq."+studioId,{method:"DELETE"});
    const kept=new Set(sessionsNow.filter((x:any)=>x.session_number<=plannedCount).map((x:any)=>x.session_number));
    const missing=Array.from({length:plannedCount},(_,i)=>i+1).filter(n=>!kept.has(n));
    if(missing.length)await db("tm_project_sessions",{method:"POST",body:JSON.stringify(missing.map(n=>({studio_id:studioId,project_id:id,session_number:n,completed:false})))});
    const finalSessions=await db("tm_project_sessions?project_id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId+"&select=*&order=session_number.asc");
    const percent=finalSessions?.length?Math.round(finalSessions.filter((x:any)=>x.completed).length/finalSessions.length*100):0;
    const finalProject=await db("tm_projects?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId,{method:"PATCH",body:JSON.stringify({completion_percent:percent,updated_at:new Date().toISOString()})});
    return out({ok:true,project:{...finalProject?.[0],sessions:finalSessions||[],completion_percent:percent}});
   }
   if(action==="set_project_session"){
    const projectId=String(b.id||""),sessionId=String(b.session_id||"");
    if(!projectId||!sessionId||typeof b.completed!=="boolean")return out({error:"INVALID_PROJECT_SESSION"},400);
    const project=await db("tm_projects?id=eq."+encodeURIComponent(projectId)+"&studio_id=eq."+studioId+"&select=id");
    if(!project?.length)return out({error:"PROJECT_NOT_FOUND"},404);
    const found=await db("tm_project_sessions?id=eq."+encodeURIComponent(sessionId)+"&project_id=eq."+encodeURIComponent(projectId)+"&studio_id=eq."+studioId+"&select=id");
    if(!found?.length)return out({error:"PROJECT_SESSION_NOT_FOUND"},404);
    await db("tm_project_sessions?id=eq."+encodeURIComponent(sessionId)+"&project_id=eq."+encodeURIComponent(projectId)+"&studio_id=eq."+studioId,{method:"PATCH",body:JSON.stringify({completed:b.completed,updated_at:new Date().toISOString()})});
    const sessions=await db("tm_project_sessions?project_id=eq."+encodeURIComponent(projectId)+"&studio_id=eq."+studioId+"&select=*&order=session_number.asc");
    const percent=sessions?.length?Math.round(sessions.filter((x:any)=>x.completed).length/sessions.length*100):0;
    await db("tm_projects?id=eq."+encodeURIComponent(projectId)+"&studio_id=eq."+studioId,{method:"PATCH",body:JSON.stringify({completion_percent:percent,updated_at:new Date().toISOString()})});
    return out({ok:true,sessions:sessions||[],completion_percent:percent});
   }
   if(action==="delete_project"){
    const id=String(b.id||"");if(!id)return out({error:"PROJECT_ID_REQUIRED"},400);
    const found=await db("tm_projects?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId+"&select=id,images");
    if(!found?.length)return out({error:"PROJECT_NOT_FOUND"},404);
    for(const path of (Array.isArray(found[0].images)?found[0].images:[])){if(typeof path==="string")await storageRequest("object/tm-client-references/"+path,{method:"DELETE"}).catch(()=>{});}
    await db("tm_projects?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId,{method:"DELETE"});
    return out({ok:true});
   }
   if(action==="upload_project_image"){
    const id=String(b.id||""),mime=String(b.mime_type||"");
    if(!id||!["image/jpeg","image/png","image/webp"].includes(mime))return out({error:"INVALID_PROJECT_IMAGE"},400);
    const found=await db("tm_projects?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId+"&select=id,images");
    if(!found?.length)return out({error:"PROJECT_NOT_FOUND"},404);
    const encoded=String(b.image_base64||"").split(",").pop()||"";
    if(!encoded||encoded.length>11200000)return out({error:"IMAGE_TOO_LARGE"},413);
    let bytes:Uint8Array;try{const binary=atob(encoded);if(binary.length>8388608)return out({error:"IMAGE_TOO_LARGE"},413);bytes=Uint8Array.from(binary,ch=>ch.charCodeAt(0));}catch{return out({error:"INVALID_IMAGE_DATA"},400);}
    const ext=mime==="image/jpeg"?"jpg":mime==="image/png"?"png":"webp",path=studioId+"/projects/"+id+"/"+crypto.randomUUID()+"."+ext;
    await storageRequest("object/tm-client-references/"+path,{method:"POST",headers:{"Content-Type":mime,"x-upsert":"false"},body:bytes});
    const images=[...(Array.isArray(found[0].images)?found[0].images:[]),path];
    const rows=await db("tm_projects?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId,{method:"PATCH",body:JSON.stringify({images,updated_at:new Date().toISOString()})});
    return out({ok:true,project:rows?.[0]||null});
   }
  }
  if(b.action==="propose_booking_time"){const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);const studioId=own[0].id,id=String(b.id||""),date=String(b.proposed_date||""),time=String(b.proposed_time||""),note=String(b.proposal_note||"").trim();if(!id||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(time)||note.length>1000)return out({error:"INVALID_PROPOSAL_FIELDS"},400);const found=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId+"&select=*");if(!found?.length)return out({error:"APPOINTMENT_NOT_FOUND"},404);const ap=found[0];if(!["pending","confirmed"].includes(ap.status))return out({error:"BOOKING_CANNOT_BE_PROPOSED"},409);if(Number(ap.reschedule_count||0)>=3)return out({error:"RESCHEDULE_LIMIT_REACHED"},409);const conflicts=await scheduleConflictsServer(studioId,date,time,Number(ap.duration_minutes)||120,id);if(conflicts.length)return out({error:"SCHEDULE_CONFLICT",conflicts},409);const rows=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId,{method:"PATCH",body:JSON.stringify({status:"reschedule_pending",proposal_previous_status:ap.status,proposed_date:date,proposed_time:time,proposal_note:note,updated_at:new Date().toISOString()})});if(ap.client_telegram_user_id)await notifyTelegram(ap.client_telegram_user_id,"🕒 Мастер предлагает другое время записи\nПервоначально: "+ap.requested_date+" в "+String(ap.requested_time).slice(0,5)+"\nНовое предложение: "+date+" в "+time+(note?"\nКомментарий: "+note:"")+"\n\nОткройте личный кабинет и примите предложение или откажитесь.","client");return out({ok:true,appointment:rows?.[0]||null});}
  if(b.action==="respond_booking_confirmation"){
   if(req.headers.get("x-tm-role")!=="client")return out({error:"CLIENT_ROLE_REQUIRED"},403);
   const id=String(b.id||""),decision=String(b.decision||"");
   if(!id||!["confirm","decline"].includes(decision))return out({error:"INVALID_BOOKING_RESPONSE"},400);
   const found=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&select=*");
   if(!found?.length)return out({error:"APPOINTMENT_NOT_FOUND"},404);
   const ap=found[0];let authorized=Number(ap.client_telegram_user_id)===user.id;
   if(!authorized&&ap.client_id){
    const linked=await db("tm_clients?id=eq."+encodeURIComponent(String(ap.client_id))+"&studio_id=eq."+encodeURIComponent(String(ap.studio_id))+"&telegram_user_id=eq."+user.id+"&select=id");
    authorized=!!linked?.length;
   }
   if(!authorized)return out({error:"APPOINTMENT_NOT_OWNED_BY_CLIENT"},403);
   if(ap.status!=="pending"||ap.client_confirmation_required!==true)return out({error:"BOOKING_NOT_AWAITING_CONFIRMATION"},409);
   const nextStatus=decision==="confirm"?"confirmed":"declined";
   const rows=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&status=eq.pending",{method:"PATCH",body:JSON.stringify({status:nextStatus,client_telegram_user_id:user.id,client_confirmation_required:false,updated_at:new Date().toISOString()})});
   if(!rows?.length)return out({error:"BOOKING_RESPONSE_CONFLICT"},409);
   if(decision==="decline")await db("tm_referrals?referred_appointment_id=eq."+encodeURIComponent(id)+"&status=eq.pending",{method:"PATCH",body:JSON.stringify({status:"cancelled"})});
   const studio=await db("tm_studios?id=eq."+encodeURIComponent(String(ap.studio_id))+"&select=owner_telegram_user_id");
   if(studio?.[0]?.owner_telegram_user_id)await notifyTelegram(studio[0].owner_telegram_user_id,decision==="confirm"?"✅ Клиент подтвердил запись: "+ap.client_name+" · "+ap.requested_date+" в "+String(ap.requested_time).slice(0,5):"↩️ Клиент не сможет прийти: "+ap.client_name+" · "+ap.requested_date+" в "+String(ap.requested_time).slice(0,5),"master");
   return out({ok:true,appointment:rows[0]});
  }
  if(b.action==="client_counter_propose_booking_time"){if(req.headers.get("x-tm-role")!=="client")return out({error:"CLIENT_ROLE_REQUIRED"},403);const id=String(b.id||""),date=String(b.date||""),time=String(b.time||"").slice(0,5);if(!id||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)||!/^[0-9]{2}:[0-9]{2}$/.test(time))return out({error:"INVALID_RESCHEDULE_DATA"},400);const found=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&status=eq.reschedule_pending&select=*");if(!found?.length)return out({error:"PROPOSAL_NOT_FOUND"},404);const ap=found[0];let owned=Number(ap.client_telegram_user_id)===user.id;if(!owned&&ap.client_id){const linked=await db("tm_clients?id=eq."+encodeURIComponent(ap.client_id)+"&studio_id=eq."+encodeURIComponent(ap.studio_id)+"&telegram_user_id=eq."+user.id+"&select=id");owned=!!linked?.length;}if(!owned)return out({error:"APPOINTMENT_NOT_OWNED_BY_CLIENT"},403);const conflicts=await scheduleConflictsServer(ap.studio_id,date,time,Number(ap.duration_minutes)||120,id);if(conflicts.length)return out({error:"SCHEDULE_CONFLICT",conflicts},409);const rows=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&status=eq.reschedule_pending",{method:"PATCH",body:JSON.stringify({client_proposed_date:date,client_proposed_time:time,updated_at:new Date().toISOString()})});const studio=await db("tm_studios?id=eq."+encodeURIComponent(ap.studio_id)+"&select=owner_telegram_user_id");if(studio?.[0]?.owner_telegram_user_id)await notifyTelegram(studio[0].owner_telegram_user_id,"🗓 Клиент предлагает другое время\n"+ap.client_name+"\nДата: "+date+" · "+time,"master");return out({ok:true,appointment:rows?.[0]||null});}
if(b.action==="master_respond_client_counterproposal"){const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);const id=String(b.id||""),decision=String(b.decision||"");if(!id||!["accept","decline"].includes(decision))return out({error:"INVALID_COUNTERPROPOSAL_RESPONSE"},400);const found=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+own[0].id+"&status=eq.reschedule_pending&select=*");if(!found?.length||!found[0].client_proposed_date||!found[0].client_proposed_time)return out({error:"COUNTERPROPOSAL_NOT_FOUND"},404);const ap=found[0];if(decision==="accept"){const conflicts=await scheduleConflictsServer(ap.studio_id,String(ap.client_proposed_date),String(ap.client_proposed_time).slice(0,5),Number(ap.duration_minutes)||120,id);if(conflicts.length)return out({error:"SCHEDULE_CONFLICT",conflicts},409);}const patch=decision==="accept"?{requested_date:ap.client_proposed_date,requested_time:ap.client_proposed_time,status:"confirmed",reschedule_count:Number(ap.reschedule_count||0)+1}:{status:ap.proposal_previous_status==="confirmed"?"confirmed":"pending"};patch.client_proposed_date=null;patch.client_proposed_time=null;patch.proposal_previous_status=null;patch.proposed_date=null;patch.proposed_time=null;patch.proposal_note=null;patch.updated_at=new Date().toISOString();const rows=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+own[0].id,{method:"PATCH",body:JSON.stringify(patch)});if(ap.client_telegram_user_id)await notifyTelegram(ap.client_telegram_user_id,decision==="accept"?"✅ Мастер подтвердил предложенное вами время: "+String(ap.client_proposed_date)+" · "+String(ap.client_proposed_time).slice(0,5):"Мастер не смог принять предложенное время. Свяжитесь с мастером, чтобы выбрать другое.","client");return out({ok:true,appointment:rows?.[0]||null});}
if(b.action==="respond_booking_proposal"){if(req.headers.get("x-tm-role")!=="client")return out({error:"CLIENT_ROLE_REQUIRED"},403);const id=String(b.id||""),decision=String(b.decision||"");if(!id||!["accept","decline"].includes(decision))return out({error:"INVALID_PROPOSAL_RESPONSE"},400);const found=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&client_telegram_user_id=eq."+user.id+"&status=eq.reschedule_pending&select=*");if(!found?.length)return out({error:"PROPOSAL_NOT_FOUND"},404);const ap=found[0];if(decision==="accept"){const conflicts=await scheduleConflictsServer(ap.studio_id,String(ap.proposed_date),String(ap.proposed_time).slice(0,5),Number(ap.duration_minutes)||120,String(ap.id));if(conflicts.length)return out({error:"SCHEDULE_CONFLICT",conflicts},409);}const patch=decision==="accept"?{requested_date:ap.proposed_date,requested_time:ap.proposed_time,status:"confirmed",reschedule_count:Number(ap.reschedule_count||0)+1,proposal_previous_status:null,proposed_date:null,proposed_time:null,proposal_note:null,updated_at:new Date().toISOString()}:{status:ap.proposal_previous_status==="confirmed"?"confirmed":"pending",proposal_previous_status:null,proposed_date:null,proposed_time:null,proposal_note:null,updated_at:new Date().toISOString()};const rows=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&client_telegram_user_id=eq."+user.id,{method:"PATCH",body:JSON.stringify(patch)});const studio=await db("tm_studios?id=eq."+ap.studio_id+"&select=owner_telegram_user_id");if(studio?.[0]?.owner_telegram_user_id)await notifyTelegram(studio[0].owner_telegram_user_id,decision==="accept"?"✅ Клиент принял предложенное время: "+ap.client_name+" · "+ap.proposed_date+" в "+String(ap.proposed_time).slice(0,5):"↩️ Клиент отклонил предложенное время: "+ap.client_name);return out({ok:true,appointment:rows?.[0]||null});}
  if(["create_task","update_task","delete_task"].includes(b.action)){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=own[0].id;
   if(b.action==="create_task"){
    const title=String(b.title||"").trim(),description=String(b.description||"").trim(),priority=String(b.priority||"medium"),dueDate=String(b.due_date||""),dueTime=String(b.due_time||""),clientId=b.client_id?String(b.client_id):null,appointmentId=b.appointment_id?String(b.appointment_id):null;
    if(!title||title.length>180||description.length>3000||!["low","medium","high"].includes(priority)||!(dueDate===""||/^\d{4}-\d{2}-\d{2}$/.test(dueDate))||!(dueTime===""||/^\d{2}:\d{2}$/.test(dueTime)))return out({error:"INVALID_TASK_FIELDS"},400);
    if(clientId){const c=await db("tm_clients?id=eq."+encodeURIComponent(clientId)+"&studio_id=eq."+studioId+"&select=id");if(!c?.length)return out({error:"CLIENT_NOT_FOUND"},404);}
    if(appointmentId){const a=await db("tm_appointments?id=eq."+encodeURIComponent(appointmentId)+"&studio_id=eq."+studioId+"&select=id");if(!a?.length)return out({error:"APPOINTMENT_NOT_FOUND"},404);}
    const rows=await db("tm_tasks",{method:"POST",body:JSON.stringify([{studio_id:studioId,title,description,due_date:dueDate||null,due_time:dueTime||null,priority,status:"pending",client_id:clientId,appointment_id:appointmentId,created_by_telegram_user_id:user.id}])});
    return out({ok:true,task:rows?.[0]||null});
   }
   const id=String(b.id||"");if(!id)return out({error:"TASK_ID_REQUIRED"},400);
   const found=await db("tm_tasks?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId+"&select=*");if(!found?.length)return out({error:"TASK_NOT_FOUND"},404);
   if(b.action==="delete_task"){await db("tm_tasks?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId,{method:"DELETE"});return out({ok:true});}
   const status=String(b.status||found[0].status);
   if(!["pending","completed"].includes(status))return out({error:"INVALID_TASK_STATUS"},400);
   const patch={status,completed_at:status==="completed"?new Date().toISOString():null,updated_at:new Date().toISOString()};
   if(b.title!==undefined){const title=String(b.title).trim();if(!title||title.length>180)return out({error:"INVALID_TASK_TITLE"},400);patch.title=title;}
   if(b.description!==undefined){const description=String(b.description).trim();if(description.length>3000)return out({error:"INVALID_TASK_DESCRIPTION"},400);patch.description=description;}
   if(b.priority!==undefined){if(!["low","medium","high"].includes(b.priority))return out({error:"INVALID_TASK_PRIORITY"},400);patch.priority=b.priority;}
   const rows=await db("tm_tasks?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId,{method:"PATCH",body:JSON.stringify(patch)});
   return out({ok:true,task:rows?.[0]||null});
  }
  if(b.action==="create_inventory_item"||b.action==="inventory_movement"||b.action==="delete_inventory_item"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=own[0].id;
   if(b.action==="delete_inventory_item"){
    const itemId=String(b.item_id||"");if(!itemId)return out({error:"INVENTORY_ITEM_ID_REQUIRED"},400);
    const found=await db("tm_inventory_items?id=eq."+encodeURIComponent(itemId)+"&studio_id=eq."+studioId+"&select=id,name");
    if(!found?.length)return out({error:"INVENTORY_ITEM_NOT_FOUND"},404);
    await db("tm_inventory_items?id=eq."+encodeURIComponent(itemId)+"&studio_id=eq."+studioId,{method:"DELETE"});
    return out({ok:true,deleted_id:itemId});
   }
   if(b.action==="create_inventory_item"){
    const name=String(b.name||"").trim(),unit=String(b.unit||"шт").trim(),category=String(b.category||"Расходники").trim();
    const quantity=Number(b.quantity||0),min=Number(b.min_quantity||0);
    if(!name||name.length>120||!unit||unit.length>24||!Number.isFinite(quantity)||quantity<0||!Number.isFinite(min)||min<0)return out({error:"INVALID_INVENTORY_ITEM"},400);
    const rows=await db("tm_inventory_items",{method:"POST",body:JSON.stringify([{studio_id:studioId,name,unit,category:category.slice(0,60),quantity,min_quantity:min}])});
    if(quantity>0)await db("tm_inventory_movements",{method:"POST",body:JSON.stringify([{studio_id:studioId,item_id:rows[0].id,movement_type:"in",quantity,reason:"Начальный остаток",created_by_telegram_user_id:user.id}])});
    return out({ok:true,item:rows?.[0]||null});
   }
   const itemId=String(b.item_id||""),kind=String(b.movement_type||""),amount=Number(b.quantity),reason=String(b.reason||"").trim();
   if(!itemId||!["in","out"].includes(kind)||!Number.isFinite(amount)||amount<=0||amount>1000000)return out({error:"INVALID_INVENTORY_MOVEMENT"},400);
   const found=await db("tm_inventory_items?id=eq."+encodeURIComponent(itemId)+"&studio_id=eq."+studioId+"&select=*");
   if(!found?.length)return out({error:"INVENTORY_ITEM_NOT_FOUND"},404);
   const item=found[0],oldQty=Number(item.quantity),nextQty=kind==="in"?oldQty+amount:oldQty-amount;
   if(nextQty<0)return out({error:"INSUFFICIENT_STOCK"},409);
   const changed=await db("tm_inventory_items?id=eq."+encodeURIComponent(itemId)+"&studio_id=eq."+studioId+"&quantity=eq."+oldQty,{method:"PATCH",body:JSON.stringify({quantity:nextQty,updated_at:new Date().toISOString()})});
   if(!changed?.length)return out({error:"INVENTORY_CONFLICT_RELOAD"},409);
   try{
    const movement=await db("tm_inventory_movements",{method:"POST",body:JSON.stringify([{studio_id:studioId,item_id:itemId,movement_type:kind,quantity:amount,reason:reason.slice(0,240),created_by_telegram_user_id:user.id}])});
    return out({ok:true,item:changed[0],movement:movement?.[0]||null});
   }catch(err){
    await db("tm_inventory_items?id=eq."+encodeURIComponent(itemId)+"&studio_id=eq."+studioId+"&quantity=eq."+nextQty,{method:"PATCH",body:JSON.stringify({quantity:oldQty,updated_at:new Date().toISOString()})}).catch(()=>{});
    throw err;
   }
  }
  if(b.action==="create_calendar_event"||b.action==="delete_calendar_event"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=own[0].id;
   if(b.action==="create_calendar_event"){
    const date=String(b.event_date||""),time=String(b.event_time||""),type=String(b.event_type||""),name=String(b.name||"").trim(),clientId=b.client_id?String(b.client_id):null;
    const allowed=["session","correction","consult","student","dayoff","cleaning","model"];
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!(time===""||/^\d{2}:\d{2}$/.test(time))||!allowed.includes(type)||!name||name.length>160)return out({error:"INVALID_CALENDAR_EVENT"},400);
    if(clientId){const linked=await db("tm_clients?id=eq."+encodeURIComponent(clientId)+"&studio_id=eq."+studioId+"&select=id");if(!linked?.length)return out({error:"CLIENT_NOT_FOUND"},404);}
    const rows=await db("tm_calendar_events",{method:"POST",body:JSON.stringify([{studio_id:studioId,client_id:clientId,event_date:date,event_time:time||null,event_type:type,name,note:String(b.note||"").slice(0,1000),created_by_telegram_user_id:user.id}])});
    return out({ok:true,event:rows?.[0]||null});
   }
   const id=String(b.id||"");
   if(!id)return out({error:"EVENT_ID_REQUIRED"},400);
   const rows=await db("tm_calendar_events?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId,{method:"DELETE"});
   return out({ok:true});
  }
  if(b.action==="submit_client_reference"){
   if(req.headers.get("x-tm-role")!=="client")return out({error:"CLIENT_ROLE_REQUIRED"},403);
   const studioId=String(b.studio_id||""),mime=String(b.mime_type||"");
   if(!studioId)return out({error:"STUDIO_REQUIRED"},400);
   if(!["image/jpeg","image/png","image/webp"].includes(mime))return out({error:"UNSUPPORTED_IMAGE_TYPE"},400);
   const studio=await db("tm_studios?id=eq."+encodeURIComponent(studioId)+"&select=id,owner_telegram_user_id,artist_name,studio_name");
   if(!studio?.length)return out({error:"STUDIO_NOT_FOUND"},404);
   const clients=await db("tm_clients?studio_id=eq."+studioId+"&telegram_user_id=eq."+user.id+"&select=id,full_name");
   if(!clients?.length)return out({error:"CLIENT_NOT_LINKED_TO_STUDIO"},403);
   const client=clients[0],encoded=String(b.image_base64||"").split(",").pop()||"";
   if(!encoded||encoded.length>11200000)return out({error:"IMAGE_TOO_LARGE"},413);
   let bytes:Uint8Array;try{const binary=atob(encoded);if(binary.length>8388608)return out({error:"IMAGE_TOO_LARGE"},413);bytes=Uint8Array.from(binary,ch=>ch.charCodeAt(0));}catch{return out({error:"INVALID_IMAGE_DATA"},400);}
   const ext=mime==="image/jpeg"?"jpg":mime==="image/png"?"png":"webp";
   const path=studioId+"/"+client.id+"/"+crypto.randomUUID()+"."+ext;
   await storageRequest("object/tm-client-references/"+path,{method:"POST",headers:{"Content-Type":mime,"x-upsert":"false"},body:bytes});
   let rows;
   try{rows=await db("tm_client_references",{method:"POST",body:JSON.stringify([{studio_id:studioId,client_id:client.id,file_path:path,mime_type:mime,comment:String(b.comment||"").slice(0,2000)}])});}
   catch(err){await storageRequest("object/tm-client-references/"+path,{method:"DELETE"}).catch(()=>{});throw err;}
   const note="🖼 "+"Новый референс от клиента "+String(client.full_name||"").slice(0,120)+(String(b.comment||"").trim()?"\nКомментарий: "+String(b.comment).slice(0,700):"");if(studio[0].owner_telegram_user_id)await notifyTelegram(studio[0].owner_telegram_user_id,note,"master");
   return out({ok:true,reference:{id:rows?.[0]?.id,created_at:rows?.[0]?.created_at}});
  }
  if(b.action==="create_client_link"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=own[0].id,clientId=String(b.client_id||"");
   const client=await db("tm_clients?id=eq."+encodeURIComponent(clientId)+"&studio_id=eq."+studioId+"&select=id,telegram_user_id");
   if(!client?.length)return out({error:"CLIENT_NOT_FOUND"},404);
   if(client[0].telegram_user_id)return out({error:Number(client[0].telegram_user_id)===user.id?"CLIENT_ALREADY_LINKED":"CLIENT_LINKED_TO_ANOTHER_ACCOUNT"},409);
   const bytes=new Uint8Array(24);crypto.getRandomValues(bytes);
   const raw=[...bytes].map(v=>v.toString(16).padStart(2,"0")).join("");
   const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(raw)));
   const hash=[...digest].map(v=>v.toString(16).padStart(2,"0")).join("");
   const now=new Date(),expires=new Date(now.getTime()+15*60*1000);
   await db("tm_client_link_tokens?studio_id=eq."+studioId+"&client_id=eq."+encodeURIComponent(clientId)+"&used_at=is.null",{method:"PATCH",body:JSON.stringify({used_at:now.toISOString()})});
   await db("tm_client_link_tokens",{method:"POST",body:JSON.stringify([{studio_id:studioId,client_id:clientId,token_hash:hash,expires_at:expires.toISOString(),created_by_telegram_user_id:user.id}])});
   return out({ok:true,link:"https://t.me/TattooManagerAppBot?start=link_"+raw,expires_at:expires.toISOString()});
  }

  if(b.action==="create_finance_transaction"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=own[0].id,type=String(b.transaction_type||""),amount=Number(b.amount);
   if(!["income","expense"].includes(type)||!Number.isFinite(amount)||amount<=0)return out({error:"INVALID_FINANCE_FIELDS"},400);
   let clientId=b.client_id||null;if(clientId){const c=await db("tm_clients?id=eq."+encodeURIComponent(String(clientId))+"&studio_id=eq."+studioId+"&select=id");if(!c?.length)return out({error:"CLIENT_NOT_FOUND"},404);}
   const rows=await db("tm_finance_transactions",{method:"POST",body:JSON.stringify([{studio_id:studioId,client_id:clientId,transaction_type:type,category:String(b.category||"other").slice(0,80),amount,payment_method:String(b.payment_method||"cash").slice(0,40),description:String(b.description||"").slice(0,1000),transaction_date:b.transaction_date||new Date().toISOString().slice(0,10)}])});
   return out({ok:true,transaction:rows?.[0]});
  }
  if(b.action==="create_finance_plan"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=own[0].id,clientId=String(b.client_id||""),title=String(b.title||"Рассрочка").trim(),total=Number(b.total_amount),down=Number(b.down_payment||0),count=Number(b.installments_count),frequency=String(b.frequency||"monthly"),start=String(b.start_date||"");
   if(!title||!Number.isFinite(total)||total<=0||!Number.isFinite(down)||down<0||down>total||!Number.isInteger(count)||count<1||count>60||!["weekly","biweekly","monthly"].includes(frequency)||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(start))return out({error:"INVALID_INSTALLMENT_FIELDS"},400);
   const c=await db("tm_clients?id=eq."+encodeURIComponent(clientId)+"&studio_id=eq."+studioId+"&select=id");if(!c?.length)return out({error:"CLIENT_NOT_FOUND"},404);
   const plans=await db("tm_finance_installment_plans",{method:"POST",body:JSON.stringify([{studio_id:studioId,client_id:clientId,title,total_amount:total,down_payment:down,installments_count:count,frequency,start_date:start,status:"active",notes:String(b.notes||"").slice(0,1000)}])});
   const plan=plans?.[0];if(!plan)return out({error:"PLAN_CREATE_FAILED"},500);
   const remainder=Math.round((total-down)*100)/100,base=Math.floor((remainder/count)*100)/100,due=[];
   for(let n=1;n<=count;n++){const d=new Date(start+"T12:00:00Z");if(frequency==="weekly")d.setUTCDate(d.getUTCDate()+7*(n-1));else if(frequency==="biweekly")d.setUTCDate(d.getUTCDate()+14*(n-1));else d.setUTCMonth(d.getUTCMonth()+(n-1));const amount=n===count?Math.round((remainder-base*(count-1))*100)/100:base;due.push({studio_id:studioId,plan_id:plan.id,installment_number:n,due_date:d.toISOString().slice(0,10),amount_due:amount,amount_paid:0,status:"pending"});}
   if(due.length)await db("tm_finance_installment_payments",{method:"POST",body:JSON.stringify(due)});
   if(down>0)await db("tm_finance_transactions",{method:"POST",body:JSON.stringify([{studio_id:studioId,client_id:clientId,transaction_type:"income",category:"installment_down_payment",amount:down,payment_method:String(b.payment_method||"cash"),description:"Первоначальный взнос · "+title,transaction_date:new Date().toISOString().slice(0,10)}])});
   return out({ok:true,plan,installments:due.length});
  }
  if(b.action==="pay_finance_installment"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=own[0].id,id=String(b.installment_id||""),amount=Number(b.amount);if(!Number.isFinite(amount)||amount<=0)return out({error:"INVALID_PAYMENT_AMOUNT"},400);
   const rows=await db("tm_finance_installment_payments?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId+"&select=*");if(!rows?.length)return out({error:"INSTALLMENT_NOT_FOUND"},404);
   const row=rows[0],left=Math.round((Number(row.amount_due)-Number(row.amount_paid))*100)/100;if(amount>left+0.001)return out({error:"PAYMENT_EXCEEDS_BALANCE"},400);
   const paid=Math.round((Number(row.amount_paid)+amount)*100)/100,status=paid>=Number(row.amount_due)?"paid":"partial",now=new Date().toISOString();
   const updated=await db("tm_finance_installment_payments?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId+"&amount_paid=eq."+row.amount_paid,{method:"PATCH",body:JSON.stringify({amount_paid:paid,status,paid_at:status==="paid"?now:null})});if(!updated?.length)return out({error:"PAYMENT_CONFLICT_RELOAD"},409);
   const plan=await db("tm_finance_installment_plans?id=eq."+row.plan_id+"&studio_id=eq."+studioId+"&select=client_id,title");
   await db("tm_finance_transactions",{method:"POST",body:JSON.stringify([{studio_id:studioId,client_id:plan?.[0]?.client_id||null,transaction_type:"income",category:"installment_payment",amount,payment_method:String(b.payment_method||"cash"),description:"Платёж по рассрочке · "+(plan?.[0]?.title||"платёж")+" · №"+row.installment_number,transaction_date:new Date().toISOString().slice(0,10)}])});
   const pending=await db("tm_finance_installment_payments?plan_id=eq."+row.plan_id+"&status=neq.paid&select=id");if(!pending?.length)await db("tm_finance_installment_plans?id=eq."+row.plan_id+"&studio_id=eq."+studioId,{method:"PATCH",body:JSON.stringify({status:"completed"})});
   return out({ok:true,payment:updated[0]});
  }
  if(b.action==="upload_gallery_photo"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=own[0].id,clientId=String(b.client_id||""),mime=String(b.mime_type||"");
   if(!["image/jpeg","image/png","image/webp"].includes(mime))return out({error:"UNSUPPORTED_IMAGE_TYPE"},400);
   const client=await db("tm_clients?id=eq."+encodeURIComponent(clientId)+"&studio_id=eq."+studioId+"&select=id");
   if(!client?.length)return out({error:"CLIENT_NOT_FOUND"},404);
   const encoded=String(b.image_base64||"").split(",").pop()||"";
   if(!encoded||encoded.length>11200000)return out({error:"IMAGE_TOO_LARGE"},413);
   let bytes:Uint8Array;try{const binary=atob(encoded);if(binary.length>8388608)return out({error:"IMAGE_TOO_LARGE"},413);bytes=Uint8Array.from(binary,ch=>ch.charCodeAt(0));}catch{return out({error:"INVALID_IMAGE_DATA"},400);}
   const ext=mime==="image/jpeg"?"jpg":mime==="image/png"?"png":"webp";
   const path=studioId+"/"+clientId+"/"+crypto.randomUUID()+"."+ext;
   await storageRequest("object/tm-client-gallery/"+path,{method:"POST",headers:{"Content-Type":mime,"x-upsert":"false"},body:bytes});
   try{const rows=await db("tm_client_gallery",{method:"POST",body:JSON.stringify([{studio_id:studioId,client_id:clientId,file_path:path,mime_type:mime,caption:String(b.caption||"").slice(0,500)}])});return out({ok:true,photo:rows[0]});}
   catch(err){await storageRequest("object/tm-client-gallery/"+path,{method:"DELETE"}).catch(()=>{});throw err;}
  }
  if(b.action==="delete_appointment"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=String(own[0].id),id=String(b.id||"");
   if(!/^[0-9a-f-]{36}$/i.test(id))return out({error:"INVALID_APPOINTMENT_ID"},400);
   const found=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+encodeURIComponent(studioId)+"&select=id,status");
   if(!found?.length)return out({error:"APPOINTMENT_NOT_FOUND"},404);
   await db("tm_tasks?appointment_id=eq."+encodeURIComponent(id)+"&studio_id=eq."+encodeURIComponent(studioId),{method:"PATCH",body:JSON.stringify({appointment_id:null,updated_at:new Date().toISOString()})});
   await db("tm_referrals?or=(referred_appointment_id.eq."+encodeURIComponent(id)+",reward_appointment_id.eq."+encodeURIComponent(id)+")&studio_id=eq."+encodeURIComponent(studioId),{method:"PATCH",body:JSON.stringify({referred_appointment_id:null,reward_appointment_id:null})});
   const removed=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+encodeURIComponent(studioId),{method:"DELETE"});
   if(!removed?.length)return out({error:"APPOINTMENT_DELETE_FAILED"},500);
   return out({ok:true,deleted_id:id});
  }
  if(b.action==="update_appointment_duration"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=own[0].id,id=String(b.id||""),duration=Number(b.duration_minutes);
   if(!id||!Number.isInteger(duration)||duration<15||duration>1440)return out({error:"INVALID_DURATION"},400);
   const found=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId+"&select=id,requested_date,requested_time");if(!found?.length)return out({error:"APPOINTMENT_NOT_FOUND"},404);
   const conflicts=await scheduleConflictsServer(studioId,String(found[0].requested_date),String(found[0].requested_time).slice(0,5),duration,id);if(conflicts.length)return out({error:"SCHEDULE_CONFLICT",conflicts},409);
   const rows=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+studioId,{method:"PATCH",body:JSON.stringify({duration_minutes:duration,updated_at:new Date().toISOString()})});
   return out({ok:true,appointment:rows?.[0]||null});
  }
  if(b.action==="delete_client"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=own[0].id,clientId=String(b.id||"");
   if(!clientId)return out({error:"CLIENT_ID_REQUIRED"},400);
   const found=await db("tm_clients?id=eq."+encodeURIComponent(clientId)+"&studio_id=eq."+studioId+"&select=id");
   if(!found?.length)return out({error:"CLIENT_NOT_FOUND"},404);
   const gallery=await db("tm_client_gallery?client_id=eq."+encodeURIComponent(clientId)+"&studio_id=eq."+studioId+"&select=file_path");
   const references=await db("tm_client_references?client_id=eq."+encodeURIComponent(clientId)+"&studio_id=eq."+studioId+"&select=file_path");
   await db("tm_clients?id=eq."+encodeURIComponent(clientId)+"&studio_id=eq."+studioId,{method:"DELETE"});
   for(const row of gallery||[]){if(row.file_path)await storageRequest("object/tm-client-gallery/"+row.file_path,{method:"DELETE"}).catch(err=>console.warn("CLIENT_GALLERY_CLEANUP_FAILED",String(err)));}
   for(const row of references||[]){if(row.file_path)await storageRequest("object/tm-client-references/"+row.file_path,{method:"DELETE"}).catch(err=>console.warn("CLIENT_REFERENCE_CLEANUP_FAILED",String(err)));}
   return out({ok:true});
  }
  if(b.action==="find_client_by_telegram_username"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const username=String(b.username||"").trim().replace(/^@/,"");
   if(!/^[A-Za-z0-9_]{5,32}$/.test(username))return out({error:"INVALID_TELEGRAM_USERNAME"},400);
   const profiles=await db("tm_user_profiles?username=ilike."+encodeURIComponent(username)+"&select=telegram_user_id,username,first_name,last_name,full_name,phone&limit=2");
   if(!profiles?.length)return out({ok:true,found:false});
   if(profiles.length>1)return out({error:"TELEGRAM_USERNAME_AMBIGUOUS"},409);
   const p=profiles[0],telegramId=Number(p.telegram_user_id);
   const linked=await db("tm_clients?studio_id=eq."+encodeURIComponent(String(own[0].id))+"&telegram_user_id=eq."+telegramId+"&select=id,full_name,phone,description&limit=1");
   const existing=linked?.[0]||null;
   return out({ok:true,found:true,telegram_user_id:telegramId,username:p.username||username,full_name:String(p.full_name||[p.first_name,p.last_name].filter(Boolean).join(" ")||p.username||username).trim(),phone:p.phone||existing?.phone||"",description:existing?.description||"",client_id:existing?.id||null});
  }
  if(b.action==="save_client"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=own[0].id,name=String(b.full_name||"").trim();
   if(!name)return out({error:"CLIENT_NAME_REQUIRED"},400);
   let linkedTelegramId:number|null=null;
   if(b.telegram_user_id!==undefined&&b.telegram_user_id!==null&&String(b.telegram_user_id).trim()!==""){
    linkedTelegramId=Number(b.telegram_user_id);
    if(!Number.isSafeInteger(linkedTelegramId)||linkedTelegramId<=0)return out({error:"INVALID_TELEGRAM_USER_ID"},400);
    const verified=await db("tm_user_profiles?telegram_user_id=eq."+linkedTelegramId+"&select=telegram_user_id&limit=1");
    if(!verified?.length)return out({error:"TELEGRAM_PROFILE_NOT_FOUND"},404);
   }
   const payload:any={full_name:name.slice(0,120),phone:String(b.phone||"").trim().slice(0,120)||null,description:String(b.description||"").slice(0,5000),updated_at:new Date().toISOString()};
   if(linkedTelegramId)payload.telegram_user_id=linkedTelegramId;
   for(const field of ["telegram_link","vk_link","threads_link","instagram_link","website_link"]){if(Object.prototype.hasOwnProperty.call(b,field))payload[field]=String(b[field]||"").trim().slice(0,500)||null;}
   if(Array.isArray(b.other_links))payload.other_links=b.other_links.slice(0,30);
   let rows,updated=false;
   if(b.id){rows=await db("tm_clients?id=eq."+encodeURIComponent(String(b.id))+"&studio_id=eq."+studioId,{method:"PATCH",body:JSON.stringify(payload)});if(!rows?.length)return out({error:"CLIENT_NOT_FOUND"},404);updated=true;}
   else{
    if(linkedTelegramId){const duplicate=await db("tm_clients?studio_id=eq."+encodeURIComponent(String(studioId))+"&telegram_user_id=eq."+linkedTelegramId+"&select=id&limit=1");if(duplicate?.length){rows=await db("tm_clients?id=eq."+encodeURIComponent(String(duplicate[0].id))+"&studio_id=eq."+studioId,{method:"PATCH",body:JSON.stringify(payload)});updated=true;}}
    if(!rows?.length)rows=await db("tm_clients",{method:"POST",body:JSON.stringify([{...payload,studio_id:studioId}])});
   }
   return out({ok:true,updated,client:rows[0]});
  }
  if(b.action==="create_master_booking"){
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");
   if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=own[0].id,date=String(b.requested_date||""),time=String(b.requested_time||""),name=String(b.client_name||"").trim(),duration=Math.max(15,Math.min(1440,Number.isInteger(Number(b.duration_minutes))?Number(b.duration_minutes):120));
   if(!name||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)||!/^[0-9]{2}:[0-9]{2}$/.test(time))return out({error:"INVALID_BOOKING_FIELDS"},400);
   const bookingPrice=b.price===""||b.price==null?null:Number(b.price),bookingDeposit=Number(b.deposit_amount||0);if(bookingPrice!==null&&(!Number.isFinite(bookingPrice)||bookingPrice<0||bookingPrice>100000000))return out({error:"INVALID_PRICE"},400);if(!Number.isFinite(bookingDeposit)||bookingDeposit<0||bookingDeposit>100000000||(bookingPrice!==null&&bookingDeposit>bookingPrice))return out({error:"INVALID_DEPOSIT_AMOUNT"},400);const conflicts=await scheduleConflictsServer(studioId,date,time,duration);if(conflicts.length)return out({error:"SCHEDULE_CONFLICT",conflicts},409);
   let clientId=b.client_id||null;
   let linkedClientTelegramId:number|null=null;if(clientId){const found=await db("tm_clients?id=eq."+encodeURIComponent(String(clientId))+"&studio_id=eq."+studioId+"&select=id,telegram_user_id");if(!found?.length)return out({error:"CLIENT_NOT_FOUND"},404);linkedClientTelegramId=found[0].telegram_user_id?Number(found[0].telegram_user_id):null;}
   else{const created=await db("tm_clients",{method:"POST",body:JSON.stringify([{studio_id:studioId,full_name:name.slice(0,120),phone:String(b.client_contact||"").trim().slice(0,120)||null,description:""}])});clientId=created?.[0]?.id||null;}
   const rows=await db("tm_appointments",{method:"POST",body:JSON.stringify([{studio_id:studioId,client_id:clientId,client_name:name.slice(0,120),client_contact:String(b.client_contact||"").trim().slice(0,120)||null,telegram_link:String(b.telegram_link||"").trim().slice(0,500)||null,vk_link:String(b.vk_link||"").trim().slice(0,500)||null,threads_link:String(b.threads_link||"").trim().slice(0,500)||null,instagram_link:String(b.instagram_link||"").trim().slice(0,500)||null,project_type:String(b.project_type||"").slice(0,100)||null,body_placement:String(b.body_placement||"").slice(0,100)||null,idea:String(b.idea||"").slice(0,3000)||null,price:Number.isFinite(Number(b.price))&&Number(b.price)>0?Math.min(100000000,Number(b.price)):null,deposit_amount:Number.isFinite(Number(b.deposit_amount))&&Number(b.deposit_amount)>0?Math.min(100000000,Number(b.deposit_amount)):0,deposit_paid_at:Number(b.deposit_amount)>0?new Date().toISOString():null,requested_date:date,requested_time:time,duration_minutes:duration,status:"pending",client_telegram_user_id:linkedClientTelegramId,client_confirmation_required:true}])});
   if(rows?.[0]&&linkedClientTelegramId)await notifyTelegram(linkedClientTelegramId,"🗓 Мастер создал для вас запись\nДата и время: "+date+" в "+time+"\nПроект: "+(rows[0].project_type||"не указан")+"\nОткройте личный кабинет и подтвердите запись.");
   return out({ok:true,appointment:rows?.[0]||null});
  }
  if(b.action!=="create_booking")return out({error:"UNKNOWN_ACTION"},400);
  const studioFilter=b.studio_id?"id=eq."+encodeURIComponent(String(b.studio_id)):"slug=eq.ramzes";
  const s=await db("tm_studios?"+studioFilter+"&public_booking_enabled=eq.true&select=id,slug");
  if(!s?.length)return out({error:"STUDIO_NOT_FOUND"},404);
  const date=String(b.requested_date||""),time=String(b.requested_time||"");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(time))return out({error:"INVALID_DATE_OR_TIME"},400);
  const studioId=s[0].id;
  let client=await db("tm_clients?studio_id=eq."+studioId+"&telegram_user_id=eq."+user.id+"&select=id,full_name,phone");
  if(!client?.length){
   const phone=String(b.client_contact||"").trim().slice(0,120);
   if(phone){const match=await db("tm_clients?studio_id=eq."+studioId+"&phone=eq."+encodeURIComponent(phone)+"&select=id,telegram_user_id");if(match?.length===1&&!match[0].telegram_user_id){client=await db("tm_clients?id=eq."+match[0].id+"&studio_id=eq."+studioId,{method:"PATCH",body:JSON.stringify({telegram_user_id:user.id,updated_at:new Date().toISOString()})});}}
   if(!client?.length){client=await db("tm_clients",{method:"POST",body:JSON.stringify([{studio_id:studioId,telegram_user_id:user.id,full_name:String(b.client_name||user.first_name||"Клиент").trim().slice(0,120),phone:phone||null,description:""}])});}
  }
  const clientId=client?.[0]?.id||null;
  const priorClientAppointments=clientId?await db("tm_appointments?studio_id=eq."+studioId+"&client_id=eq."+encodeURIComponent(clientId)+"&select=id&limit=1"):[];
  const priorDirectAppointments=await db("tm_appointments?studio_id=eq."+studioId+"&client_telegram_user_id=eq."+user.id+"&select=id&limit=1");
  const isFirstClientBooking=!!clientId&&!(priorClientAppointments||[]).length&&!(priorDirectAppointments||[]).length;
  const conflicts=await scheduleConflictsServer(studioId,date,time,120);if(conflicts.length)return out({error:"SCHEDULE_CONFLICT",conflicts},409);
  const rows=await db("tm_appointments",{method:"POST",body:JSON.stringify([{studio_id:studioId,client_id:clientId,client_telegram_user_id:user.id,client_username:user.username||null,client_name:String(b.client_name||user.first_name||"Клиент").trim().slice(0,120),client_contact:String(b.client_contact||"").slice(0,120)||null,project_type:String(b.project_type||"").slice(0,100)||null,body_placement:String(b.body_placement||"").slice(0,100)||null,idea:String(b.idea||"").slice(0,3000)||null,requested_date:date,requested_time:time,duration_minutes:120,status:"pending"}])});
  if(rows?.[0]){
   try{
    const profiles=await db("tm_user_profiles?telegram_user_id=eq."+user.id+"&select=referral_code");
    const referralCode=String(profiles?.[0]?.referral_code||"").toUpperCase();
    if(referralCode){
     const owners=await db("tm_clients?studio_id=eq."+studioId+"&referral_code=eq."+encodeURIComponent(referralCode)+"&select=id,telegram_user_id");
     if(owners?.[0]&&Number(owners[0].telegram_user_id)!==user.id){
      const existingReferral=await db("tm_referrals?studio_id=eq."+studioId+"&referred_telegram_user_id=eq."+user.id+"&select=id,status");
      if(!existingReferral?.length&&isFirstClientBooking){
       await db("tm_referrals",{method:"POST",body:JSON.stringify([{studio_id:studioId,referrer_client_id:owners[0].id,referrer_telegram_user_id:Number(owners[0].telegram_user_id),referred_telegram_user_id:user.id,referred_client_id:clientId,referred_appointment_id:rows[0].id,reward_amount:3000,status:"pending"}])});
      }else if(existingReferral?.[0]?.status==="cancelled"){
       await db("tm_referrals?id=eq."+encodeURIComponent(existingReferral[0].id)+"&status=eq.cancelled",{method:"PATCH",body:JSON.stringify({referrer_client_id:owners[0].id,referrer_telegram_user_id:Number(owners[0].telegram_user_id),referred_client_id:clientId,referred_appointment_id:rows[0].id,status:"pending",earned_at:null,redeemed_at:null})});
      }
     }
    }
   }catch(err){console.error("REFERRAL_ATTRIBUTION_ERROR",err);}
  }
  const studioOwner=await db("tm_studios?id=eq."+studioId+"&select=owner_telegram_user_id,artist_name");
  if(rows?.[0]&&studioOwner?.[0]?.owner_telegram_user_id){const ap=rows[0];let referralLine="";try{const ref=await db("tm_referrals?referred_appointment_id=eq."+encodeURIComponent(String(ap.id))+"&status=eq.pending&select=referrer_client_id,referrer_telegram_user_id");if(ref?.[0]){const inviter=await db("tm_clients?id=eq."+encodeURIComponent(String(ref[0].referrer_client_id))+"&select=full_name,telegram_user_id");referralLine="\n👥 Пришёл по рекомендации: "+(inviter?.[0]?.full_name||"Клиент")+(inviter?.[0]?.telegram_user_id?" · Telegram ID "+inviter[0].telegram_user_id:"");}}catch(err){console.error("REFERRAL_NOTIFICATION_LOOKUP_ERROR",err);}await notifyTelegram(studioOwner[0].owner_telegram_user_id,"🗓 Новая заявка на запись\nКлиент: "+ap.client_name+referralLine+"\nДата: "+ap.requested_date+" в "+ap.requested_time+"\nПроект: "+(ap.project_type||"не указан"));}
  return out({ok:true,appointment:rows?.[0]||null});
 }
 if(req.method==="GET"){
  const requestedRole=req.headers.get("x-tm-role")||"auto";
  const s=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id,slug,artist_name,studio_name,city,review_url,deposit_amount,deposit_method,deposit_recipient,deposit_details");
  if(s?.length&&requestedRole!=="client"){
   const studioId=s[0].id;
   const a=await db("tm_appointments?studio_id=eq."+studioId+"&select=id,client_id,client_name,client_telegram_user_id,client_confirmation_required,reschedule_count,deposit_rebooking_required,proposed_date,proposed_time,proposal_note,duration_minutes,project_type,body_placement,idea,price,requested_date,requested_time,status&order=requested_date.asc,requested_time.asc");
   const calendarEvents=await db("tm_calendar_events?studio_id=eq."+studioId+"&select=id,event_date,event_time,event_type,name,note,created_at&order=event_date.asc,event_time.asc");
   const includeFinance=new URL(req.url).searchParams.get("section")==="finance";
   const financeTransactions=includeFinance?await db("tm_finance_transactions?studio_id=eq."+studioId+"&select=transaction_type,amount,transaction_date,description,category&order=transaction_date.desc,created_at.desc"): [];
   const financePlans=includeFinance?await db("tm_finance_installment_plans?studio_id=eq."+studioId+"&select=id,title,total_amount&order=created_at.desc"): [];
   const financePayments=includeFinance?await db("tm_finance_installment_payments?studio_id=eq."+studioId+"&select=id,plan_id,installment_number,due_date,amount_due,amount_paid,status&order=due_date.asc"): [];
   const tasks=await db("tm_tasks?studio_id=eq."+studioId+"&select=id,title,description,status,priority,due_date,due_time,client_id&order=status.asc,due_date.asc,due_time.asc,created_at.desc");
   const inventoryItems=await db("tm_inventory_items?studio_id=eq."+studioId+"&select=id,name,quantity,unit,min_quantity,category&order=name.asc");
   const inventoryMovements=await db("tm_inventory_movements?studio_id=eq."+studioId+"&select=id,item_id,movement_type,quantity,reason,created_at&order=created_at.desc&limit=40");
   const c=await db("tm_clients?studio_id=eq."+studioId+"&select=id,telegram_user_id,full_name,phone,description,telegram_link,vk_link,vk_user_id,preferred_notification_channel,notifications_enabled,notification_consent_at,notification_consent_source,threads_link,instagram_link,website_link,other_links&order=created_at.desc");
   const referralRows=await db("tm_referrals?studio_id=eq."+studioId+"&status=in.(pending,earned,redeemed)&select=id,referrer_client_id,referred_client_id,referred_telegram_user_id,referred_appointment_id,reward_amount,status,earned_at,redeemed_at,created_at&order=created_at.desc");
   const earnedReferralRewards=(referralRows||[]).filter((r:any)=>r.status==="earned");
   const referralTransactions=await db("tm_referral_transactions?studio_id=eq."+studioId+"&select=id,client_id,amount,transaction_type,note,created_at&order=created_at.desc");

   const token=Deno.env.get("TELEGRAM_BOT_TOKEN")||"";
   const ids=[...new Set([...(a||[]).map((x:any)=>Number(x.client_telegram_user_id)),...(c||[]).map((x:any)=>Number(x.telegram_user_id))].filter((x:number)=>Number.isSafeInteger(x)&&x>0))];
   const photos:Record<string,string|null>={};if(req.headers.get("x-tm-skip-photos")!=="1")await Promise.all(ids.map(async(id:number)=>{photos[String(id)]=token?await cachedTelegramPhoto(id,token):null}));
   const enrichedAppointments=(a||[]).map((x:any)=>({...x,telegram_photo:x.client_telegram_user_id?photos[String(x.client_telegram_user_id)]||null:null}));
   const referenceRows=await db("tm_client_references?studio_id=eq."+studioId+"&select=id,client_id,file_path,mime_type,comment,created_at&order=created_at.desc");
   const clientReferences=await Promise.all((referenceRows||[]).map(async(g:any)=>{const signedUrl=await cachedSignedUrl("tm-client-references",g.file_path);return {...g,url:signedUrl};}));
   const galleryRows=await db("tm_client_gallery?studio_id=eq."+studioId+"&select=id,client_id,file_path,caption,mime_type,created_at&order=created_at.desc");
   const gallery=await Promise.all((galleryRows||[]).map(async(g:any)=>{const signedUrl=await cachedSignedUrl("tm-client-gallery",g.file_path);return {...g,url:signedUrl};}));
   const pendingReferrals=(referralRows||[]).filter((r:any)=>r.status==="pending").map((r:any)=>{const referred=(c||[]).find((x:any)=>String(x.id)===String(r.referred_client_id));const inviter=(c||[]).find((x:any)=>String(x.id)===String(r.referrer_client_id));const appointment=(a||[]).find((x:any)=>String(x.id)===String(r.referred_appointment_id));return {...r,referrer_client_name:inviter?.full_name||"Клиент",referred_client_name:referred?.full_name||appointment?.client_name||"Новый клиент",appointment_date:appointment?.requested_date||null,appointment_time:appointment?.requested_time||null};});
   const enrichedClients=(c||[]).map((x:any)=>{const visits=(a||[]).filter((v:any)=>v.client_id===x.id);const last=visits.map((v:any)=>v.requested_date).filter(Boolean).sort().pop()||null;const earnedBalance=(earnedReferralRewards||[]).filter((r:any)=>String(r.referrer_client_id)===String(x.id)).reduce((sum:number,r:any)=>sum+(Number(r.reward_amount)||0),0);const clientTransactions=(referralTransactions||[]).filter((r:any)=>String(r.client_id)===String(x.id));const creditedBalance=clientTransactions.filter((r:any)=>r.transaction_type==="credited").reduce((sum:number,r:any)=>sum+(Number(r.amount)||0),0);const redeemedBalance=clientTransactions.filter((r:any)=>r.transaction_type==="redeemed").reduce((sum:number,r:any)=>sum+(Number(r.amount)||0),0);const referralDiscountAvailable=Math.max(0,earnedBalance+creditedBalance-redeemedBalance);return {...x,referral_discount_available:referralDiscountAvailable,referral_history:[...(referralRows||[]).filter((r:any)=>String(r.referrer_client_id)===String(x.id)&&r.status==="earned").map((r:any)=>({...r,history_type:"earned"})),...(referralTransactions||[]).filter((r:any)=>String(r.client_id)===String(x.id)).map((r:any)=>({id:r.id,status:r.transaction_type||"redeemed",history_type:r.transaction_type||"redeemed",reward_amount:Math.abs(Number(r.amount)||0),note:r.note||null,created_at:r.created_at}))].sort((a:any,b:any)=>String(b.created_at||b.earned_at||b.redeemed_at||"").localeCompare(String(a.created_at||a.earned_at||a.redeemed_at||""))),telegram_photo:x.telegram_user_id?photos[String(x.telegram_user_id)]||null:null,visits:visits.length,last_visit:last,gallery:gallery.filter((g:any)=>g.client_id===x.id),references:clientReferences.filter((g:any)=>g.client_id===x.id)};});
   const projectRows=await db("tm_projects?studio_id=eq."+studioId+"&select=*&order=updated_at.desc");
   const projects=await Promise.all((projectRows||[]).map(async(p:any)=>{
    const signedImages=await Promise.all((Array.isArray(p.images)?p.images:[]).map(async(path:string)=>{
     try{const signedUrl=await cachedSignedUrl("tm-client-references",path);return {path,url:signedUrl};}catch{return null;}
    }));
    const sessions=await db("tm_project_sessions?project_id=eq."+encodeURIComponent(p.id)+"&studio_id=eq."+studioId+"&select=*&order=session_number.asc");
    const sessionRows=sessions||[],completionPercent=sessionRows.length?Math.round(sessionRows.filter((x:any)=>x.completed).length/sessionRows.length*100):0;
    return {...p,sessions:sessionRows,completion_percent:completionPercent,images:signedImages.filter(Boolean),client_name:(c||[]).find((x:any)=>x.id===p.client_id)?.full_name||null};
   }));
   return out({role:"master",studio:s[0],clients:enrichedClients,pendingReferrals,appointments:enrichedAppointments,calendarEvents,tasks,financeTransactions,financePlans,financePayments,inventoryItems,inventoryMovements,projects});
  }
  const linkedClients=await db("tm_clients?telegram_user_id=eq."+user.id+"&select=id,studio_id");
  const linkedClientIds=[...new Set((linkedClients||[]).map((x:any)=>String(x.id)))];
  const directAppointments=await db("tm_appointments?client_telegram_user_id=eq."+user.id+"&select=id,client_id,studio_id,client_name,project_type,body_placement,idea,requested_date,requested_time,status,reschedule_count,proposed_date,proposed_time,proposal_note,created_at,client_confirmation_required,deposit_rebooking_required&order=created_at.desc");
  const linkedAppointments=linkedClientIds.length?await db("tm_appointments?client_id=in.("+linkedClientIds.map((x:string)=>encodeURIComponent(x)).join(",")+")&select=id,client_id,studio_id,client_name,project_type,body_placement,idea,requested_date,requested_time,status,reschedule_count,proposed_date,proposed_time,proposal_note,created_at,client_confirmation_required&order=created_at.desc"):[];
  const appointmentsById=new Map<string,any>();for(const x of [...(directAppointments||[]),...(linkedAppointments||[])])appointmentsById.set(String(x.id),x);
  const a=[...appointmentsById.values()].sort((x:any,y:any)=>String(y.created_at||"").localeCompare(String(x.created_at||"")));
  const p=await db("tm_user_profiles?telegram_user_id=eq."+user.id+"&select=telegram_user_id,username,first_name,last_name,full_name,preferred_studio_id");
  const studios=await db("tm_studios?public_booking_enabled=eq.true&select=id,slug,artist_name,studio_name,city,deposit_amount,deposit_method,deposit_recipient,deposit_details&order=artist_name.asc");
  const appointmentLinks=await db("tm_appointments?client_telegram_user_id=eq."+user.id+"&select=client_id,studio_id");
  const allowedClientIds=[...new Set([...(linkedClients||[]).map((x:any)=>x.id),...(appointmentLinks||[]).map((x:any)=>x.client_id).filter(Boolean)])];
  const calendarEvents=allowedClientIds.length?await db("tm_calendar_events?client_id=in.("+allowedClientIds.map((x:string)=>encodeURIComponent(x)).join(",")+")&select=id,studio_id,client_id,event_date,event_time,event_type,name,note&order=event_date.asc,event_time.asc"):[];
  const clientStudioIds=[...new Set([...(a||[]).map((x:any)=>x.studio_id),...(calendarEvents||[]).map((x:any)=>x.studio_id)].filter(Boolean).map((x:any)=>String(x)))];
  const clientStudios=clientStudioIds.length?await db("tm_studios?id=in.("+clientStudioIds.map((x:string)=>encodeURIComponent(x)).join(",")+")&select=id,artist_name,studio_name,owner_telegram_user_id"):[];
  const masterTelegramIds=[...new Set((clientStudios||[]).map((x:any)=>Number(x.owner_telegram_user_id)).filter((x:number)=>Number.isSafeInteger(x)&&x>0))];
  const masterProfiles=masterTelegramIds.length?await db("tm_user_profiles?telegram_user_id=in.("+masterTelegramIds.join(",")+")&select=telegram_user_id,username,first_name,last_name,full_name"):[];
  const clientMasters=(clientStudios||[]).map((studio:any)=>{
   const ownerId=Number(studio.owner_telegram_user_id||0),profile=(masterProfiles||[]).find((x:any)=>Number(x.telegram_user_id)===ownerId);
   const name=profile?.full_name||[profile?.first_name,profile?.last_name].filter(Boolean).join(" ")||studio.artist_name||studio.studio_name||"Мастер";
   const username=String(profile?.username||"").replace(/^@/,"");
   return {studio_id:studio.id,name,telegram_url:username?"https://t.me/"+username:(ownerId?"tg://user?id="+ownerId:null)};
  });
  const galleryRows=allowedClientIds.length?await db("tm_client_gallery?client_id=in.("+allowedClientIds.map((x:string)=>encodeURIComponent(x)).join(",")+")&select=id,client_id,studio_id,file_path,caption,mime_type,created_at&order=created_at.desc"): [];
  const gallery=await Promise.all((galleryRows||[]).map(async(g:any)=>{const signedUrl=await cachedSignedUrl("tm-client-gallery",g.file_path);return {id:g.id,caption:g.caption,mime_type:g.mime_type,created_at:g.created_at,url:signedUrl};}));
  const clientReferenceRows=allowedClientIds.length?await db("tm_client_references?client_id=in.("+allowedClientIds.map((x:string)=>encodeURIComponent(x)).join(",")+")&select=id,client_id,studio_id,file_path,mime_type,comment,created_at&order=created_at.desc"): [];
  const clientReferences=await Promise.all((clientReferenceRows||[]).map(async(g:any)=>{const signedUrl=await cachedSignedUrl("tm-client-references",g.file_path);return {id:g.id,comment:g.comment,created_at:g.created_at,url:signedUrl};}));
  const referralRewards=await db("tm_referrals?referrer_telegram_user_id=eq."+user.id+"&status=in.(earned,redeemed)&select=id,reward_amount,status,earned_at,created_at&order=earned_at.asc");
  const referralTransactions=allowedClientIds.length?await db("tm_referral_transactions?client_id=in.("+allowedClientIds.map((x:string)=>encodeURIComponent(x)).join(",")+")&select=id,client_id,transaction_type,amount,note,created_at&order=created_at.desc"): [];
  const clientReferralHistory=[...(referralRewards||[]).map((r:any)=>({...r,type:"earned"})),...(referralTransactions||[]).map((r:any)=>({id:r.id,type:r.transaction_type||"redeemed",reward_amount:Math.abs(Number(r.amount)||0),note:r.note||null,created_at:r.created_at}))];
  return out({role:"client",profile:p?.[0]||null,studios,appointments:a,calendarEvents:calendarEvents||[],masters:clientMasters,gallery,references:clientReferences,referralRewards:clientReferralHistory});
 }
 if(req.method==="DELETE"){
   const raw=await req.text();const b=raw?JSON.parse(raw):{};const id=String(b.id||new URL(req.url).searchParams.get("id")||"");
   if(!/^[0-9a-f-]{36}$/i.test(id))return out({error:"INVALID_APPOINTMENT_ID"},400);
   const own=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");if(!own?.length)return out({error:"MASTER_NOT_LINKED"},403);
   const studioId=String(own[0].id);
   const found=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+encodeURIComponent(studioId)+"&select=id,status");
   if(!found?.length)return out({error:"APPOINTMENT_NOT_FOUND"},404);
   await db("tm_tasks?appointment_id=eq."+encodeURIComponent(id)+"&studio_id=eq."+encodeURIComponent(studioId),{method:"PATCH",body:JSON.stringify({appointment_id:null,updated_at:new Date().toISOString()})});
   await db("tm_referrals?or=(referred_appointment_id.eq."+encodeURIComponent(id)+",reward_appointment_id.eq."+encodeURIComponent(id)+")&studio_id=eq."+encodeURIComponent(studioId),{method:"PATCH",body:JSON.stringify({referred_appointment_id:null,reward_appointment_id:null})});
   const removed=await db("tm_appointments?id=eq."+encodeURIComponent(id)+"&studio_id=eq."+encodeURIComponent(studioId),{method:"DELETE"});
   if(!removed?.length)return out({error:"APPOINTMENT_DELETE_FAILED"},500);
   return out({ok:true,deleted_id:id});
  }
 if(req.method==="PATCH"){const b=await req.json(),s=await db("tm_studios?owner_telegram_user_id=eq."+user.id+"&select=id");if(!s?.length)return out({error:"MASTER_NOT_LINKED"},403);if(b.status!==undefined&&!["confirmed","declined","cancelled","completed"].includes(b.status))return out({error:"INVALID_STATUS"},400);const before=await db("tm_appointments?id=eq."+encodeURIComponent(String(b.id))+"&studio_id=eq."+s[0].id+"&select=*");if(!before?.length)return out({error:"APPOINTMENT_NOT_FOUND"},404);if(b.status==="confirmed"&&before[0].status==="pending"&&before[0].client_confirmation_required===true)return out({error:"CLIENT_CONFIRMATION_REQUIRED"},409);const patch:any={updated_at:new Date().toISOString()};if(b.status!==undefined){patch.status=b.status;if(["confirmed","declined","cancelled","completed"].includes(String(b.status)))patch.client_confirmation_required=false;}if(b.price!==undefined){const price=Number(b.price);if(!Number.isFinite(price)||price<0||price>100000000||price<Number(before[0].deposit_amount||0))return out({error:"INVALID_PRICE_OR_BELOW_DEPOSIT"},400);patch.price=price;}if(b.deposit_amount!==undefined){const deposit=Number(b.deposit_amount),total=Number(b.price!==undefined?b.price:before[0].price||0);if(!Number.isFinite(deposit)||deposit<0||deposit>100000000||deposit>total)return out({error:"INVALID_DEPOSIT_AMOUNT"},400);patch.deposit_amount=deposit;patch.deposit_paid_at=deposit>0?new Date().toISOString():null;}const a=await db("tm_appointments?id=eq."+encodeURIComponent(String(b.id))+"&studio_id=eq."+s[0].id,{method:"PATCH",body:JSON.stringify(patch)});if(!a?.length)return out({error:"APPOINTMENT_NOT_FOUND"},404);if(b.status!==undefined&&b.status!=="completed"&&before[0].status!==b.status&&(a[0].client_id||a[0].client_telegram_user_id)){const labels:Record<string,string>={confirmed:"подтверждена",declined:"отклонена",cancelled:"отменена"};const clientId=String(a[0].client_id||"");if(clientId){const linked=await db("tm_clients?id=eq."+encodeURIComponent(clientId)+"&studio_id=eq."+encodeURIComponent(String(a[0].studio_id))+"&select=preferred_notification_channel");if(String(linked?.[0]?.preferred_notification_channel||"telegram")!=="vk")await notifyClient(String(a[0].studio_id),clientId,Number(a[0].client_telegram_user_id||0)||null,"📌 Изменение записи\nВаша запись "+(labels[b.status]||"обновлена")+"."+((a[0].requested_date&&a[0].requested_time)?"\nДата и время: "+a[0].requested_date+" в "+a[0].requested_time:""));}}if(b.status==="completed"&&before[0].status!=="completed"&&(a[0].client_id||a[0].client_telegram_user_id)){
 let linkedClientId=a[0].client_id||null;
 let clientTelegramId=Number(a[0].client_telegram_user_id||0)||null;
 let linkedClient=null;
 if(linkedClientId){
  const linked=await db("tm_clients?id=eq."+encodeURIComponent(String(linkedClientId))+"&studio_id=eq."+encodeURIComponent(String(a[0].studio_id))+"&select=id,telegram_user_id,vk_user_id,preferred_notification_channel,notifications_enabled");
  linkedClient=linked?.[0]||null;
  if(!clientTelegramId&&linkedClient?.telegram_user_id)clientTelegramId=Number(linkedClient.telegram_user_id)||null;
 }
 if(!linkedClientId&&clientTelegramId){
  const linked=await db("tm_clients?studio_id=eq."+encodeURIComponent(String(a[0].studio_id))+"&telegram_user_id=eq."+clientTelegramId+"&select=id,telegram_user_id,vk_user_id,preferred_notification_channel,notifications_enabled");
  linkedClient=linked?.[0]||null;linkedClientId=linkedClient?.id||null;
 }
 if((linkedClientId&&(clientTelegramId||linkedClient?.vk_user_id))||(!linkedClientId&&clientTelegramId)){
  const appointmentText=[a[0].project_type,a[0].body_placement,a[0].idea].filter(Boolean).join(" ").toLowerCase();
  const appointmentKind=/(коррек|доработ|продолжение существующей работы)/i.test(appointmentText)?"correction":/(консультац|разработк.*эскиз|эскиз)/i.test(appointmentText)?"consult":/(ученик|обучен|практика)/i.test(appointmentText)?"student":/(модел)/i.test(appointmentText)?"model":"session";
  const completionVariants:Record<string,string[]>={
   session:[
    "🖤 СПАСИБО ЗА СЕАНС!\\n\\nСегодня мы завершили работу над вашей татуировкой. Теперь начинается важный этап — заживление.\\n\\n• Следуйте индивидуальной инструкции мастера.\\n• Поддерживайте чистоту участка.\\n• Не сдирайте корочки и не трите кожу.\\n• Избегайте трения и других воздействий, о которых предупредил мастер.\\n\\nЕсли появятся вопросы, напишите мне. Берегите новую татуировку!",
    "🖤 ВАША ТАТУИРОВКА ГОТОВА!\\n\\nСпасибо за доверие и сегодняшний сеанс. Чтобы результат хорошо зажил, придерживайтесь рекомендаций, которые я вам дал.\\n\\nНе травмируйте участок, не сдирайте корочки и соблюдайте гигиену. При любых сомнениях по заживлению лучше сразу связаться со мной.\\n\\nДо новых творческих встреч!",
    "🖤 БЛАГОДАРЮ ЗА ВЫБОР RAMZES!\\n\\nРабота завершена — теперь дайте коже спокойно восстановиться.\\n\\nПомните об индивидуальном уходе: чистые руки, аккуратное обращение с татуировкой и никаких самостоятельных попыток ускорить заживление.\\n\\nЕсли что-то насторожит или понадобится совет, я на связи. Спасибо за сеанс!"
,
    "🖤 СЕАНС ЗАВЕРШЁН — СПАСИБО ЗА ДОВЕРИЕ!\\\n\\\nСегодня ваша идея стала частью реальности. Теперь самое важное — спокойно пройти этап заживления.\\\n\\\nДержите участок в чистоте, не трите и не травмируйте кожу, не снимайте корочки. Следуйте именно той инструкции, которую я вам выдал.\\\n\\\nЕсли что-то смутит или понадобится совет, напишите мне. Пусть новая работа радует вас долгие годы!",
    "🖤 НОВАЯ ТАТУИРОВКА — НОВАЯ ИСТОРИЯ!\\\n\\\nСпасибо, что доверили мне воплотить вашу задумку. Работа закончена, а теперь дайте коже время на восстановление.\\\n\\\nСоблюдайте рекомендации по уходу, избегайте трения и не пытайтесь ускорить заживление самостоятельно.\\\n\\\nЯ на связи, если появятся вопросы. До новых встреч!",
    "🖤 БЛАГОДАРЮ ЗА СЕГОДНЯШНИЙ ДЕНЬ!\\\n\\\nБыло приятно поработать над вашей татуировкой. Чтобы сохранить результат, внимательно отнеситесь к периоду заживления.\\\n\\\nНе трогайте участок грязными руками, не сдирайте корочки и придерживайтесь индивидуальной памятки.\\\n\\\nЕсли понадобится помощь или рекомендация, просто напишите.",
    "🖤 ВАША ИДЕЯ ТЕПЕРЬ НА КОЖЕ!\\\n\\\nСпасибо за доверие и комфортную работу на сеансе. Теперь позаботьтесь о татуировке так, как мы обсудили.\\\n\\\nЧистота, бережное отношение и соблюдение инструкции мастера — главные правила на ближайшее время. Не травмируйте и не трите участок.\\\n\\\nБудут вопросы — я рядом!",
    "🖤 СПАСИБО, ЧТО ВЫБРАЛИ МЕНЯ!\\\n\\\nСеанс завершён, и теперь начинается восстановление кожи. Пожалуйста, не пренебрегайте рекомендациями по уходу.\\\n\\\nНе сдирайте корочки, не расчёсывайте татуировку и избегайте действий, о которых мы говорили.\\\n\\\nЕсли заживление вызывает вопросы, свяжитесь со мной — помогу разобраться.",
    "🖤 ЕЩЁ ОДНА ИСТОРИЯ НАЧАЛАСЬ!\\\n\\\nСпасибо, что пришли со своей идеей и доверили её мне. Надеюсь, результат будет радовать вас долго.\\\n\\\nСейчас важно дать коже восстановиться: соблюдайте индивидуальную инструкцию, поддерживайте чистоту и не травмируйте участок.\\\n\\\nБуду рад вашим вопросам и обратной связи после заживления.",
    "🖤 СЕГОДНЯ МЫ СОЗДАЛИ НЕЧТО ОСОБЕННОЕ.\\\n\\\nСпасибо за доверие и проведённое вместе время. Теперь позвольте татуировке спокойно зажить.\\\n\\\nСледуйте рекомендациям мастера, не трите участок и не удаляйте корочки самостоятельно. Бережный уход поможет пройти восстановление.\\\n\\\nЕсли потребуется консультация по уходу, напишите мне."
   ],
   correction:[
    "💜 СПАСИБО ЗА ВИЗИТ НА КОРРЕКЦИЮ!\\n\\nМы доработали татуировку. Теперь важно дать коже восстановиться и оценить результат после заживления.\\n\\nСоблюдайте рекомендации по уходу за обработанным участком. Если появятся вопросы или сомнения, напишите мне.\\n\\nБуду рад увидеть итоговый результат!",
    "💜 КОРРЕКЦИЯ ЗАВЕРШЕНА!\\n\\nСпасибо, что вернулись и доверили мне финальные штрихи. Надеюсь, теперь работа выглядит именно так, как вы задумывали.\\n\\nПожалуйста, аккуратно ухаживайте за участком по инструкции мастера и не пропускайте этапы заживления. Я остаюсь на связи!",
    "💜 БЛАГОДАРЮ ЗА ПОВТОРНУЮ ВСТРЕЧУ!\\n\\nСегодня мы внесли необходимые доработки. Дайте коже спокойно зажить, не травмируйте участок и придерживайтесь выданных рекомендаций.\\n\\nЕсли после восстановления захотите показать результат или уточнить детали — буду рад вашему сообщению."
,
    "💜 ДОРАБОТКА ЗАВЕРШЕНА — СПАСИБО ЗА ДОВЕРИЕ!\\\n\\\nСегодня мы добавили необходимые штрихи к вашей татуировке. Теперь дайте коже восстановиться после процедуры.\\\n\\\nСоблюдайте рекомендации по уходу и не травмируйте обработанный участок. После заживления можно будет объективно оценить итог.\\\n\\\nЕсли появятся вопросы, я на связи.",
    "💜 РАДЫ БЫЛИ ВИДЕТЬ ВАС СНОВА!\\\n\\\nСпасибо, что вернулись ко мне для коррекции. Мы сделали ещё один шаг к желаемому результату.\\\n\\\nПожалуйста, ухаживайте за участком по выданной инструкции, избегайте трения и не торопите процесс восстановления.\\\n\\\nБуду ждать ваших впечатлений после заживления!",
    "💜 ФИНАЛЬНЫЕ ШТРИХИ НА МЕСТЕ!\\\n\\\nБлагодарю за терпение и повторный визит. Надеюсь, обновлённая работа теперь радует вас ещё больше.\\\n\\\nДайте коже спокойно восстановиться и следуйте рекомендациям мастера. Если что-то будет непонятно, напишите мне.",
    "💜 СПАСИБО ЗА ОБРАТНУЮ СВЯЗЬ И ДОВЕРИЕ!\\\n\\\nКоррекция выполнена. Ценю, что вы поделились своими пожеланиями и дали возможность довести работу до нужного результата.\\\n\\\nТеперь важно бережно ухаживать за обработанной зоной и дождаться полного заживления. Я остаюсь на связи!",
    "💜 МЫ СДЕЛАЛИ ЕЩЁ ОДИН ШАГ К ИДЕАЛЬНОМУ РЕЗУЛЬТАТУ!\\\n\\\nСпасибо за сегодняшний визит. Не забывайте, что после коррекции коже снова требуется время на восстановление.\\\n\\\nСоблюдайте индивидуальные рекомендации, не трите участок и не снимайте корочки. При вопросах обращайтесь.",
    "💜 БЛАГОДАРЮ ЗА ПОВТОРНЫЙ ВИЗИТ!\\\n\\\nСегодня мы уделили внимание деталям и завершили запланированную доработку. Пусть кожа спокойно восстановится.\\\n\\\nСледуйте инструкции по уходу, а после заживления оцените результат при обычном освещении. Буду рад обратной связи!",
    "💜 ВАША ТАТУИРОВКА СТАЛА ЕЩЁ БЛИЖЕ К ЗАДУМАННОМУ!\\\n\\\nСпасибо, что доверили мне коррекцию. Теперь не забывайте о бережном уходе за обработанным участком.\\\n\\\nНе травмируйте кожу и придерживайтесь рекомендаций мастера. Если понадобится совет, всегда можете написать."
   ],
   consult:[
    "💙 СПАСИБО ЗА КОНСУЛЬТАЦИЮ!\\n\\nРад, что мы смогли обсудить вашу идею и наметить направление будущей татуировки.\\n\\nЕсли захотите дополнить задумку, изменить детали или прислать референсы — напишите мне. Следующий шаг — согласовать эскиз, стоимость и дату.",
    "💙 БЫЛ РАД ОБСУДИТЬ ВАШУ ИДЕЮ!\\n\\nСпасибо за встречу и доверие. Обдумайте предложенные варианты, а если появятся новые пожелания или вопросы, смело пишите.\\n\\nКогда определимся с деталями проекта, подберём удобное время для сеанса.",
    "💙 НАШУ ВСТРЕЧУ ЗАВЕРШИЛИ — ИДЕЯ В РАБОТЕ!\\n\\nБлагодарю за интерес к моей работе. Если после консультации вспомните важные детали или найдёте подходящие примеры, отправьте их мне.\\n\\nПродолжим с согласования эскиза и плана будущей татуировки!"
,
    "💙 СПАСИБО, ЧТО НАШЛИ ВРЕМЯ ДЛЯ ВСТРЕЧИ!\\\n\\\nРад знакомству и возможности разобрать вашу задумку. После консультации можете спокойно обдумать формат, размер и расположение будущей татуировки.\\\n\\\nКогда будете готовы, напишите мне — согласуем эскиз, стоимость и дату.",
    "💙 ВАША ИДЕЯ ЗАСЛУЖИВАЕТ ВНИМАНИЯ!\\\n\\\nСпасибо за интересную беседу. Если найдёте дополнительные референсы или захотите уточнить детали, отправьте их в ответном сообщении.\\\n\\\nЯ помогу сформировать проект и определить дальнейшие шаги к сеансу.",
    "💙 БЛАГОДАРЮ ЗА ДОВЕРИЕ И ВОПРОСЫ!\\\n\\\nНадеюсь, встреча помогла лучше представить будущую татуировку. Не обязательно принимать решение сразу — дайте себе время всё обдумать.\\\n\\\nКогда появится ясность по идее, продолжим обсуждение эскиза и записи.",
    "💙 ПРИЯТНО БЫЛО ПОЗНАКОМИТЬСЯ!\\\n\\\nСпасибо, что поделились своей задумкой. Если после разговора появятся новые мысли, пожелания по стилю или примеры работ, присылайте их мне.\\\n\\\nБудем постепенно собирать проект и согласуем удобную дату.",
    "💙 ПЕРВЫЙ ШАГ К БУДУЩЕЙ ТАТУИРОВКЕ СДЕЛАН!\\\n\\\nБлагодарю за консультацию. Мы обсудили направление, а теперь можно уточнить детали и подготовить эскиз.\\\n\\\nНапишите, если захотите что-то дополнить или изменить. После согласования проекта определимся со временем сеанса.",
    "💙 СПАСИБО ЗА ИНТЕРЕС К МОЕЙ РАБОТЕ!\\\n\\\nРад, что мы смогли обсудить вашу задумку. Сохраните понравившиеся референсы и отметьте, что именно в них вам близко. Это поможет точнее сформировать будущий проект.\\\n\\\nБуду ждать вашего сообщения, когда будете готовы двигаться дальше.",
    "💙 НАДЕЮСЬ, КОНСУЛЬТАЦИЯ БЫЛА ПОЛЕЗНОЙ!\\\n\\\nСпасибо за встречу. Если захотите вернуться к обсуждению, уточнить стоимость или задать вопрос по подготовке, просто напишите.\\\n\\\nКогда все детали будут согласованы, подберём дату и начнём работу над вашей идеей."
   ],
   student:[
    "🧡 СПАСИБО ЗА СЕГОДНЯШНЕЕ ЗАНЯТИЕ!\\n\\nСегодня разобрали важные моменты и продвинулись ещё на один шаг. Теперь закрепи материал самостоятельно и обрати внимание на ошибки, которые мы обсудили.\\n\\nПрактика, терпение и аккуратность — основа роста. До следующего занятия!",
    "🧡 ЕЩЁ ОДИН ШАГ В ОБУЧЕНИИ СДЕЛАН!\\n\\nСпасибо за старание и включённость. Повтори сегодняшний материал, потренируй отдельные движения и запиши вопросы, которые появятся во время практики.\\n\\nНа следующей встрече разберём результаты вместе!",
    "🧡 БЛАГОДАРЮ ЗА РАБОТУ НА ЗАНЯТИИ!\\n\\nНе стремись освоить всё за один день: лучше спокойно отработать базу и закрепить правильную технику.\\n\\nПовтори упражнения, следи за аккуратностью и не бойся задавать вопросы. Увидимся на следующем занятии!"
,
    "🧡 ЗАНЯТИЕ ЗАВЕРШЕНО — ВРЕМЯ ЗАКРЕПИТЬ РЕЗУЛЬТАТ!\\\n\\\nСпасибо за работу сегодня. Повтори основные этапы, которые мы разобрали, и отдельно потренируй то, что пока вызывает затруднения.\\\n\\\nНе торопись: точность и стабильность важнее скорости. До следующей встречи!",
    "🧡 ХОРОШАЯ РАБОТА СЕГОДНЯ!\\\n\\\nКаждое занятие складывается в опыт. Пересмотри заметки, вспомни замечания и выдели время на спокойную самостоятельную практику.\\\n\\\nЕсли при выполнении упражнения возникнут вопросы, запиши их — разберём вместе.",
    "🧡 СПАСИБО ЗА ВОВЛЕЧЁННОСТЬ!\\\n\\\nСегодня ты получил(а) новые ориентиры для практики. Главное теперь — повторить материал и закрепить правильную последовательность действий.\\\n\\\nОшибки — часть обучения. Анализируй их и двигайся дальше шаг за шагом!",
    "🧡 ЕСТЬ ПРОГРЕСС — ПРОДОЛЖАЕМ!\\\n\\\nБлагодарю за старание на занятии. Не сравнивай свой темп с чужим: сосредоточься на качестве каждого движения и аккуратности.\\\n\\\nПотренируй разобранные элементы и приходи с вопросами на следующую встречу.",
    "🧡 СЕГОДНЯШНЯЯ ПРАКТИКА ПОЗАДИ!\\\n\\\nСпасибо за усердие. Чтобы знания не остались только теорией, повтори пройденное и попробуй применить рекомендации в упражнениях.\\\n\\\nРаботай внимательно, соблюдай последовательность и не пропускай базовые этапы.",
    "🧡 ЕЩЁ ОДНО ЗАНЯТИЕ В КОПИЛКУ ОПЫТА!\\\n\\\nТы продвигаешься благодаря регулярной практике. Вспомни, что сегодня получилось лучше всего, а что стоит повторить ещё раз.\\\n\\\nЗапиши наблюдения — так мы сможем точнее выстроить следующее занятие.",
    "🧡 БЛАГОДАРЮ ЗА СЕГОДНЯШНЮЮ РАБОТУ!\\\n\\\nПусть сегодняшний материал постепенно станет привычным навыком. Повтори упражнения без спешки и удели внимание тем моментам, на которые я указал.\\\n\\\nДо следующего занятия — продолжаем развиваться!"
   ],
   model:[
    "💚 СПАСИБО, ЧТО СТАЛИ МОДЕЛЬЮ!\\n\\nБлагодарю за доверие и участие в творческом проекте. Благодаря вам идея стала реальной работой.\\n\\nПожалуйста, соблюдайте индивидуальные рекомендации по уходу за татуировкой. Буду рад увидеть результат после заживления!",
    "💚 ВЫ ПОМОГЛИ СОЗДАТЬ ЧТО-ТО ОСОБЕННОЕ!\\n\\nСпасибо за смелость, открытость и участие в качестве модели. Теперь дайте коже спокойно восстановиться и придерживайтесь инструкции мастера.\\n\\nЕсли возникнут вопросы по уходу, обязательно напишите. И спасибо за доверие!",
    "💚 БЛАГОДАРЮ ЗА УЧАСТИЕ В ПРОЕКТЕ!\\n\\nМне было приятно воплотить эту идею вместе с вами. Надеюсь, новая татуировка будет радовать вас долго.\\n\\nСоблюдайте рекомендации по заживлению и не стесняйтесь обращаться, если понадобится моя помощь. До новых встреч!"
,
    "💚 СПАСИБО ЗА ДОВЕРИЕ И УЧАСТИЕ!\\\n\\\nБлагодаря вам мы смогли реализовать творческую задумку. Очень ценю готовность стать частью проекта.\\\n\\\nТеперь соблюдайте рекомендации по уходу за татуировкой и дайте коже спокойно восстановиться. Буду рад увидеть заживший результат!",
    "💚 ВЫ СТАЛИ ЧАСТЬЮ ТВОРЧЕСКОГО ПРОЦЕССА!\\\n\\\nСпасибо за открытость и участие в качестве модели. Надеюсь, новая работа принесёт вам много положительных эмоций.\\\n\\\nПожалуйста, придерживайтесь индивидуальной инструкции по уходу. Если возникнут вопросы, напишите мне.",
    "💚 БЛАГОДАРЮ ЗА СМЕЛОСТЬ И ДОВЕРИЕ!\\\n\\\nСегодня мы вместе воплотили идею в татуировку. Спасибо, что помогли этому проекту состояться.\\\n\\\nБережно ухаживайте за кожей, не травмируйте участок и соблюдайте рекомендации мастера. До новых встреч!",
    "💚 СПАСИБО, ЧТО ПОМОГЛИ МОЕМУ ПРОЕКТУ!\\\n\\\nВаше участие очень ценно. Теперь самое важное — дать татуировке правильно зажить.\\\n\\\nСледуйте выданной инструкции, поддерживайте чистоту и не пытайтесь ускорить восстановление. Буду благодарен за фото результата после заживления!",
    "💚 НАША ТВОРЧЕСКАЯ ВСТРЕЧА СОСТОЯЛАСЬ!\\\n\\\nСпасибо за доверие и время. Было приятно работать над этой идеей вместе с вами.\\\n\\\nНе забывайте об уходе за новой татуировкой: придерживайтесь рекомендаций и обращайтесь, если появятся вопросы.",
    "💚 ВАШЕ УЧАСТИЕ СДЕЛАЛО ЭТОТ ПРОЕКТ ВОЗМОЖНЫМ!\\\n\\\nИскренне благодарю за готовность стать моделью. Надеюсь, результат будет радовать вас и после полного заживления.\\\n\\\nСоблюдайте индивидуальные рекомендации мастера и берегите кожу.",
    "💚 СПАСИБО, ЧТО СТАЛИ ЧАСТЬЮ ЭТОЙ ИСТОРИИ!\\\n\\\nЦеню ваше доверие и возможность воплотить задумку. Теперь позаботьтесь о татуировке и дайте коже время на восстановление.\\\n\\\nЕсли понадобится подсказка по уходу, напишите. Буду рад увидеть итог после заживления!"
   ]
  };
  const variants=completionVariants[appointmentKind]||completionVariants.session;
  let previousVariant=-1;
  const history=await db("tm_client_message_queue?telegram_user_id=eq."+encodeURIComponent(String(clientTelegramId))+"&message_type=like.completion_"+appointmentKind+"_%&select=message_type&order=created_at.desc&limit=1");
  const match=String(history?.[0]?.message_type||"").match(new RegExp("^completion_"+appointmentKind+"_(\\d+)$"));
  if(match)previousVariant=Number(match[1]);
  const variantIndex=previousVariant<0?0:(previousVariant+1)%variants.length;
  const sent=linkedClientId?await notifyClient(String(a[0].studio_id),linkedClientId,clientTelegramId,variants[variantIndex]):await notifyTelegram(clientTelegramId,variants[variantIndex],"client");
  if(sent){
   const now=new Date().toISOString();
   await db("tm_client_message_queue",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify({message_type:"completion_"+appointmentKind+"_"+variantIndex,studio_id:a[0].studio_id,client_id:linkedClientId||null,target_type:"appointment",target_id:a[0].id,telegram_user_id:clientTelegramId,scheduled_at:now,sent_at:now})});
  }
 }
 if(linkedClientId&&(clientTelegramId||linkedClient?.vk_user_id)){
  const reviewAt=new Date(Date.now()+14*24*60*60*1000).toISOString();
  const correctionAt=new Date(Date.now()+30*24*60*60*1000).toISOString();
  const returnAt=new Date(Date.now()+60*24*60*60*1000).toISOString();
  await db("tm_client_message_queue?on_conflict=message_type,target_type,target_id,scheduled_at",{method:"POST",headers:{"Prefer":"resolution=ignore-duplicates,return=representation"},body:JSON.stringify([
   {message_type:"review",studio_id:a[0].studio_id,client_id:linkedClientId,target_type:"appointment",target_id:a[0].id,telegram_user_id:Number(linkedClient?.telegram_user_id||0),channel:String(linkedClient?.preferred_notification_channel||"telegram"),scheduled_at:reviewAt},
   {message_type:"correction_reminder",studio_id:a[0].studio_id,client_id:linkedClientId,target_type:"appointment",target_id:a[0].id,telegram_user_id:Number(linkedClient?.telegram_user_id||0),channel:String(linkedClient?.preferred_notification_channel||"telegram"),scheduled_at:correctionAt},
   {message_type:"return_reminder",studio_id:a[0].studio_id,client_id:linkedClientId,target_type:"appointment",target_id:a[0].id,telegram_user_id:Number(linkedClient?.telegram_user_id||0),channel:String(linkedClient?.preferred_notification_channel||"telegram"),scheduled_at:returnAt}
  ])});
 }
}
 if(b.status==="completed"&&before[0].status!=="completed"){
  const referrals=await db("tm_referrals?referred_appointment_id=eq."+encodeURIComponent(String(a[0].id))+"&status=eq.pending&select=id,referrer_telegram_user_id,reward_amount");
  for(const referral of referrals||[]){
   const earned=await db("tm_referrals?id=eq."+encodeURIComponent(referral.id)+"&status=eq.pending",{method:"PATCH",body:JSON.stringify({status:"earned",earned_at:new Date().toISOString()})});
   if(earned?.length){await db("tm_user_profiles?telegram_user_id=eq."+Number(a[0].client_telegram_user_id),{method:"PATCH",body:JSON.stringify({referral_code:null,updated_at:new Date().toISOString()})});await notifyTelegram(Number(referral.referrer_telegram_user_id),"🎉 Ваш друг успешно завершил первый сеанс! Вам начислена скидка "+Math.round(Number(referral.reward_amount)||3000).toLocaleString("ru-RU")+" ₽ на следующий сеанс. Скидка отображается в вашем кабинете клиента.","client");}
  }
 }
 if(["cancelled","declined"].includes(b.status)&&before[0].status!==b.status){
  await db("tm_referrals?referred_appointment_id=eq."+encodeURIComponent(String(a[0].id))+"&status=eq.pending",{method:"PATCH",body:JSON.stringify({status:"cancelled"})});
 }
 return out({ok:true,appointment:a[0]})}
 return out({error:"METHOD_NOT_ALLOWED"},405)
 }catch(e){const m=e instanceof Error?e.message:"UNKNOWN_ERROR";console.error("AUTH_FAILURE",m);return out({error:m},m.includes("TELEGRAM")?401:500)}});
