// Inbox triage: reads all connected Gmail inboxes (read-only), finds threads that
// need a reply and things you sent that got no answer, then asks Claude to keep
// only what matters and write one short line for each.
import Anthropic from "@anthropic-ai/sdk";
import { ACCOUNTS, type AccountKey, accessToken } from "./google";
import type { Env } from "./index";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const PER_ACCOUNT = 15; // newest threads looked at per inbox, per list
const CACHE_KEY = "inbox:cache";
const CACHE_SECONDS = 15 * 60;

// Short tags shown on the glasses next to each item.
export const TAGS: Record<AccountKey, string> = { ali: "ech", hello: "hel", alisyed: "asy", personal: "gml" };

const OWN = new Set(Object.values(ACCOUNTS).map((e) => e.toLowerCase()));
const ROBOT = /no-?reply|do-?not-?reply|notifications?@|mailer-daemon|postmaster|bounce|calendar-notification/i;

interface Candidate {
  id: string;
  kind: "reply" | "followup";
  account: AccountKey;
  person: string; // who wrote to you (reply) or who you're waiting on (followup)
  subject: string;
  snippet: string;
  ageHours: number;
}

export interface InboxItem {
  line: string;
  tag: string;
  ageHours: number;
}

export interface Inbox {
  at: string;
  reply: InboxItem[];
  followup: InboxItem[];
  skipped: string[]; // inboxes that couldn't be read
  advice: string; // 2-3 sentences: who to reply to first, who to chase
}

interface GHeader { name: string; value: string }
interface GMessage { labelIds?: string[]; internalDate?: string; snippet?: string; payload?: { headers?: GHeader[] } }
interface GThread { id: string; messages?: GMessage[] }

