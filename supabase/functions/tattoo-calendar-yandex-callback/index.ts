import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const base=Deno.env.get("SUPABASE_URL")!,serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL="https://inkpeople.github.io/tattoo-manager-v2/";
async function db(path:string,init:RequestInit={}){const r=await fetch(base+"/rest/v1/"+path,{...init,headers:{apikey:serviceKey,Authorization:"Bearer "+serviceKey,"Content-Type":"application/json",Prefer:"return=representation",...(init.headers||{})}});const t=await r.text();if(!r.ok)throw new Error("DATABASE_ERROR_"+r.status+": "+t);return t?JSON.parse(t):null}
async function sha(s:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function encryptionKey(){const seed=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");if(!seed)throw new Error("SERVICE_ROLE_KEY_MISSING");const raw=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(seed+"|tattoo-manager-yandex-calendar-v1"));return crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["encrypt","decrypt"])}
async function encryptToken(token:string){const iv=crypto.getRandomValues(new Uint8Array(12));const key=await encryptionKey();const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(token)));const all=new Uint8Array(iv.length+encrypted.length);all.set(iv);all.set(encrypted,iv.length);let binary="";for(const b of all)binary+=String.fromCharCode(b);return btoa(binary)}
function redirect(status:string){return Response.redirect(APP_URL+"?yandex_calendar="+encodeURIComponent(status),302)}
Deno.serve(async req=>{
 try{
  const u=new URL(req.url),code=u.searchParams.get("code"),state=u.searchParams.get("state"),error=u.searchParams.get("error");
  if(error)return redirect("error");
  if(!code||!state)return redirect("invalid");
  const stateHash=await sha(state);
  const rows=await db("tm_calendar_connections?oauth_state_hash=eq."+stateHash+"&select=studio_id,owner_telegram_user_id,oauth_state_expires_at");
  const row=rows?.[0];if(!row||!row.oauth_state_expires_at||new Date(row.oauth_state_expires_at).getTime()<Date.now())return redirect("expired");
  const clientId=Deno.env.get("YANDEX_CLIENT_ID"),clientSecret=Deno.env.get("YANDEX_CLIENT_SECRET");
  if(!clientId||!clientSecret)throw new Error("YANDEX_OAUTH_SECRETS_MISSING");
  const form=new URLSearchParams({grant_type:"authorization_code",code,client_id:clientId,client_secret:clientSecret,redirect_uri:"https://jgzzdsittnzomedvsspj.supabase.co/functions/v1/tattoo-calendar-yandex-callback"});
  const tokenResponse=await fetch("https://oauth.yandex.ru/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form});
  const tokenData=await tokenResponse.json();if(!tokenResponse.ok||!tokenData.access_token){console.error("YANDEX_TOKEN_EXCHANGE_FAILED",tokenData);return redirect("token_error")}
  const infoResponse=await fetch("https://login.yandex.ru/info?format=json",{headers:{Authorization:"OAuth "+tokenData.access_token}});
  const info=infoResponse.ok?await infoResponse.json():{};
  const email=String(info.default_email||info.emails?.[0]||"").trim();
  const encrypted=await encryptToken(String(tokenData.access_token));
  await db("tm_calendar_connections?studio_id=eq."+row.studio_id,{method:"PATCH",body:JSON.stringify({account_email:email||null,access_token_encrypted:encrypted,token_expires_at:tokenData.expires_in?new Date(Date.now()+Number(tokenData.expires_in)*1000).toISOString():null,oauth_state_hash:null,oauth_state_expires_at:null,connected_at:new Date().toISOString(),updated_at:new Date().toISOString()})});
  return redirect("connected");
 }catch(e){console.error("YANDEX_CALENDAR_CALLBACK",e);return redirect("error")}
});