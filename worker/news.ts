// Top 10 stories: 3 big world stories (BBC World, NPR World), then tech and business
// (Morning Brew, Tech Brew, TechCrunch, BBC Technology), plus an easy-to-read summary of
// any story and a market snapshot (S&P 500 + Bitcoin).
//
// Freshness rules: the feeds are checked every 15 minutes, newest stories are preferred
// (last 4 hours first, wider only if a group runs short), and no story stays on screen for
// more than 4 hours. Once a story has been up that long it is retired and never comes back,
// and Claude is told which topics were retired so it moves on to newer news.
import Anthropic from "@anthropic-ai/sdk";
import { type Ctx, swr } from "./cache";
import type { Env } from "./index";

const FEEDS = [
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", world: true },
  { name: "NPR World", url: "https://feeds.npr.org/1004/rss.xml", world: true },
  { name: "Morning Brew", url: "https://www.morningbrew.com/feed", world: false },
  { name: "Tech Brew", url: "https://www.techbrew.com/feed", world: false },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/", world: false },
  { name: "BBC Technology", url: "https://feeds.bbci.co.uk/news/technology/rss.xml", world: false },
];
const CACHE_KEY = "news:top10:v3";
const COUNT = 10;
const WORLD = 3; // world-news picks
const HOUR = 3_600_000;
const FRESH_MS = 15 * 60_000; // check the feeds at most this often
const MAX_ON_SCREEN = 4 * HOUR; // no story stays up longer than this
// Retire a story half an hour early: the server checks and the glasses poll every 15 minutes,
// so even in the worst case it is gone from the display before 4 hours.
const RETIRE_AFTER = MAX_ON_SCREEN - 2 * FRESH_MS;
const WINDOWS = [4 * HOUR, 8 * HOUR, 24 * HOUR]; // how far back to look, newest first
const REMEMBER = 48 * HOUR; // how long a retired story is kept out

interface Story { line: string; title: string; text: string; link?: string; key?: string; shown?: number }
interface Seen { at: number; line: string } // first time on screen
interface Cached { at: string; checked?: number; sig?: string; stories: Story[]; seen?: Record<string, Seen> }
interface Item { source: string; world: boolean; title: string; link: string; summary: string; text: string; at: number; key: string }

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

