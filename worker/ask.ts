// "Ask Claude" card: you speak a question on the glasses, Groq turns it into
// text, and Claude answers using tools that read your data (read-only):
// your 4 inboxes, calendar, WHOOP, iPhone Reminders, inbox triage and news.
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { inbox } from "./gmail";
import { ACCOUNTS, type AccountKey, accessToken, agenda } from "./google";
import { transcribe } from "./gym";
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
(from:paul, subject:TAP, newer_than:7d). You can only read: if asked to send, reply, delete
or change anything, say you can't do that from the glasses yet.`;

export async function ask(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as AskRequest;
  let question = body.text?.trim() ?? "";
  if (!question && body.audio) {
    const pcm = Uint8Array.from(atob(body.audio), (c) => c.charCodeAt(0));
    if (pcm.length < 16_000 * 2 * 0.4) return Response.json({ question: "", answer: "" });
    question = await transcribe(env, pcm, "A question for an assistant about email, meetings, health, news.");
  }
  if (!question) return Response.json({ question: "", answer: "" });

  const tz = body.timeZone || "America/New_York";
  let searches = 0;
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
        const w = await whoopToday(env);
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
        const ib = await inbox(env, false);
        return JSON.stringify({ reply: ib.reply.map((i) => i.line), followup: ib.followup.map((i) => i.line) });
      },
    }),
    betaTool({
      name: "get_news",
      description: "Today's top headlines (Morning Brew and Tech Brew).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => (await news(env)).headlines.join("\n"),
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
  const final = await client.beta.messages.toolRunner({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    max_iterations: 5,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    tools: [...tools, webSearch],
    messages,
  });
  if (final.stop_reason === "refusal") return Response.json({ question, answer: "I can't help with that one." });
  // Keep only the text after the last search, so notes Claude made before searching aren't shown.
  const lastTool = final.content.map((b) => b.type !== "text").lastIndexOf(true);
  const answer = final.content.slice(lastTool + 1).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
  return Response.json({ question, answer: answer || "I couldn't find an answer to that." });
}
