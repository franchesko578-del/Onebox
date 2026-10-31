interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  BOT_USERNAME: string;
  JWT_SECRET: string;
  WEB_APP_URL: string;
}

type User = { id: string; telegram_id: string; username?: string; first_name?: string; last_name?: string };

const cors = (origin: string) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
});

function json(data: unknown, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin) }
  });
}
function uid() { return crypto.randomUUID(); }
function b64url(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
async function hmac(keyBytes: Uint8Array, data: string) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}
function hex(bytes: Uint8Array) { return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join(""); }

async function verifyTelegramInitData(initData: string, botToken: string): Promise<User | null> {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const pairs = [...params.entries()].sort(([a],[b])=>a.localeCompare(b));
  const dataCheckString = pairs.map(([k,v])=>`${k}=${v}`).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), botToken);
  const calculated = hex(await hmac(secret, dataCheckString));
  if (calculated.length !== hash.length) return null;
  let mismatch = 0;
  for (let i=0;i<hash.length;i++) mismatch |= calculated.charCodeAt(i) ^ hash.charCodeAt(i);
  if (mismatch !== 0) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Math.abs(Date.now()/1000-authDate) > 86400) return null;
  try {
    const raw = params.get("user");
    if (!raw) return null;
    const u = JSON.parse(raw);
    if (!u.id) return null;
    return { id: String(u.id), telegram_id: String(u.id), username: u.username, first_name: u.first_name, last_name: u.last_name };
  } catch { return null; }
}

