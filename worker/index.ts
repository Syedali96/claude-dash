// Claude Dash server (Cloudflare Worker). Every /api route needs your private
// APP_TOKEN, so only your glasses app can read your calendar and mail through it.
import Anthropic from "@anthropic-ai/sdk";
import { ask } from "./ask";
import { alerts, inbox } from "./gmail";
import { gymCommand, parseSet } from "./gym";
import { listen, listenTranscribe } from "./listen";
import { article, markets, news } from "./news";
import { bedtime, finishWhoop, startWhoop, whoopConnected, whoopText, whoopTip, whoopToday } from "./whoop";
import { ACCOUNTS, type AccountKey, agenda, finishAuth, isConnected, startAuth } from "./google";

export interface Env {
  TOKENS: KVNamespace;
  ANTHROPIC_API_KEY: string;
  APP_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GROQ_API_KEY: string;
  WHOOP_CLIENT_ID: string;
  WHOOP_CLIENT_SECRET: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });

function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(req: Request, url: URL, env: Env): boolean {
  const header = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return safeEqual(header || url.searchParams.get("token") || "", env.APP_TOKEN);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Google redirects back here; protected by the one-time state value instead.
    if (url.pathname === "/auth/google/callback") return finishAuth(env, url.origin, url.searchParams);
    if (url.pathname === "/auth/whoop/callback") return finishWhoop(env, url.origin, url.searchParams);

    // Public pages Google asks for on the consent screen.
    if (url.pathname === "/" || url.pathname === "/privacy") return publicPage(url.pathname);

    if (!authorized(req, url, env)) return json({ error: "Not authorized. Check the access token in settings." }, 401);

    try {
      switch (url.pathname) {
        case "/setup":
          return setupPage(env, url);
        case "/auth/google/start": {
          const account = url.searchParams.get("account") as AccountKey;
          if (!(account in ACCOUNTS)) return json({ error: "Unknown account" }, 400);
          return startAuth(env, url.origin, account);
        }
        case "/auth/whoop/start":
          if (!env.WHOOP_CLIENT_ID) return json({ error: "WHOOP client ID missing on the server." }, 500);
          return startWhoop(env, url.origin);
        case "/api/whoop": {
          const w = await whoopToday(env, ctx);
          if (!w) return json({ error: "not_connected" }, 409);
          const tz = url.searchParams.get("tz") || "America/New_York";
          return json({ ...w, ...bedtime(w, tz), tip: w.recovery != null ? await whoopTip(env, w).catch(() => "") : "" });
        }
        case "/api/status":
          return json({
            google: Object.fromEntries(
              await Promise.all((Object.keys(ACCOUNTS) as AccountKey[]).map(async (k) => [k, await isConnected(env, k)])),
            ),
            whoop: await whoopConnected(env),
            claude: !!env.ANTHROPIC_API_KEY,
          });
        case "/api/agenda": {
          const timeMin = url.searchParams.get("start");
          const timeMax = url.searchParams.get("end");
          if (!timeMin || !timeMax) return json({ error: "start and end are required" }, 400);
          const events = await agenda(env, timeMin, timeMax);
          if (!events) return json({ error: "not_connected" }, 409);
          return json({ events });
        }
        case "/api/inbox":
          if (!env.ANTHROPIC_API_KEY) return json({ error: "Claude key missing on the server." }, 500);
          return json(await inbox(env, url.searchParams.has("fresh"), ctx));
        case "/api/news":
          return json(await news(env, ctx));
        case "/api/ask":
          if (req.method !== "POST") return json({ error: "POST only" }, 405);
          return ask(req, env, ctx).then((r) => {
            const headers = new Headers(r.headers); // keeps text/plain + no-cache for the streamed reply
            for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
            return new Response(r.body, { status: r.status, headers });
          });
        case "/api/listen":
          if (req.method !== "POST") return json({ error: "POST only" }, 405);
          if (!env.GROQ_API_KEY) return json({ error: "Groq key missing on the server." }, 500);
          return listen(req, env);
        case "/api/listen/transcribe":
          if (req.method !== "POST") return json({ error: "POST only" }, 405);
          if (!env.GROQ_API_KEY) return json({ error: "Groq key missing on the server." }, 500);
          return json(await listenTranscribe(req, env, url));
        case "/api/markets":
          return json(await markets(env, ctx));
        case "/api/alerts": {
          const since = Number(url.searchParams.get("since")) || Math.floor(Date.now() / 1000) - 300;
          return json(await alerts(env, since));
        }
        case "/api/news/article":
          return json(await article(env, Number(url.searchParams.get("n") ?? 0)));
        case "/api/reminders":
          return reminders(req, env);
        case "/api/gym/parse":
          if (req.method !== "POST") return json({ error: "POST only" }, 405);
          return json(await parseSet(req, env));
        case "/api/gym/command":
          if (req.method !== "POST") return json({ error: "POST only" }, 405);
          return json(await gymCommand(req, env));
        case "/api/brief":
          return brief(req, env, ctx);
        default:
          return json({ error: "Not found" }, 404);
      }
    } catch (err) {
      console.error(url.pathname, err);
      return json({ error: err instanceof Error ? err.message : "Server error" }, 502);
    }
  },

  // Every 15 minutes (see "triggers" in wrangler.jsonc): rebuild the inbox, news and WHOOP
  // so the glasses always get a ready copy. Claude only re-runs when something changed.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const jobs: [string, () => Promise<unknown>][] = [
      ["inbox", () => (env.ANTHROPIC_API_KEY ? inbox(env, true) : Promise.resolve())],
      ["news", () => news(env)],
      ["whoop", () => whoopToday(env, undefined, true)],
      ["markets", () => markets(env)],
    ];
    ctx.waitUntil(Promise.all(jobs.map(([name, run]) => run().catch((e) => console.error("cron", name, e)))));
  },
} satisfies ExportedHandler<Env>;

