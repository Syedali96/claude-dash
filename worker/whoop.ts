// WHOOP sign-in (OAuth) and today's numbers: recovery, sleep, strain.
// Read-only. WHOOP replaces the refresh token on every refresh, so we always
// store the newest one.
import Anthropic from "@anthropic-ai/sdk";
import { type Ctx, refresh, swr } from "./cache";
import type { Env } from "./index";

const AUTH = "https://api.prod.whoop.com/oauth/oauth2/auth";
const TOKEN = "https://api.prod.whoop.com/oauth/oauth2/token";
const API = "https://api.prod.whoop.com/developer/v2";
const SCOPES = "offline read:recovery read:cycles read:sleep read:workout read:profile";
const CACHE_KEY = "whoop:today:v2";
const FRESH_MS = 20 * 60_000;
const KEEP_SECONDS = 6 * 3600;

const redirectUri = (origin: string) => `${origin}/auth/whoop/callback`;

export interface WhoopToday {
  recovery: number | null; // %
  hrv: number | null; // ms
  restingHr: number | null;
  recovery7d: number | null; // average of the last 7 days, for trend
  sleepPerformance: number | null; // %
  sleepHours: number | null;
  sleepNeedHours: number | null;
  sleepEfficiency: number | null; // % of time in bed actually asleep
  strain: number | null; // today's day strain (0-21)
  workouts: string[]; // e.g. "Weightlifting, strain 9.8"
}

export async function startWhoop(env: Env, origin: string): Promise<Response> {
  // WHOOP wants an 8-character state value.
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const state = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => chars[b % chars.length]).join("");
  await env.TOKENS.put(`whoop-state:${state}`, "1", { expirationTtl: 600 });
  const url = new URL(AUTH);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: env.WHOOP_CLIENT_ID,
    redirect_uri: redirectUri(origin),
    scope: SCOPES,
    state,
  }).toString();
  return Response.redirect(url.toString(), 302);
}

async function tokenRequest(env: Env, params: Record<string, string>) {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.WHOOP_CLIENT_ID, client_secret: env.WHOOP_CLIENT_SECRET, ...params }),
  });
  return (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
}

async function keep(env: Env, t: { access_token?: string; refresh_token?: string; expires_in?: number }) {
  if (t.refresh_token) await env.TOKENS.put("whoop", JSON.stringify({ refresh_token: t.refresh_token }));
  if (t.access_token)
    await env.TOKENS.put("whoop-access", t.access_token, { expirationTtl: Math.max(60, (t.expires_in ?? 3600) - 120) });
}

export async function finishWhoop(env: Env, origin: string, params: URLSearchParams): Promise<Response> {
  const state = params.get("state") ?? "";
  if (!state || !(await env.TOKENS.get(`whoop-state:${state}`))) return page("Sign-in expired. Start again from the setup page.");
  await env.TOKENS.delete(`whoop-state:${state}`);
  if (params.get("error")) return page(`WHOOP said: ${params.get("error")}`);
  const t = await tokenRequest(env, { grant_type: "authorization_code", code: params.get("code") ?? "", redirect_uri: redirectUri(origin) });
  if (!t.access_token || !t.refresh_token) return page(`WHOOP sign-in failed: ${t.error ?? "no token returned"}`);
  await keep(env, t);
  await env.TOKENS.delete(CACHE_KEY);
  return page("Connected WHOOP. You can close this tab.");
}

export async function whoopConnected(env: Env): Promise<boolean> {
  return !!(await env.TOKENS.get("whoop"));
}

async function whoopToken(env: Env): Promise<string | null> {
  const cached = await env.TOKENS.get("whoop-access");
  if (cached) return cached;
  const stored = await env.TOKENS.get("whoop");
  if (!stored) return null;
  const { refresh_token } = JSON.parse(stored) as { refresh_token: string };
  const t = await tokenRequest(env, { grant_type: "refresh_token", refresh_token, scope: "offline" });
  if (!t.access_token) return null;
  await keep(env, t);
  return t.access_token;
}

interface Records<T> { records?: T[] }
type Scored<S> = { score_state?: string; score?: S };

async function get<T>(token: string, path: string): Promise<T> {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`WHOOP ${path.split("?")[0]} ${res.status}`);
  return (await res.json()) as T;
}

const hours = (ms?: number) => (ms == null ? null : Math.round((ms / 3_600_000) * 10) / 10);
const round = (n?: number | null) => (n == null ? null : Math.round(n));

/** Today's WHOOP numbers: the saved copy at once, refreshed in the background after 20 minutes. null = not connected. */
export function whoopToday(env: Env, ctx?: Ctx, fresh = false): Promise<WhoopToday | null> {
  return fresh ? refresh(env, CACHE_KEY, () => fetchToday(env), KEEP_SECONDS) : swr(env, ctx, CACHE_KEY, FRESH_MS, () => fetchToday(env), KEEP_SECONDS);
}

