// Top 10 stories: a few big world stories (BBC World, NPR World), then Morning Brew,
// topped up with Tech Brew, plus an easy-to-read summary of any story and a market
// snapshot (S&P 500 + Bitcoin). Refreshed at most every 15 minutes, and Claude only
// re-picks when the feeds actually have new stories.
import Anthropic from "@anthropic-ai/sdk";
import { type Ctx, swr } from "./cache";
import type { Env } from "./index";

const FEEDS = [
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", days: 1 },
  { name: "NPR World", url: "https://feeds.npr.org/1004/rss.xml", days: 2 },
  { name: "Morning Brew", url: "https://www.morningbrew.com/feed", days: 3 },
  { name: "Tech Brew", url: "https://www.techbrew.com/feed", days: 14 },
];
const CACHE_KEY = "news:top10:v2";
const COUNT = 10;
const WORLD = 3; // world-news picks
const FRESH_MS = 15 * 60_000; // check the feeds at most this often

interface Story { line: string; title: string; text: string; link?: string }
interface Cached { at: string; checked?: number; sig?: string; stories: Story[] }

/** A short fingerprint of which stories are in the feeds, to skip Claude when nothing's new. */
async function signature(titles: string[]): Promise<string> {
  const data = new TextEncoder().encode([...titles].sort().join("\n"));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#8217;|&rsquo;|&#39;|&#x27;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8212;|&mdash;/g, "-")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const tag = (item: string, name: string) => decode(item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "");

function ask(env: Env, system: string, content: string, schema: Record<string, unknown>, maxTokens = 2000) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client.beta.messages
    .create({
      model: "claude-opus-5-5",
      max_tokens: maxTokens,
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: [{ role: "user", content }],
    })
    .then((r) => {
      if (r.stop_reason === "refusal") throw new Error("Claude declined this one.");
      return JSON.parse(r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
    });
}

/** Today's picks. A stale list is returned at once and re-checked in the background (when ctx is given). */
async function stories(env: Env, refresh = true, ctx?: Ctx): Promise<Cached> {
  const raw = await env.TOKENS.get(CACHE_KEY);
  const cached = raw ? (JSON.parse(raw) as Cached) : null;
  if (cached && (!refresh || Date.now() - (cached.checked ?? Date.parse(cached.at)) < FRESH_MS)) return cached;
  const job = update(env, cached);
  if (cached && ctx) {
    ctx.waitUntil(job.catch((e) => console.error("news refresh", e)));
    return cached;
  }
  return job;
}

async function update(env: Env, cached: Cached | null): Promise<Cached> {
  const lists = await Promise.all(
    FEEDS.map(async (f) => {
      const res = await fetch(f.url, { headers: { "User-Agent": "Mozilla/5.0 (ClaudeDash personal reader)" } }).catch(() => null);
      if (!res?.ok) return [];
      const xml = await res.text();
      const since = Date.now() - f.days * 86_400_000;
      return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
        .map((m) => ({
          source: f.name,
          title: tag(m[1], "title"),
          link: tag(m[1], "link") || tag(m[1], "guid"),
          summary: tag(m[1], "description").slice(0, 200),
          text: tag(m[1], "content:encoded").slice(0, 6000),
          at: Date.parse(tag(m[1], "pubDate")),
        }))
        .filter((i) => i.title && (!i.at || i.at >= since))
        .slice(0, 25);
    }),
  );
  const items = lists.flat();
  if (!items.length) {
    if (cached) return cached;
    throw new Error("News feeds are unreachable right now.");
  }
  const sig = await signature(items.map((i) => i.title));
  if (cached?.sig === sig) {
    // Nothing new: keep today's picks, just note that we checked.
    const same = { ...cached, checked: Date.now() };
    await env.TOKENS.put(CACHE_KEY, JSON.stringify(same), { expirationTtl: 6 * 3600 });
    return same;
  }

  const picked = (await ask(
    env,
    `Pick exactly ${COUNT} stories for the founder of an AI music-video startup. ` +
      `First, the ${WORLD} most important world news stories from BBC World or NPR World: wars and conflicts, ` +
      "geopolitics, major elections, the global economy, big disasters. Skip minor or local stories there. " +
      `Then ${COUNT - WORLD} from Morning Brew and Tech Brew. Relevant there: AI, tech, startups, ` +
      "venture funding, big tech, markets, crypto, chips, policy that affects tech, the creator economy and music industry. " +
      "Never pick stories they don't care about, even to reach the count: celebrities and movie casting (e.g. a new Bond), " +
      "gift guides, lifestyle, college and student trends (e.g. international students leaving the US), sports, food, travel. " +
      "Take the relevant Morning Brew stories first, then fill the rest with Tech Brew. Favor the newest. List the world stories first. " +
      "Never two picks about the same company or event. " +
      'For each, give its number and a plain, factual line of at most 36 characters, e.g. "Nvidia beats earnings, outlook murky". No emoji, no quotes.',
    items.map((i, n) => `[${n}] (${i.source}) ${i.title}: ${i.summary}`).join("\n"),
    {
      type: "object",
      properties: {
        picks: {
          type: "array",
          items: { type: "object", properties: { n: { type: "integer" }, line: { type: "string" } }, required: ["n", "line"], additionalProperties: false },
        },
      },
      required: ["picks"],
      additionalProperties: false,
    },
  )) as { picks: { n: number; line: string }[] };

  const out: Cached = {
    at: new Date().toISOString(),
    checked: Date.now(),
    sig,
    stories: picked.picks
      .filter((p) => items[p.n])
      .slice(0, COUNT)
      .map((p) => ({ line: p.line.length <= 38 ? p.line : p.line.slice(0, 38).replace(/\s+\S*$/, ""), title: items[p.n].title, text: items[p.n].text || items[p.n].summary, link: items[p.n].link })),
  };
  await env.TOKENS.put(CACHE_KEY, JSON.stringify(out), { expirationTtl: 6 * 3600 });
  return out;
}

export async function news(env: Env, ctx?: Ctx): Promise<{ at: string; headlines: string[] }> {
  const s = await stories(env, true, ctx);
  return { at: s.at, headlines: s.stories.map((x) => x.line) };
}

// ---------- market snapshot ----------

export interface Markets { sp500: number | null; btc: number | null; btcChange: number | null }

/** S&P 500 day change (Yahoo Finance) and Bitcoin price + 24h change (CoinGecko). Cached 5 minutes. */
export function markets(env: Env, ctx?: Ctx): Promise<Markets> {
  return swr(env, ctx, "markets:v2", 5 * 60_000, fetchMarkets, 24 * 3600);
}

async function fetchMarkets(): Promise<Markets> {
  const ua = { "User-Agent": "Mozilla/5.0 (ClaudeDash personal reader)" };
  const [sp, btc] = await Promise.all([
    fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1d&interval=1d", { headers: ua })
      .then((r) => r.json() as Promise<{ chart?: { result?: { meta?: { regularMarketPrice?: number; chartPreviousClose?: number; regularMarketChangePercent?: number } }[] } }>)
      .then((d) => {
        const m = d.chart?.result?.[0]?.meta;
        if (m?.regularMarketChangePercent != null) return m.regularMarketChangePercent;
        return m?.regularMarketPrice && m.chartPreviousClose ? ((m.regularMarketPrice - m.chartPreviousClose) / m.chartPreviousClose) * 100 : null;
      })
      .catch(() => null),
    // Bitcoin: Yahoo Finance first, Coinbase (24h open vs last) as a backup.
    fetch("https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=1d&interval=1d", { headers: ua })
      .then((r) => r.json() as Promise<{ chart?: { result?: { meta?: { regularMarketPrice?: number; chartPreviousClose?: number; regularMarketChangePercent?: number } }[] } }>)
      .then((d) => {
        const m = d.chart?.result?.[0]?.meta;
        if (!m?.regularMarketPrice) return null;
        const pct = m.regularMarketChangePercent ?? (m.chartPreviousClose ? ((m.regularMarketPrice - m.chartPreviousClose) / m.chartPreviousClose) * 100 : undefined);
        return { usd: m.regularMarketPrice, usd_24h_change: pct };
      })
      .catch(() => null)
      .then(async (y) => {
        if (y) return y;
        const s = (await fetch("https://api.exchange.coinbase.com/products/BTC-USD/stats", { headers: ua }).then((r) => r.json()).catch(() => null)) as { open?: string; last?: string } | null;
        if (!s?.last) return null;
        const last = Number(s.last), open = Number(s.open);
        return { usd: last, usd_24h_change: open ? ((last - open) / open) * 100 : undefined };
      }),
  ]);
  const out: Markets = {
    sp500: sp == null ? null : Math.round(sp * 100) / 100,
    btc: btc?.usd ?? null,
    btcChange: btc?.usd_24h_change == null ? null : Math.round(btc.usd_24h_change * 100) / 100,
  };
  if (out.sp500 == null && out.btc == null) throw new Error("Market prices unavailable.");
  return out;
}

/** An easy-to-read summary of headline number n, sized for the glasses. */
/** World-news feeds only carry a teaser, so read the article page for the summary. */
async function fullText(story: Story): Promise<string> {
  if (story.text.length >= 1500 || !story.link?.startsWith("https://")) return story.text;
  const res = await fetch(story.link.replace(/&amp;/g, "&"), { headers: { "User-Agent": "Mozilla/5.0 (ClaudeDash personal reader)" } }).catch(() => null);
  if (!res?.ok) return story.text;
  const html = await res.text();
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => decode(m[1])).filter((p) => p.length > 60);
  return paras.join("\n").slice(0, 6000) || story.text;
}

export async function article(env: Env, n: number): Promise<{ title: string; summary: string }> {
  // Use the list you're looking at (no refresh), so story n is the one you picked.
  const { stories: list } = await stories(env, false);
  const story = list[n];
  if (!story) throw new Error("That story is gone. Go back and pick again.");
  const key = `news:sum:${story.title.slice(0, 120)}`;
  const cached = await env.TOKENS.get(key);
  if (cached) return { title: story.line, summary: cached };

  const { summary } = (await ask(
    env,
    "Summarize this news article for someone reading on smart glasses (40 characters per line). " +
      "Format: one plain sentence with the main point, then 3 to 4 short bullets starting with \"- \" for the key facts, " +
      'then a line starting "Why it matters: " for a startup founder. Plain text, no markdown, no emoji. At most 110 words.',
    `${story.title}\n\n${await fullText(story)}`,
    { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
  )) as { summary: string };
  await env.TOKENS.put(key, summary, { expirationTtl: 24 * 3600 });
  return { title: story.line, summary };
}