const header = (m: GMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function address(v: string): string {
  return (v.match(/<([^>]+)>/)?.[1] ?? v).trim().toLowerCase();
}

function displayName(v: string): string {
  const first = v.split(",")[0];
  const name = first.replace(/<[^>]*>/, "").replace(/"/g, "").trim();
  return name || address(first).split("@")[0];
}

const decode = (s: string) =>
  s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

async function listThreads(token: string, q: string): Promise<string[]> {
  const url = `${GMAIL}/threads?${new URLSearchParams({ q, maxResults: String(PER_ACCOUNT) })}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail list ${res.status}`);
  const data = (await res.json()) as { threads?: { id: string }[] };
  return (data.threads ?? []).map((t) => t.id);
}

/** Fetch many threads in one request (Gmail batch API) to stay inside Cloudflare's request limit. */
async function getThreads(token: string, ids: string[]): Promise<GThread[]> {
  if (!ids.length) return [];
  const boundary = "batch_claude_dash";
  const query = "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe";
  const body =
    ids
      .map((id, i) =>
        `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <${i}>\r\n\r\nGET /gmail/v1/users/me/threads/${id}?${query}\r\n`,
      )
      .join("") + `--${boundary}--`;
  const res = await fetch("https://www.googleapis.com/batch/gmail/v1", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/mixed; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Gmail batch ${res.status}`);
  const replyBoundary = res.headers.get("Content-Type")?.match(/boundary=([^;]+)/)?.[1];
  const text = await res.text();
  if (!replyBoundary) return [];
  const threads: GThread[] = [];
  for (const part of text.split(`--${replyBoundary}`)) {
    const start = part.indexOf("{");
    const end = part.lastIndexOf("}");
    if (start < 0 || end < start) continue;
    try {
      const t = JSON.parse(part.slice(start, end + 1)) as GThread;
      if (t.id && t.messages) threads.push(t);
    } catch {
      /* one bad part shouldn't sink the rest */
    }
  }
  return threads;
}

async function candidates(env: Env, account: AccountKey): Promise<Candidate[]> {
  const token = await accessToken(env, account);
  if (!token) throw new Error("not connected");
  const [inboxIds, sentIds] = await Promise.all([
    listThreads(token, "in:inbox newer_than:7d -category:promotions -category:social -category:forums -category:updates"),
    listThreads(token, "in:sent newer_than:7d"),
  ]);
  const threads = await getThreads(token, [...new Set([...inboxIds, ...sentIds])]);
  const now = Date.now();
  const out: Candidate[] = [];
  for (const t of threads) {
    const msgs = (t.messages ?? []).filter((m) => !m.labelIds?.includes("DRAFT"));
    const last = msgs.at(-1);
    if (!last) continue;
    const ageHours = Math.round((now - Number(last.internalDate ?? now)) / 3_600_000);
    const subject = header(msgs[0], "Subject") || "(no subject)";
    const snippet = decode(last.snippet ?? "").slice(0, 220);
    const fromMe = last.labelIds?.includes("SENT");

    if (!fromMe && last.labelIds?.includes("INBOX")) {
      const from = header(last, "From");
      if (ROBOT.test(from) || header(last, "List-Unsubscribe") || OWN.has(address(from))) continue;
      out.push({ id: `${account}:${t.id}`, kind: "reply", account, person: displayName(from), subject, snippet, ageHours });
    } else if (fromMe && ageHours >= 24 && ageHours <= 24 * 7) {
      const to = header(last, "To");
      const toAddr = address(to.split(",")[0] ?? "");
      if (!toAddr || OWN.has(toAddr) || ROBOT.test(to)) continue;
      out.push({ id: `${account}:${t.id}`, kind: "followup", account, person: displayName(to), subject, snippet, ageHours });
    }
  }
  return out;
}

const SCHEMA = {
  type: "object",
  properties: {
    reply: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, line: { type: "string" } },
        required: ["id", "line"],
        additionalProperties: false,
      },
    },
    followup: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, line: { type: "string" } },
        required: ["id", "line"],
        additionalProperties: false,
      },
    },
    advice: { type: "string" },
  },
  required: ["reply", "followup", "advice"],
  additionalProperties: false,
};

const SYSTEM = `You triage email for a busy startup founder. The result is shown on smart glasses.
You get two lists: threads waiting on the founder's reply, and emails the founder sent that got no answer.
Keep only items a real person actually needs handled: drop newsletters, receipts, automated alerts,
marketing, cold sales pitches, and anything that is just an FYI or a thank-you.
Order each list by importance (investors, customers, partners, deadlines first). At most 8 per list.
For each kept item write one line of at most 36 characters: "Name: what's needed", e.g.
"Jake: wants Fri call time" or "Mia: chase signed contract". Plain ASCII, no emoji, no quotes.
Also write "advice": 2 short, plain sentences (at most 100 characters in total) speaking to the
founder, telling them who to reply to first and who to follow up with, by first name. No lists.`;

async function triage(
  env: Env,
  items: Candidate[],
): Promise<{ reply: { id: string; line: string }[]; followup: { id: string; line: string }[]; advice: string }> {
  if (!items.length) return { reply: [], followup: [], advice: "Nothing needs you. Inbox is clear." };
  const fmt = (c: Candidate) => `[${c.id}] ${c.person} | ${c.subject} | ${c.ageHours}h ago | ${c.snippet}`;
  const content = [
    "WAITING ON MY REPLY:",
    ...items.filter((c) => c.kind === "reply").map(fmt),
    "",
    "I SENT, NO ANSWER YET:",
    ...items.filter((c) => c.kind === "followup").map(fmt),
  ].join("\n");

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined to triage the inbox.");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return JSON.parse(text);
}

export async function inbox(env: Env, fresh: boolean): Promise<Inbox> {
  if (!fresh) {
    const cached = await env.TOKENS.get(CACHE_KEY);
    if (cached) return JSON.parse(cached) as Inbox;
  }
  const keys = Object.keys(ACCOUNTS) as AccountKey[];
  const results = await Promise.allSettled(keys.map((k) => candidates(env, k)));
  const all: Candidate[] = [];
  const skipped: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") all.push(...r.value);
    else {
      console.error("inbox", keys[i], r.reason);
      skipped.push(ACCOUNTS[keys[i]]);
    }
  });

  const picked = await triage(env, all);
  const byId = new Map(all.map((c) => [c.id, c]));
  const toItems = (list: { id: string; line: string }[]) =>
    list.flatMap(({ id, line }) => {
      const c = byId.get(id);
      return c ? [{ line: line.slice(0, 40), tag: TAGS[c.account], ageHours: c.ageHours }] : [];
    });
  const result: Inbox = {
    at: new Date().toISOString(),
    reply: toItems(picked.reply),
    followup: toItems(picked.followup),
    skipped,
    advice: picked.advice ?? "",
  };
  await env.TOKENS.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_SECONDS });
  return result;
}

// ---------- new-email alerts ----------
// The glasses ask every couple of minutes with the time of their last check.
// Nothing is stored on the server; Claude only runs when something new arrives.

export interface EmailAlert {
  id: string;
  tag: string; // which inbox: ech, hel, asy, gml
  from: string;
  subject: string;
  line: string; // one short line for the pop-up
  summary: string; // 2-3 sentences for "read more"
  at: number; // ms
}

const ALERT_SCHEMA = {
  type: "object",
  properties: {
    alerts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          needsYou: { type: "boolean" },
          line: { type: "string" },
          summary: { type: "string" },
        },
        required: ["id", "needsYou", "line", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: ["alerts"],
  additionalProperties: false,
};

async function newMessages(env: Env, account: AccountKey, sinceSec: number) {
  const token = await accessToken(env, account);
  if (!token) return [];
  const q = `in:inbox after:${sinceSec} -category:promotions -category:social -category:forums -category:updates`;
  const res = await fetch(`${GMAIL}/messages?${new URLSearchParams({ q, maxResults: "5" })}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail list ${res.status}`);
  const ids = (((await res.json()) as { messages?: { id: string }[] }).messages ?? []).map((m) => m.id);
  const meta = "format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe";
  const msgs = await Promise.all(
    ids.map((id) =>
      fetch(`${GMAIL}/messages/${id}?${meta}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => (r.ok ? (r.json() as Promise<GMessage & { id: string }>) : null)),
    ),
  );
  return msgs.flatMap((m) => {
    if (!m || m.labelIds?.includes("SENT")) return [];
    const from = header(m, "From");
    if (ROBOT.test(from) || header(m, "List-Unsubscribe") || OWN.has(address(from))) return [];
    return [{
      id: `${account}:${m.id}`,
      tag: TAGS[account],
      from: displayName(from),
      subject: header(m, "Subject") || "(no subject)",
      snippet: decode(m.snippet ?? "").slice(0, 400),
      at: Number(m.internalDate ?? Date.now()),
    }];
  });
}

