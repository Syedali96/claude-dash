// Inbox triage: reads all connected Gmail inboxes (read-only), finds threads that
// need a reply and things you sent that got no answer, then asks Claude to keep
// only what matters and write one short line for each.
import Anthropic from "@anthropic-ai/sdk";
import { type Ctx, peek, refresh, swr } from "./cache";
import { type AccountKey, accessToken, accounts } from "./google";
import type { Env } from "./index";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const PER_ACCOUNT = 15; // newest threads looked at per inbox, per list
const CACHE_KEY = "inbox:v2";
const FRESH_MS = 15 * 60_000; // older than this is refreshed in the background
const KEEP_SECONDS = 24 * 3600;

// Each account's key is also the short tag shown on the glasses next to each item (GOOGLE_ACCOUNTS).
/** Your own addresses, so mail you sent isn't counted as waiting on you. */
const own = (env: Env) => new Set(Object.values(accounts(env)));
const ROBOT = /no-?reply|do-?not-?reply|notifications?@|mailer-daemon|postmaster|bounce|calendar-notification/i;

interface Candidate {
  id: string;
  kind: "reply" | "followup";
  account: AccountKey;
  person: string; // who wrote to you (reply) or who you're waiting on (followup)
  subject: string;
  snippet: string;
  ageHours: number;
  lastAt: number; // ms, the thread's newest message
}

export interface InboxItem {
  line: string;
  tag: string;
  ageHours: number;
  id?: string; // "account:threadId" (for dismissing; not shown)
  lastAt?: number; // ms, the thread's newest message
}

export interface Inbox {
  at: string;
  reply: InboxItem[];
  followup: InboxItem[];
  skipped: string[]; // inboxes that couldn't be read
  accounts?: number; // how many inboxes are set up
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
    const lastAt = Number(last.internalDate ?? now);
    const ageHours = Math.round((now - lastAt) / 3_600_000);
    const subject = header(msgs[0], "Subject") || "(no subject)";
    const snippet = decode(last.snippet ?? "").slice(0, 220);
    const fromMe = last.labelIds?.includes("SENT");

    if (!fromMe && last.labelIds?.includes("INBOX")) {
      const from = header(last, "From");
      if (ROBOT.test(from) || header(last, "List-Unsubscribe") || own(env).has(address(from))) continue;
      out.push({ id: `${account}:${t.id}`, kind: "reply", account, person: displayName(from), subject, snippet, ageHours, lastAt });
    } else if (fromMe && ageHours >= 24 && ageHours <= 24 * 7) {
      const to = header(last, "To");
      const toAddr = address(to.split(",")[0] ?? "");
      if (!toAddr || own(env).has(toAddr) || ROBOT.test(to)) continue;
      out.push({ id: `${account}:${t.id}`, kind: "followup", account, person: displayName(to), subject, snippet, ageHours, lastAt });
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

type Picked = Awaited<ReturnType<typeof triage>>;
interface Built { result: Inbox; sig: string; picked: Picked }

/** Fingerprint of the candidate threads, so Claude only re-triages when something changed. */
async function signature(items: Candidate[]): Promise<string> {
  const data = new TextEncoder().encode(items.map((c) => `${c.id}|${c.kind}|${c.snippet}`).sort().join("\n"));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function build(env: Env): Promise<Built> {
  const keys = Object.keys(accounts(env));
  const results = await Promise.allSettled(keys.map((k) => candidates(env, k)));
  const all: Candidate[] = [];
  const skipped: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") all.push(...r.value);
    else {
      console.error("inbox", keys[i], r.reason);
      skipped.push(accounts(env)[keys[i]]);
    }
  });
  const sig = await signature(all);
  const prev = await peek<Built>(env, CACHE_KEY);
  const picked = prev?.v.sig === sig && prev.v.picked ? prev.v.picked : await triage(env, all);
  const byId = new Map(all.map((c) => [c.id, c]));
  const toItems = (list: { id: string; line: string }[]) =>
    list.flatMap(({ id, line }) => {
      const c = byId.get(id);
      return c ? [{ line: line.slice(0, 40), tag: c.account, ageHours: c.ageHours, id: c.id, lastAt: c.lastAt }] : [];
    });
  const result: Inbox = {
    at: new Date().toISOString(),
    reply: toItems(picked.reply),
    followup: toItems(picked.followup),
    skipped,
    accounts: keys.length,
    advice: picked.advice ?? "",
  };
  return { result, sig, picked };
}

/** The triaged inbox. Saved copy right away; `fresh` (or the timer) rebuilds it now. */
export async function inbox(env: Env, fresh: boolean, ctx?: Ctx): Promise<Inbox> {
  const b = fresh
    ? await refresh(env, CACHE_KEY, () => build(env), KEEP_SECONDS)
    : await swr(env, ctx, CACHE_KEY, FRESH_MS, () => build(env), KEEP_SECONDS);
  return withoutDismissed(b.result, await dismissed(env));
}

// ---------- dismissed items (Ask Claude: "remove Maya's one from my inbox") ----------
// Only the Claude Dash list changes: Gmail itself is never touched (read-only).
// Each dismissed thread is saved with the time of its newest message; when someone
// writes again in that thread, it's newer than that and the thread comes back.

const DISMISSED_KEY = "inbox:dismissed";
const DISMISS_KEEP_MS = 9 * 24 * 3_600_000; // longer than the 7-day window the inbox looks at

type Dismissed = Record<string, { lastAt: number; line: string; at: number }>;

async function dismissed(env: Env): Promise<Dismissed> {
  return JSON.parse((await env.TOKENS.get(DISMISSED_KEY)) ?? "{}") as Dismissed;
}

function withoutDismissed(ib: Inbox, d: Dismissed): Inbox {
  const keep = (i: InboxItem) => !(i.id && d[i.id] && (i.lastAt ?? 0) <= d[i.id].lastAt);
  return { ...ib, reply: ib.reply.filter(keep), followup: ib.followup.filter(keep) };
}

const STOP = new Set(["the", "and", "for", "from", "with", "about", "that", "this", "one", "ones", "email", "emails", "mail", "inbox", "list",
  "remove", "delete", "dismiss", "hide", "clear", "take", "off", "out", "please", "can", "you", "his", "her", "their", "thing", "item", "reply", "follow"]);
const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9/ ]/g, " ").split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w));

