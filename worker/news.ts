// Top 10 stories from Morning Brew, topped up with Tech Brew when Morning Brew's
// picks aren't relevant to you, plus an easy-to-read summary of any story and a
// market snapshot (S&P 500 + Bitcoin). The feeds carry each article's full
// text, so we never have to load the websites.
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./index";

const FEEDS = [
  { name: "Morning Brew", url: "https://www.morningbrew.com/feed", days: 3 },
  { name: "Tech Brew", url: "https://www.techbrew.com/feed", days: 14 },
];
const CACHE_KEY = "news:top10";
const COUNT = 10;

interface Story { line: string; title: string; text: string }

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

async function stories(env: Env): Promise<{ at: string; stories: Story[] }> {
  const cached = await env.TOKENS.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);

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
          summary: tag(m[1], "description").slice(0, 200),
          text: tag(m[1], "content:encoded").slice(0, 6000),
          at: Date.parse(tag(m[1], "pubDate")),
        }))
        .filter((i) => i.title && (!i.at || i.at >= since))
        .slice(0, 25);
    }),
  );
  const items = lists.flat();
  if (!items.length) throw new Error("News feeds are unreachable right now.");

  const picked = (await ask(
    env,
    `Pick exactly ${COUNT} stories for the founder of an AI music-video startup. Relevant: AI, tech, startups, ` +
      "venture funding, big tech, markets, crypto, chips, policy that affects tech, the creator economy and music industry. " +
      "Never pick stories they don't care about, even to reach the count: celebrities and movie casting (e.g. a new Bond), " +
      "gift guides, lifestyle, college and student trends (e.g. international students leaving the US), sports, food, travel. " +
      "Take the relevant Morning Brew stories first, then fill the rest with Tech Brew. Favor the newest. " +
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

  const out = {
    at: new Date().toISOString(),
    stories: picked.picks
      .filter((p) => items[p.n])
      .slice(0, COUNT)
      .map((p) => ({ line: p.line.slice(0, 38), title: items[p.n].title, text: items[p.n].text || items[p.n].summary })),
  };
  await env.TOKENS.put(CACHE_KEY, JSON.stringify(out), { expirationTtl: 2 * 3600 });
  return out;
}

export async function news(env: Env): Promise<{ at: string; headlines: string[] }> {
  const s = await stories(env);
  return { at: s.at, headlines: s.stories.map((x) => x.line) };
}

// ---------- market snapshot ----------

export interface Markets { sp500: number | null; btc: number | null; btcChange: number | null }

/** S&P 500 day change (Yahoo Finance) and Bitcoin price + 24h change (CoinGecko). Cached 5 minutes. */
export async function markets(env: Env): Promise<Markets> {
  const cached = await env.TOKENS.get("markets");
  if (cached) return JSON.parse(cached);
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
  if (out.sp500 != null || out.btc != null) await env.TOKENS.put("markets", JSON.stringify(out), { expirationTtl: 300 });
  return out;
}

/** An easy-to-read summary of headline number n, sized for the glasses. */
export async function article(env: Env, n: number): Promise<{ title: string; summary: string }> {
  const { stories: list } = await stories(env);
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
    `${story.title}\n\n${story.text}`,
    { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
  )) as { summary: string };
  await env.TOKENS.put(key, summary, { expirationTtl: 24 * 3600 });
  return { title: story.line, summary };
}