// ---------- Claude brief ----------

interface BriefRequest {
  prompt: string;
  now: string;
  weather?: string;
  tasks: string[];
  gym?: string[]; // today's logged sets, e.g. "Bench Press 185x8"
  dayStart?: string; // ISO, the phone's local midnight
  dayEnd?: string;
  timeZone?: string; // e.g. "America/Los_Angeles"
}

const SYSTEM = `You suggest what a startup founder should do with the rest of their day, shown on smart glasses
(40 characters per line). Their reminders are already listed above your part, so don't repeat that list.
Write 3 to 5 bullets, each starting with "- ", in the order to do them. Each bullet is one clear action
in plain words that fits on ONE line: at most 38 characters including the "- ", e.g. "- Reply to Paul: 11/26 post time".
Draw on emails to answer or follow up, meetings to prep for (name the meeting, e.g. "before your 6pm with
Brandon"), reminders worth doing first, and the gym matched to their WHOOP recovery.
Never give clock times for tasks. No headers, no markdown, no emoji. Never invent meetings or tasks.`;

// ---------- iPhone Reminders (sent by an iOS Shortcut) ----------

async function reminders(req: Request, env: Env): Promise<Response> {
  if (req.method === "GET") return json(JSON.parse((await env.TOKENS.get("reminders:today")) ?? '{"items":[]}'));
  if (req.method !== "POST") return json({ error: "GET or POST" }, 405);
  // Accept {"items": [...]}, {"items": "one\ntwo"}, or plain text with one reminder per line.
  const raw = await req.text();
  let items: unknown;
  try { items = (JSON.parse(raw) as { items?: unknown }).items; } catch { items = raw; }
  const list = (Array.isArray(items) ? items.map(String) : String(items ?? "").split("\n"))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40);
  await env.TOKENS.put("reminders:today", JSON.stringify({ items: list, at: new Date().toISOString() }));
  return json({ ok: true, count: list.length });
}

async function dayContext(env: Env, body: BriefRequest, ctx: ExecutionContext): Promise<string> {
  const lines = [`Now: ${body.now}`];
  if (body.weather) lines.push(`Weather: ${body.weather}`);
  const [events, whoop, ib] = await Promise.all([
    body.dayStart && body.dayEnd ? agenda(env, body.dayStart, body.dayEnd).catch(() => null) : null,
    whoopToday(env, ctx).catch(() => null),
    inbox(env, false, ctx).catch(() => null), // the saved copy (kept fresh by the timer)
  ]);
  if (events) {
    const left = events.filter((e) => e.allDay || new Date(e.end).getTime() > Date.now());
    const tz = body.timeZone || "UTC";
    const fmt = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
    lines.push(
      left.length
        ? `Meetings left today:\n${left.map((e) => `- ${e.allDay ? "all day" : `${fmt(e.start)}-${fmt(e.end)}`} ${e.title}`).join("\n")}`
        : "Meetings left today: none",
    );
  }
  lines.push(whoop ? `WHOOP: ${whoopText(whoop)}` : "WHOOP: not connected");
  if (ib) {
    if (ib.reply.length) lines.push(`Emails to answer:\n${ib.reply.slice(0, 5).map((i) => `- ${i.line}`).join("\n")}`);
    if (ib.followup.length) lines.push(`To follow up:\n${ib.followup.slice(0, 3).map((i) => `- ${i.line}`).join("\n")}`);
  }
  const rem = JSON.parse((await env.TOKENS.get("reminders:today")) ?? "null") as { items: string[]; at: string } | null;
  const fresh = rem && Date.now() - Date.parse(rem.at) < 18 * 3_600_000;
  if (fresh && rem!.items.length) lines.push(`Reminders due today (iPhone):\n${rem!.items.map((t) => `- ${t}`).join("\n")}`);
  if (body.tasks?.length) lines.push(`Other tasks:\n${body.tasks.map((t) => `- ${t}`).join("\n")}`);
  lines.push(body.gym?.length ? `Gym today, already done: ${body.gym.join(", ")}` : "Gym today: not yet");
  return lines.join("\n");
}