async function fetchToday(env: Env): Promise<WhoopToday | null> {
  const token = await whoopToken(env);
  if (!token) return null;

  type Rec = Scored<{ recovery_score?: number; hrv_rmssd_milli?: number; resting_heart_rate?: number }>;
  type Sleep = Scored<{
    sleep_performance_percentage?: number;
    sleep_efficiency_percentage?: number;
    stage_summary?: { total_in_bed_time_milli?: number; total_awake_time_milli?: number };
    sleep_needed?: { baseline_milli?: number; need_from_sleep_debt_milli?: number; need_from_recent_strain_milli?: number; need_from_recent_nap_milli?: number };
  }> & { nap?: boolean };
  type Cycle = Scored<{ strain?: number }>;
  type Workout = Scored<{ strain?: number }> & { sport_name?: string; start?: string };

  const [rec, sleep, cycle, workouts] = await Promise.all([
    get<Records<Rec>>(token, "/recovery?limit=7"),
    get<Records<Sleep>>(token, "/activity/sleep?limit=5"),
    get<Records<Cycle>>(token, "/cycle?limit=1"),
    get<Records<Workout>>(token, `/activity/workout?limit=5&start=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`),
  ]);

  const recs = (rec.records ?? []).filter((r) => r.score_state === "SCORED" && r.score?.recovery_score != null);
  const latest = recs[0]?.score;
  const night = (sleep.records ?? []).find((s) => !s.nap && s.score_state === "SCORED")?.score;
  const asleep = night?.stage_summary
    ? (night.stage_summary.total_in_bed_time_milli ?? 0) - (night.stage_summary.total_awake_time_milli ?? 0)
    : undefined;
  const need = night?.sleep_needed;
  const needMs = need
    ? (need.baseline_milli ?? 0) + (need.need_from_sleep_debt_milli ?? 0) + (need.need_from_recent_strain_milli ?? 0) - (need.need_from_recent_nap_milli ?? 0)
    : undefined;

  const today: WhoopToday = {
    recovery: round(latest?.recovery_score),
    hrv: round(latest?.hrv_rmssd_milli),
    restingHr: round(latest?.resting_heart_rate),
    recovery7d: recs.length ? Math.round(recs.reduce((a, r) => a + (r.score?.recovery_score ?? 0), 0) / recs.length) : null,
    sleepPerformance: round(night?.sleep_performance_percentage),
    sleepEfficiency: round(night?.sleep_efficiency_percentage),
    sleepHours: hours(asleep),
    sleepNeedHours: hours(needMs),
    strain: cycle.records?.[0]?.score?.strain != null ? Math.round(cycle.records[0].score.strain * 10) / 10 : null,
    workouts: (workouts.records ?? [])
      .filter((w) => w.score_state === "SCORED")
      .map((w) => `${w.sport_name ?? "Workout"}, strain ${Math.round((w.score?.strain ?? 0) * 10) / 10}`),
  };
  return today;
}

/** One-paragraph summary for Claude's day plan. */
export function whoopText(w: WhoopToday): string {
  const parts = [
    w.recovery != null ? `Recovery ${w.recovery}% (7-day avg ${w.recovery7d ?? "?"}%)` : "Recovery not scored yet",
    w.hrv != null ? `HRV ${w.hrv} ms` : null,
    w.restingHr != null ? `resting HR ${w.restingHr}` : null,
    w.sleepHours != null ? `slept ${w.sleepHours} h of ${w.sleepNeedHours ?? "?"} h needed (performance ${w.sleepPerformance ?? "?"}%)` : null,
    w.strain != null ? `day strain so far ${w.strain}` : null,
    w.workouts.length ? `recent workouts: ${w.workouts.join("; ")}` : null,
  ];
  return parts.filter(Boolean).join(", ");
}

/**
 * Recommended bedtime, like WHOOP's sleep planner: wake time minus the time in bed
 * needed to get tonight's sleep need at your usual sleep efficiency. The alarm is
 * 7 AM, except Friday and Saturday nights (alarm off), which assume a 9 AM wake.
 */
export function bedtime(w: WhoopToday, timeZone: string): { bedtime: string; wake: string } {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(new Date());
  const wakeMin = weekday === "Fri" || weekday === "Sat" ? 9 * 60 : 7 * 60;
  const needH = w.sleepNeedHours ?? 8;
  const eff = Math.min(0.98, Math.max(0.75, (w.sleepEfficiency ?? 90) / 100));
  let bed = Math.round((wakeMin - (needH / eff) * 60) / 5) * 5;
  bed = ((bed % 1440) + 1440) % 1440;
  const fmt = (m: number) => {
    const h = Math.floor(m / 60), mm = m % 60;
    return `${h % 12 || 12}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  };
  return { bedtime: fmt(bed), wake: fmt(wakeMin) };
}

/**
 * WHOOP's API only returns numbers (no coaching text), so Claude turns them into
 * the one thing to do today to raise tomorrow's recovery. Cached per day + score.
 */
export async function whoopTip(env: Env, w: WhoopToday): Promise<string> {
  const key = `whoop:tip4:${new Date().toISOString().slice(0, 10)}:${w.recovery}:${w.sleepHours}`;
  const cached = await env.TOKENS.get(key);
  if (cached) return cached;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const r = await client.beta.messages.create({
    model: "claude-haiku-5-5", // measured Nov 25: ~1-1.2 s faster than Opus here, same answers,
    max_tokens: 600,
    output_config: { effort: "low" },
    system:
      "You are a WHOOP-style coach. From these numbers, write ONE short plain sentence (at most 26 characters, e.g. \"Walk 20 min, no late food\") " +
      "with the single most useful thing to do today to raise tomorrow's recovery. Their recommended bedtime " +
      "is already shown separately, so don't talk about what time to go to bed. No emoji, no quotes.",
    messages: [{ role: "user", content: whoopText(w) }],
  });
  const tip = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim().replace(/^"|"$/g, "");
  if (tip && r.stop_reason !== "refusal") await env.TOKENS.put(key, tip, { expirationTtl: 12 * 3600 });
  return tip;
}

function page(message: string): Response {
  return new Response(
    `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Claude Dash</title>
     <body style="font:16px system-ui;padding:32px;background:#0e0f0f;color:#e8e8e6"><p>${message.replace(/</g, "&lt;")}</p></body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
