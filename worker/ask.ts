// "Ask Claude" card: you speak a question on the glasses, Groq turns it into
// text, and Claude answers using tools that read your data (read-only):
// your 4 inboxes, calendar, WHOOP, iPhone Reminders, inbox triage and news.
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { dismissInboxItem, inbox } from "./gmail";
import { ACCOUNTS, type AccountKey, accessToken, agenda } from "./google";
import { transcribe } from "./gym";
import type { Ctx } from "./cache";
import type { Env } from "./index";
import { news } from "./news";
import { bedtime, whoopText, whoopToday } from "./whoop";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_SEARCHES = 2; // keeps each question inside Cloudflare's request limit

interface AskRequest {
  audio?: string; // base64 16 kHz PCM from the glasses mic
  text?: string; // or a typed question (used for testing)
  history?: { q: string; a: string }[]; // earlier questions, for follow-ups
  now?: string;
  timeZone?: string;
}

// ---------- reading emails ----------

interface Part { mimeType?: string; body?: { data?: string }; parts?: Part[] }

function b64url(data: string): string {
  const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** The plain-text body of a message (falls back to stripped HTML). */
function bodyText(p: Part): string {
  const find = (part: Part, type: string): string | null => {
    if (part.mimeType === type && part.body?.data) return b64url(part.body.data);
    for (const sub of part.parts ?? []) {
      const t = find(sub, type);
      if (t) return t;
    }
    return null;
  };
  const plain = find(p, "text/plain");
  if (plain) return plain;
  const html = find(p, "text/html") ?? "";
  return html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

/** Drop quoted replies so the newest message is what Claude reads. */
const newestPart = (t: string) => t.split(/\n(?:On .+wrote:|-{2,} ?Original Message|From: .+\nSent: )/)[0].replace(/\s+/g, " ").trim();

async function searchEmail(env: Env, query: string): Promise<string> {
  const keys = Object.keys(ACCOUNTS) as AccountKey[];
  const results = await Promise.all(
    keys.map(async (k) => {
      const token = await accessToken(env, k);
      if (!token) return [];
      const h = { Authorization: `Bearer ${token}` };
      const list = await fetch(`${GMAIL}/messages?${new URLSearchParams({ q: query, maxResults: "3" })}`, { headers: h });
      if (!list.ok) return [];
      const ids = (((await list.json()) as { messages?: { id: string }[] }).messages ?? []).map((m) => m.id);
      return Promise.all(
        ids.map(async (id) => {
          const r = await fetch(`${GMAIL}/messages/${id}?format=full`, { headers: h });
          if (!r.ok) return null;
          const m = (await r.json()) as { internalDate?: string; payload?: Part & { headers?: { name: string; value: string }[] } };
          const hd = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
          return {
            inbox: ACCOUNTS[k],
            date: new Date(Number(m.internalDate ?? 0)).toISOString().slice(0, 16),
            from: hd("from"),
            to: hd("to"),
            subject: hd("subject"),
            body: newestPart(bodyText(m.payload ?? {})).slice(0, 2500),
          };
        }),
      );
    }),
  );
  const found = results.flat().filter(Boolean);
  return found.length ? JSON.stringify(found) : "No emails matched that search.";
}

// ---------- the question ----------

const SYSTEM = `You are Claude, answering a question asked out loud through smart glasses by Ali, founder of
Echonos (his calendar is ali@echonos.ai; his inboxes are ali@echonos.ai, hello@echonos.ai, ali@ali-syed.com and
syedbali1996@gmail.com). "I", "me" and "my" mean Ali.
The answer is read on a small monochrome display: plain text only, no markdown, no bullets
unless listing, no emoji. Answer in at most 70 words, most important fact first.
Use the tools to look things up in the user's own email, calendar, WHOOP, reminders and news
before answering; never guess what an email says. For general questions (facts, prices, sports, news
beyond the headlines), use web_search. Don't add source links; the display can't open them. Gmail search syntax works in search_email
(from:paul, subject:TAP, newer_than:7d).
The one thing you can change is the Claude Dash Inbox list: when Ali asks to remove, clear or dismiss an item from
his inbox list, call dismiss_inbox_item with how he described it (it doesn't touch Gmail; the item comes back if a
new message arrives in that thread). Then confirm in one short sentence exactly what you removed, e.g.
"Removed Paul: approve the 11/26 post caption from your Inbox list." If more than one item matches, ask which one.
Everything else is read-only: if asked to send, reply, delete or change emails or events, say you can't do that from the glasses yet.`;

/**
 * Two ways in:
 * - multipart form (current app): fields audio (raw PCM file) or text, history (JSON), now, timeZone.
 *   Streams plain text: "QUESTION: ...\n" then the answer as it's written. A \x1e character means
 *   "throw away the answer text so far" (Claude is about to look something up).
 * - JSON (older app versions): {audio: base64, ...} and a JSON reply when done.
 */
export async function ask(req: Request, env: Env, ctx?: Ctx): Promise<Response> {
  const streaming = (req.headers.get("Content-Type") ?? "").startsWith("multipart/form-data");
  let body: AskRequest;
  let pcm: Uint8Array | null = null;
  if (streaming) {
    const form = await req.formData();
    const audio = form.get("audio");
    if (audio && typeof audio !== "string") pcm = new Uint8Array(await audio.arrayBuffer());
    body = {
      text: String(form.get("text") ?? ""),
      history: JSON.parse(String(form.get("history") || "[]")) as AskRequest["history"],
      now: String(form.get("now") ?? "") || undefined,
      timeZone: String(form.get("timeZone") ?? "") || undefined,
    };
  } else {
    body = (await req.json()) as AskRequest;
    if (body.audio) pcm = Uint8Array.from(atob(body.audio), (c) => c.charCodeAt(0));
  }
  const empty = () => (streaming ? plain("QUESTION: \n") : Response.json({ question: "", answer: "" }));
  let question = body.text?.trim() ?? "";
  if (!question && pcm) {
    if (pcm.length < 16_000 * 2 * 0.4) return empty();
    question = await transcribe(env, pcm, "A question for an assistant about email, meetings, health, news.");
  }
  if (!question) return empty();

  const tz = body.timeZone || "America/New_York";
  let searches = 0;
  let inboxChanged = false; // an item was taken off the Inbox list: tell the glasses to reload it
  const tools = [
    betaTool({
      name: "search_email",
      description: "Search all 4 of the user's inboxes (Gmail search syntax). Returns up to 3 matches per inbox with sender, date, subject and the newest message text.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      run: async ({ query }) => {
        if (++searches > MAX_SEARCHES) return "Search limit reached for this question; answer with what you have.";
        return searchEmail(env, String(query));
      },
    }),
    betaTool({
      name: "get_calendar",
      description: "Events on the user's calendar between two dates (YYYY-MM-DD, end exclusive).",
      inputSchema: {
        type: "object",
        properties: { start: { type: "string" }, end: { type: "string" } },
        required: ["start", "end"],
        additionalProperties: false,
      },
      run: async ({ start, end }) => {
        const events = await agenda(env, new Date(`${start}T00:00:00Z`).toISOString(), new Date(`${end}T00:00:00Z`).toISOString());
        if (!events) return "Calendar not connected.";
        const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" });
        return events.map((e) => `${e.allDay ? `${e.start} all day` : `${fmt(e.start)} - ${fmt(e.end)}`}: ${e.title}`).join("\n") || "No events.";
      },
    }),
    betaTool({
      name: "get_whoop",
      description: "Today's WHOOP recovery, HRV, sleep, strain and recommended bedtime.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const w = await whoopToday(env, ctx);
        return w ? `${whoopText(w)}. Recommended bedtime ${bedtime(w, tz).bedtime}.` : "WHOOP not connected.";
      },
    }),
    betaTool({
      name: "get_reminders",
      description: "The user's iPhone Reminders due today.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => (await env.TOKENS.get("reminders:today")) ?? "No reminders synced.",
    }),
    betaTool({
      name: "get_inbox_summary",
      description: "Emails waiting on the user's reply and emails they sent that got no answer (already triaged).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const ib = await inbox(env, false, ctx);
        return JSON.stringify({ reply: ib.reply.map((i) => i.line), followup: ib.followup.map((i) => i.line) });
      },
    }),
    betaTool({
      name: "dismiss_inbox_item",
      description: "Remove one item from the user's Claude Dash Inbox list (reply or follow-up), e.g. when they say \"remove Paul's caption one from my inbox\". " +
        "Pass how the user described it (person and/or subject). Gmail is not changed. Returns what was removed, or the matching items if it's unclear.",
      inputSchema: { type: "object", properties: { description: { type: "string" } }, required: ["description"], additionalProperties: false },
      run: async ({ description }) => {
        const r = await dismissInboxItem(env, String(description), ctx);
        if (r.removed) inboxChanged = true;
        return JSON.stringify(r);
      },
    }),
    betaTool({
      name: "get_news",
      description: "Today's top headlines (Morning Brew and Tech Brew).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => (await news(env, ctx)).headlines.join("\n"),
    }),
  ];

  // Current info from the web for general questions (Anthropic's built-in search tool).
  const webSearch = { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 2 };

  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const h of (body.history ?? []).slice(-6)) {
    messages.push({ role: "user", content: h.q }, { role: "assistant", content: h.a });
  }
  messages.push({ role: "user", content: `(Now: ${body.now ?? new Date().toISOString()}, time zone ${tz})\n${question}` });

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const params = {
    model: "claude-opus-5-5",
    max_tokens: 4000,
    max_iterations: 5,
    output_config: { effort: "low" as const },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default" as const,
    system: SYSTEM,
    tools: [...tools, webSearch],
    messages,
  };

  if (!streaming) {
    const final = await client.beta.messages.toolRunner(params);
    if (final.stop_reason === "refusal") return Response.json({ question, answer: "I can't help with that one." });
    // Keep only the text after the last search, so notes Claude made before searching aren't shown.
    const lastTool = final.content.map((b) => b.type !== "text").lastIndexOf(true);
    const answer = final.content.slice(lastTool + 1).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    return Response.json({ question, answer: answer || "I couldn't find an answer to that." });
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const write = (t: string) => writer.write(enc.encode(t));
  const job = (async () => {
    let wrote = false; // any answer text since the last lookup
    let refused = false;
    try {
      await write(`QUESTION: ${question.replace(/\s+/g, " ")}\n`);
      const runner = client.beta.messages.toolRunner({ ...params, stream: true, runToolsEagerly: true });
      for await (const stream of runner) {
        for await (const ev of stream) {
          if (ev.type === "content_block_start" && ev.content_block.type !== "text") {
            if (wrote) await write("\x1e");
            wrote = false;
          } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            await write(ev.delta.text);
            if (ev.delta.text.trim()) wrote = true;
          } else if (ev.type === "message_delta" && ev.delta.stop_reason === "refusal") refused = true;
        }
      }
      if (refused) await write("\x1eI can't help with that one.");
      else if (!wrote) await write("\x1eI couldn't find an answer to that.");
      if (inboxChanged) await write("\x1f"); // the glasses reload the Inbox card
    } catch (e) {
      await write(`\nERROR: ${e instanceof Error ? e.message : "Claude error"}`).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  ctx?.waitUntil(job);
  return plain(readable);
}

const plain = (body: BodyInit) =>
  new Response(body, {
    // identity: compressing would hold the text back until the end instead of streaming it
    headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache", "Content-Encoding": "identity" },
  });