/** One id per story, so the same story is recognized across checks (links can carry tracking bits). */
const storyKey = (title: string, link: string) => (link ? link.replace(/[?#].*$/, "") : title).slice(0, 200);

const ago = (ms: number) => (ms < HOUR ? `${Math.max(1, Math.round(ms / 60_000))}m ago` : `${Math.round(ms / HOUR)}h ago`);

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

/** True once any story on the list has been up long enough to retire. */
const dueToRetire = (c: Cached, now: number) => c.stories.some((s) => now - (s.shown ?? Date.parse(c.at)) >= RETIRE_AFTER);

/** Today's picks. A stale list is returned at once and re-checked in the background (when ctx is given). */
async function stories(env: Env, refresh = true, ctx?: Ctx): Promise<Cached> {
  const raw = await env.TOKENS.get(CACHE_KEY);
  const cached = raw ? (JSON.parse(raw) as Cached) : null;
  if (!cached || !refresh) return cached ?? update(env, null);
  const now = Date.now();
  if (now - (cached.checked ?? Date.parse(cached.at)) < FRESH_MS && !dueToRetire(cached, now)) return cached;
  const job = update(env, cached);
  // Answer at once from the saved list, unless it holds a story that's been up too long.
  if (ctx && !cached.stories.some((s) => now - (s.shown ?? Date.parse(cached.at)) >= MAX_ON_SCREEN)) {
    ctx.waitUntil(job.catch((e) => console.error("news refresh", e)));
    return cached;
  }
  return job.catch((e) => {
    console.error("news refresh", e);
    return cached;
  });
}

async function fetchFeeds(): Promise<Item[]> {
  const lists = await Promise.all(
    FEEDS.map(async (f) => {
      const res = await fetch(f.url, { headers: { "User-Agent": "Mozilla/5.0 (ClaudeDash personal reader)" } }).catch(() => null);
      if (!res?.ok) return [];
      const xml = await res.text();
      return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
        .map((m) => {
          const title = tag(m[1], "title");
          const link = tag(m[1], "link") || tag(m[1], "guid");
          return {
            source: f.name,
            world: f.world,
            title,
            link,
            summary: tag(m[1], "description").slice(0, 200),
            text: tag(m[1], "content:encoded").slice(0, 6000),
            at: Date.parse(tag(m[1], "pubDate")) || 0,
            key: storyKey(title, link),
          };
        })
        .filter((i) => i.title)
        .slice(0, 30);
    }),
  );
  return lists.flat();
}

/**
 * The stories Claude may pick from: never one that's already had its 4 hours, and only the
 * newest. Each group (world, tech) uses the shortest look-back that still gives Claude a choice.
 */
function candidates(items: Item[], seen: Record<string, Seen>, now: number): Item[] {
  const usable = items.filter((i) => !(seen[i.key] && now - seen[i.key].at >= RETIRE_AFTER));
  const pick = (world: boolean, need: number) => {
    const group = usable.filter((i) => i.world === world);
    for (const w of WINDOWS) {
      const recent = group.filter((i) => i.at && now - i.at <= w);
      if (recent.length >= need * 2 || w === WINDOWS[WINDOWS.length - 1]) {
        // Undated stories only as a last resort (their time on screen is still capped).
        return (recent.length >= need ? recent : [...recent, ...group.filter((i) => !i.at)]).sort((a, b) => b.at - a.at);
      }
    }
    return [];
  };
  return [...pick(true, WORLD), ...pick(false, COUNT - WORLD)];
}

async function update(env: Env, cached: Cached | null): Promise<Cached> {
  const now = Date.now();
  // Forget stories retired long ago; keep the rest out of the list.
  const seen: Record<string, Seen> = Object.fromEntries(Object.entries(cached?.seen ?? {}).filter(([, v]) => now - v.at < REMEMBER));
  for (const s of cached?.stories ?? []) {
    const key = s.key ?? storyKey(s.title, s.link ?? "");
    seen[key] ??= { at: s.shown ?? Date.parse(cached!.at), line: s.line };
  }

  const all = await fetchFeeds();
  const items = candidates(all, seen, now);
  if (!items.length) {
    if (cached && all.length) {
      // Feeds are up but nothing new is left: drop what's had its 4 hours rather than keep it.
      const kept = { ...cached, checked: now, seen, stories: cached.stories.filter((s) => now - (s.shown ?? now) < MAX_ON_SCREEN) };
      await env.TOKENS.put(CACHE_KEY, JSON.stringify(kept), { expirationTtl: REMEMBER / 1000 });
      return kept;
    }
    if (cached) return cached;
    throw new Error("News feeds are unreachable right now.");
  }
  const sig = await signature(items.map((i) => i.key));
  if (cached?.sig === sig && !dueToRetire(cached, now)) {
    // Nothing new and nothing to retire: keep the picks, just note that we checked.
    const same = { ...cached, checked: now, seen };
    await env.TOKENS.put(CACHE_KEY, JSON.stringify(same), { expirationTtl: REMEMBER / 1000 });
    return same;
  }

  // Topics that were up for their 4 hours in the last day, so Claude moves on from them.
  const retired = Object.values(seen)
    .filter((v) => now - v.at >= RETIRE_AFTER && now - v.at < 28 * HOUR)
    .sort((a, b) => b.at - a.at)
    .slice(0, 40)
    .map((v) => `- ${v.line}`);

  const picked = (await ask(
    env,
    `Pick exactly ${COUNT} stories for the founder of an AI music-video startup. They want the newest news: ` +
      "each story shows how long ago it was published, so strongly favor the most recent ones. " +
      `First, the ${WORLD} most important world news stories from BBC World or NPR World: wars and conflicts, ` +
      "geopolitics, major elections, the global economy, big disasters. Skip minor or local stories there. " +
      `Then ${COUNT - WORLD} from Morning Brew, Tech Brew, TechCrunch and BBC Technology. Relevant there: AI, tech, startups, ` +
      "venture funding, big tech, markets, crypto, chips, policy that affects tech, the creator economy and music industry. " +
      "Never pick stories they don't care about, even to reach the count: celebrities and movie casting (e.g. a new Bond), " +
      "gift guides, lifestyle, college and student trends (e.g. international students leaving the US), sports, food, travel. " +
      "When two are about as new and relevant, prefer Morning Brew. List the world stories first. " +
      "Never two picks about the same company or event. " +
      (retired.length
        ? "These topics were already on their screen for hours, so skip them unless a story reports a clearly new development, " +
          "and then make the line say what's new:\n" + retired.join("\n") + "\n"
        : "") +
      'For each, give its number and a plain, factual line of at most 36 characters, e.g. "Nvidia beats earnings, outlook murky". No emoji, no quotes.',
    items.map((i, n) => `[${n}] (${i.source}, ${i.at ? ago(now - i.at) : "undated"}) ${i.title}: ${i.summary}`).join("\n"),
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

  const used = new Set<number>();
  const list: Story[] = picked.picks
    .filter((p) => items[p.n] && !used.has(p.n) && used.add(p.n))
    .slice(0, COUNT)
    .map((p) => {
      const it = items[p.n];
      const line = p.line.length <= 38 ? p.line : p.line.slice(0, 38).replace(/\s+\S*$/, "");
      // A story that was already up keeps its original start time, so its 4 hours don't reset.
      const shown = seen[it.key]?.at ?? now;
      seen[it.key] ??= { at: shown, line };
      return { line, title: it.title, text: it.text || it.summary, link: it.link, key: it.key, shown };
    });
  if (!list.length) throw new Error("No stories picked.");
  const out: Cached = { at: new Date(now).toISOString(), checked: now, sig, stories: list, seen };
  await env.TOKENS.put(CACHE_KEY, JSON.stringify(out), { expirationTtl: REMEMBER / 1000 });
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

export async function article(env: Env, n: number, line?: string): Promise<{ title: string; summary: string }> {
  // Use the list you're looking at (no refresh). Match by headline first, since the list
  // may have moved on since the glasses last loaded it.
  const { stories: list } = await stories(env, false);
  const story = (line && list.find((s) => s.line === line)) || list[n];
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