async function signSession(user: User, secret: string) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ sub:user.id, exp:Math.floor(Date.now()/1000)+86400 })));
  const sig = b64url(await hmac(new TextEncoder().encode(secret), payload));
  return `${payload}.${sig}`;
}
async function verifySession(token: string, secret: string): Promise<string|null> {
  const [payload,sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = b64url(await hmac(new TextEncoder().encode(secret), payload));
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(atob(payload.replace(/-/g,"+").replace(/_/g,"/")));
    if (data.exp < Date.now()/1000) return null;
    return String(data.sub);
  } catch { return null; }
}
async function currentUser(request: Request, env: Env) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i,"") || "";
  return verifySession(token, env.JWT_SECRET);
}
async function hasWorkspaceAccess(db: D1Database, workspaceId: string, userId: string, write = false) {
  const row = await db.prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?")
    .bind(workspaceId,userId).first<{role:string}>();
  if (!row) return false;
  return write ? ["owner","admin","editor"].includes(row.role) : true;
}
async function telegramSend(env: Env, chatId: string|number, text: string, markup?: unknown) {
  if (!env.BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:chatId,text, ...(markup?{reply_markup:markup}:{})})
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";
    if (request.method === "OPTIONS") return new Response(null,{headers:cors(origin)});
    try {
      if (url.pathname === "/health") return json({ok:true,service:"ONEBOX API"},200,origin);

      if (url.pathname === "/telegram/webhook" && request.method === "POST") {
        const update:any = await request.json();
        const msg = update.message;
        if (msg?.text?.startsWith("/")) {
          const command = msg.text.split(/\s+/)[0].split("@")[0];
          if (command === "/start" || command === "/app") {
            await telegramSend(env,msg.chat.id,"ONEBOX — QR Studio va NoteSpace platformasi.",{
              inline_keyboard:[[{text:"ONEBOX ilovasini ochish",web_app:{url:env.WEB_APP_URL}}]]
            });
          } else if (command === "/help") {
            await telegramSend(env,msg.chat.id,"Buyruqlar: /start, /app, /help. Barcha funksiyalar Mini App ichida mavjud.");
          }
        }
        return json({ok:true},200,origin);
      }

      if (url.pathname === "/api/auth/telegram" && request.method === "POST") {
        const body:any = await request.json();
        const user = await verifyTelegramInitData(body.initData,env.BOT_TOKEN);
        if (!user) return json({error:"Telegram tasdiqlashi muvaffaqiyatsiz."},401,origin);
        const existing = await env.DB.prepare("SELECT id FROM users WHERE telegram_id=?").bind(user.telegram_id).first<{id:string}>();
        const id = existing?.id || uid();
        await env.DB.prepare(`INSERT INTO users(id,telegram_id,username,first_name,last_name,last_seen_at)
          VALUES(?,?,?,?,?,datetime('now'))
          ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,last_seen_at=datetime('now')`)
          .bind(id,user.telegram_id,user.username||null,user.first_name||null,user.last_name||null).run();
        await env.DB.prepare("INSERT OR IGNORE INTO user_settings(user_id) VALUES(?)").bind(id).run();
        const token = await signSession({...user,id},env.JWT_SECRET);
        return json({token,user:{id,telegram_id:user.telegram_id,first_name:user.first_name,username:user.username}},200,origin);
      }

      const userId = await currentUser(request,env);
      if (!userId) return json({error:"Autentifikatsiya talab qilinadi."},401,origin);

      if (url.pathname === "/api/me" && request.method === "GET") {
        const user = await env.DB.prepare("SELECT id,telegram_id,username,first_name,last_name,created_at FROM users WHERE id=?").bind(userId).first();
        return json({user},200,origin);
      }

      if (url.pathname === "/api/notes" && request.method === "GET") {
        const rows = await env.DB.prepare(`SELECT id,title,content,color,is_pinned,workspace_id,updated_at,created_at
          FROM notes WHERE owner_id=? AND deleted_at IS NULL ORDER BY is_pinned DESC,updated_at DESC LIMIT 100`).bind(userId).all();
        return json({notes:rows.results},200,origin);
      }
      if (url.pathname === "/api/notes" && request.method === "POST") {
        const b:any = await request.json();
        const title = String(b.title||"").slice(0,200);
        const content = String(b.content||"").slice(0,50000);
        if (b.workspace_id && !(await hasWorkspaceAccess(env.DB,String(b.workspace_id),userId,true))) return json({error:"Workspace ruxsati yo‘q."},403,origin);
        const id=uid();
        await env.DB.prepare("INSERT INTO notes(id,owner_id,workspace_id,title,content) VALUES(?,?,?,?,?)")
          .bind(id,userId,b.workspace_id||null,title,content).run();
        return json({id,title,content},201,origin);
      }

      if (url.pathname === "/api/workspaces" && request.method === "GET") {
        const rows=await env.DB.prepare(`SELECT w.id,w.name,w.description,m.role FROM workspaces w
          JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.created_at DESC`).bind(userId).all();
        return json({workspaces:rows.results},200,origin);
      }
      if (url.pathname === "/api/workspaces" && request.method === "POST") {
        const b:any=await request.json(); const name=String(b.name||"").trim().slice(0,80);
        if (!name) return json({error:"Workspace nomi kerak."},400,origin);
        const id=uid();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO workspaces(id,owner_id,name,description) VALUES(?,?,?,?)").bind(id,userId,name,String(b.description||"").slice(0,500)),
          env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(?,?, 'owner')").bind(id,userId)
        ]);
        return json({id,name,role:"owner"},201,origin);
      }

      if (url.pathname === "/api/qr" && request.method === "GET") {
        const rows=await env.DB.prepare("SELECT id,title,qr_type,payload,is_dynamic,slug,is_active,design_json,created_at FROM qr_codes WHERE owner_id=? ORDER BY created_at DESC LIMIT 100").bind(userId).all();
        return json({qr_codes:rows.results},200,origin);
      }
      if (url.pathname === "/api/qr" && request.method === "POST") {
        const b:any=await request.json();
        const title=String(b.title||"QR code").slice(0,100);
        const payload=String(b.payload||"").trim().slice(0,2000);
        const dynamic=Boolean(b.is_dynamic);
        if (!payload) return json({error:"QR ma’lumoti kiritilmagan."},400,origin);
        const id=uid(); const slug=dynamic?crypto.randomUUID().replace(/-/g,"").slice(0,20):null;
        await env.DB.prepare(`INSERT INTO qr_codes(id,owner_id,title,qr_type,payload,is_dynamic,slug,design_json)
          VALUES(?,?,?,?,?,?,?,?)`).bind(id,userId,title,String(b.qr_type||"url"),payload,dynamic?1:0,slug,JSON.stringify(b.design||{})).run();
        return json({id,title,payload,is_dynamic:dynamic,slug},201,origin);
      }

      const qrMatch=url.pathname.match(/^\/q\/([a-zA-Z0-9]+)$/);
      if (qrMatch && request.method==="GET") {
        const qr=await env.DB.prepare("SELECT id,payload,is_active FROM qr_codes WHERE slug=? AND is_dynamic=1").bind(qrMatch[1]).first<any>();
        if (!qr || !qr.is_active) return new Response("QR topilmadi yoki faol emas.",{status:404});
        await env.DB.prepare("INSERT INTO qr_scans(id,qr_id) VALUES(?,?)").bind(uid(),qr.id).run();
        return Response.redirect(qr.payload,302);
      }

      return json({error:"Endpoint topilmadi."},404,origin);
    } catch (err) {
      console.error("ONEBOX API error",err);
      return json({error:"Serverda xatolik yuz berdi."},500,origin);
    }
  },
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // Reminder delivery is intentionally a placeholder in this starter.
    // Next implementation stage will add due-time selection, Telegram delivery and idempotent logs.
    console.log("ONEBOX scheduled check", new Date().toISOString());
  }
};