export async function alerts(env: Env, sinceSec: number): Promise<{ now: number; alerts: EmailAlert[] }> {
  const now = Math.floor(Date.now() / 1000);
  const keys = Object.keys(ACCOUNTS) as AccountKey[];
  const found = (await Promise.all(keys.map((k) => newMessages(env, k, sinceSec).catch(() => [])))).flat();
  if (!found.length) return { now, alerts: [] };

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const r = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    output_config: { effort: "low", format: { type: "json_schema", schema: ALERT_SCHEMA } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system:
      "New emails just arrived for a startup founder. For each, decide needsYou: true only if a real person wants something " +
      "from them or it's genuinely important (investors, customers, partners, deadlines, money). False for FYIs, receipts, " +
      "automated or marketing mail. line: at most 34 characters saying what they want. summary: 2 or 3 plain sentences " +
      "with the key details and what to do. No emoji.",
    messages: [{ role: "user", content: found.map((f) => `[${f.id}] From: ${f.from} | Subject: ${f.subject} | ${f.snippet}`).join("\n") }],
  });
  if (r.stop_reason === "refusal") return { now, alerts: [] };
  const picked = JSON.parse(r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")) as {
    alerts: { id: string; needsYou: boolean; line: string; summary: string }[];
  };
  const byId = new Map(found.map((f) => [f.id, f]));
  return {
    now,
    alerts: picked.alerts.flatMap((a) => {
      const f = byId.get(a.id);
      return f && a.needsYou ? [{ id: f.id, tag: f.tag, from: f.from, subject: f.subject, line: a.line.slice(0, 40), summary: a.summary, at: f.at }] : [];
    }),
  };
}