/**
 * Take one item off the Inbox list. `what` is how the user described it ("Maya's caption one").
 * Returns what was removed, or the close matches when it isn't clear which one was meant.
 */
export async function dismissInboxItem(env: Env, what: string, ctx?: Ctx): Promise<{ removed: string | null; options: string[]; message: string }> {
  const ib = await inbox(env, false, ctx);
  const items = [...ib.reply.map((i) => ({ ...i, kind: "reply" })), ...ib.followup.map((i) => ({ ...i, kind: "followup" }))];
  const asked = words(what);
  const scored = items.map((i) => {
    const [person, rest = ""] = i.line.split(/:(.*)/s);
    const pw = words(person);
    const rw = words(rest);
    let score = 0;
    for (const w of asked) {
      if (pw.some((p) => p === w || (w.length >= 3 && p.startsWith(w)))) score += 3;
      else if (rw.some((r) => r === w || (w.length >= 4 && (r.startsWith(w) || w.startsWith(r) && r.length >= 4)))) score += 1;
    }
    return { i, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return { removed: null, options: items.map((i) => i.line), message: "No item on the Inbox list matches that. These are on it now." };
  const best = scored[0];
  const tied = scored.filter((x) => x.score === best.score);
  if (tied.length > 1) return { removed: null, options: tied.map((x) => x.i.line), message: "More than one item matches. Ask which one the user means." };
  if (!best.i.id) return { removed: null, options: [], message: "This item can't be removed yet (the list is from before this feature). Try again in 15 minutes." };
  const d = await dismissed(env);
  const now = Date.now();
  for (const [k, v] of Object.entries(d)) if (now - v.at > DISMISS_KEEP_MS) delete d[k];
  d[best.i.id] = { lastAt: best.i.lastAt ?? now, line: best.i.line, at: now };
  await env.TOKENS.put(DISMISSED_KEY, JSON.stringify(d));
  return { removed: best.i.line, options: [], message: `Removed "${best.i.line}" from the Inbox list. It comes back by itself if a new message arrives in that thread.` };
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
    if (ROBOT.test(from) || header(m, "List-Unsubscribe") || own(env).has(address(from))) return [];
    return [{
      id: `${account}:${m.id}`,
      tag: account,
      from: displayName(from),
      subject: header(m, "Subject") || "(no subject)",
      snippet: decode(m.snippet ?? "").slice(0, 400),
      at: Number(m.internalDate ?? Date.now()),
    }];
  });
}

export async function alerts(env: Env, sinceSec: number): Promise<{ now: number; alerts: EmailAlert[] }> {
  const now = Math.floor(Date.now() / 1000);
  const keys = Object.keys(accounts(env));
  const found = (await Promise.all(keys.map((k) => newMessages(env, k, sinceSec).catch(() => [])))).flat();
  if (!found.length) return { now, alerts: [] };

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const r = await client.beta.messages.create({
    model: "claude-haiku-5-5", // measured Nov 25: ~1-1.2 s faster than Opus here, same answers,
    max_tokens: 2000,
    output_config: { effort: "low", format: { type: "json_schema", schema: ALERT_SCHEMA } },
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