async function brief(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.ANTHROPIC_API_KEY) return json({ error: "Claude key missing on the server." }, 500);
  const body = (await req.json()) as BriefRequest;
  const context = await dayContext(env, body, ctx);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 2000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: `${body.prompt}\n\n${context}` }],
    });
    if (response.stop_reason === "refusal") return json({ text: "Claude declined this one. Try a different prompt in settings." });
    const plan = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    // Reminders are listed exactly as you wrote them; Claude only writes the suggestions.
    const rem = JSON.parse((await env.TOKENS.get("reminders:today")) ?? "null") as { items: string[]; at: string } | null;
    const fresh = rem && Date.now() - Date.parse(rem.at) < 18 * 3_600_000 ? rem.items : [];
    const reminderLines = fresh.length ? fresh.map((r) => `- ${r}`) : ["- Nothing due today"];
    return json({ text: ["REMINDERS", ...reminderLines, "", "TODAY'S FOCUS", plan].join("\n") });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "Claude key is invalid." }, 502);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "Rate limited. Try again in a minute." }, 502);
    if (err instanceof Anthropic.APIError) return json({ error: `Claude API error ${err.status}.` }, 502);
    throw err;
  }
}

// ---------- one-time setup page (open on your Mac, not in the Even app) ----------

async function setupPage(env: Env, url: URL): Promise<Response> {
  const token = encodeURIComponent(url.searchParams.get("token") ?? "");
  const rows = await Promise.all(
    (Object.keys(ACCOUNTS) as AccountKey[]).map(async (k) => {
      const ok = await isConnected(env, k);
      return `<li><span>${ACCOUNTS[k]}</span>${
        ok ? `<b class=ok>Connected</b> <a href="/auth/google/start?account=${k}&token=${token}">Reconnect</a>`
           : `<a class=btn href="/auth/google/start?account=${k}&token=${token}">Connect</a>`
      }</li>`;
    }),
  );
  return new Response(
    `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Claude Dash setup</title>
<style>body{font:16px system-ui;background:#0e0f0f;color:#e8e8e6;max-width:560px;margin:0 auto;padding:32px 16px}
li{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #2a2d2e;gap:12px}
ul{list-style:none;padding:0}a{color:#d97757}.btn{background:#d97757;color:#111;padding:8px 14px;border-radius:8px;text-decoration:none;font-weight:600}
.ok{color:#5dff8a}small{color:#9a9d9b}</style>
<h1>Claude Dash setup</h1>
<p>Connect each Google account once. Access is read-only: the dashboard can't send, delete or change anything.</p>
<ul>${rows.join("")}${await whoopRow(env, token)}</ul>
<small>ali@echonos.ai is used for your calendar. All four inboxes are read for email triage. WHOOP feeds your day plan and gym rest timer.</small>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

async function whoopRow(env: Env, token: string): Promise<string> {
  const ok = await whoopConnected(env);
  const link = `/auth/whoop/start?token=${token}`;
  return `<li><span>WHOOP</span>${ok ? `<b class=ok>Connected</b> <a href="${link}">Reconnect</a>` : `<a class=btn href="${link}">Connect</a>`}</li>`;
}

function publicPage(path: string): Response {
  const body = path === "/privacy"
    ? `<h1>Claude Dash privacy</h1>
<p>Claude Dash is a personal dashboard for one user's Even Realities glasses.</p>
<p>It reads Google Calendar and Gmail with read-only access, only for the account owner who connects them.
It never sends, deletes or changes email or calendar events.</p>
<p>Sign-in tokens are stored privately on the server. Email subjects, senders and snippets may be sent to
Anthropic's Claude API to write short summaries. Nothing is sold or shared with anyone else.</p>
<p>To remove access, revoke Claude Dash at myaccount.google.com/permissions.</p>`
    : `<h1>Claude Dash</h1><p>A personal heads-up dashboard for Even Realities glasses.</p><p><a href="/privacy">Privacy policy</a></p>`;
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claude Dash</title><body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5">${body}</body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
