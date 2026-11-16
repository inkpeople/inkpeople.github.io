import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"content-type, x-telegram-init-data","Access-Control-Allow-Methods":"POST, OPTIONS"};
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
 const raw=p.get("user");if(!raw)throw new Error("TELEGRAM_USER_MISSING");return JSON.parse(raw) as {id:number};
}
const base=Deno.env.get("SUPABASE_URL")!,serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function db(path:string,init:RequestInit={}){const r=await fetch(base+"/rest/v1/"+path,{...init,headers:{apikey:serviceKey,Authorization:"Bearer "+serviceKey,"Content-Type":"application/json",Prefer:"return=representation",...(init.headers||{})}});const t=await r.text();if(!r.ok)throw new Error("DATABASE_ERROR_"+r.status+": "+t);return t?JSON.parse(t):null}
async function sha(s:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}
function randomHex(n=32){const b=crypto.getRandomValues(new Uint8Array(n));return [...b].map(x=>x.toString(16).padStart(2,"0")).join("")}
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 try{
  if(req.method!=="POST")return out({error:"METHOD_NOT_ALLOWED"},405);
  const user=await telegramUser(req.headers.get("x-telegram-init-data")||"");
  const body=await req.json();const action=String(body.action||"");
  const studios=await db("tm_studios?owner_telegram_user_id=eq."+encodeURIComponent(String(user.id))+"&select=id,owner_telegram_user_id");
  if(!studios?.length)return out({error:"MASTER_NOT_LINKED"},403);
  const studio=studios[0];const clientId=Deno.env.get("YANDEX_CLIENT_ID");
  if(!clientId)return out({error:"YANDEX_CLIENT_ID_NOT_CONFIGURED"},500);
  if(action==="start"){
   const state=randomHex(32),stateHash=await sha(state),expires=new Date(Date.now()+10*60*1000).toISOString();
   const existing=await db("tm_calendar_connections?studio_id=eq."+studio.id+"&select=studio_id");
   const payload={studio_id:studio.id,owner_telegram_user_id:user.id,provider:"yandex",oauth_state_hash:stateHash,oauth_state_expires_at:expires,updated_at:new Date().toISOString()};
   if(existing?.length)await db("tm_calendar_connections?studio_id=eq."+studio.id,{method:"PATCH",body:JSON.stringify(payload)});
   else await db("tm_calendar_connections",{method:"POST",body:JSON.stringify(payload)});
   const redirect="https://ndetzxmpkfqcbzftaxtv.supabase.co/functions/v1/tattoo-calendar-yandex-callback";
   const url=new URL("https://oauth.yandex.ru/authorize");url.searchParams.set("response_type","code");url.searchParams.set("client_id",clientId);url.searchParams.set("redirect_uri",redirect);url.searchParams.set("state",state);
   return out({ok:true,authorize_url:url.toString()});
  }
  if(action==="status"){
   const rows=await db("tm_calendar_connections?studio_id=eq."+studio.id+"&select=account_email,connected_at");
   return out({connected:!!rows?.[0]?.connected_at,email:rows?.[0]?.account_email||null,connected_at:rows?.[0]?.connected_at||null});
  }
  if(action==="disconnect"){
   await db("tm_calendar_connections?studio_id=eq."+studio.id,{method:"DELETE"});
   return out({ok:true});
  }
  return out({error:"UNKNOWN_ACTION"},400);
 }catch(e){const m=e instanceof Error?e.message:"INTERNAL_ERROR";const status=/INVALID_TELEGRAM|TELEGRAM_INIT_DATA|TELEGRAM_USER/.test(m)?401:500;console.error("YANDEX_CALENDAR_API",m);return out({error:m},status)}
});