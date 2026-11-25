// Google sign-in (OAuth) for your two Echonos accounts, plus Calendar reads.
// Read-only scopes: the server can never send, delete or change anything.
import type { Env } from "./index";

export const ACCOUNTS = {
  ali: "ali@echonos.ai",
  hello: "hello@echonos.ai",
  alisyed: "ali@ali-syed.com",
  personal: "syedbali1996@gmail.com",
} as const;
export type AccountKey = keyof typeof ACCOUNTS;

const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

const redirectUri = (origin: string) => `${origin}/auth/google/callback`;

export async function startAuth(env: Env, origin: string, account: AccountKey): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID) return new Response("GOOGLE_CLIENT_ID is not set yet. See SETUP.md.", { status: 500 });
  // One-time state value stops anyone else from completing a sign-in into your server.
  const state = crypto.randomUUID();
  await env.TOKENS.put(`oauth-state:${state}`, account, { expirationTtl: 600 });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    login_hint: ACCOUNTS[account],
    state,
  }).toString();
  return Response.redirect(url.toString(), 302);
}

export async function finishAuth(env: Env, origin: string, params: URLSearchParams): Promise<Response> {
  const state = params.get("state") ?? "";
  const account = (await env.TOKENS.get(`oauth-state:${state}`)) as AccountKey | null;
  if (!account) return page("Sign-in expired. Start again from the setup page.");
  await env.TOKENS.delete(`oauth-state:${state}`);
  if (params.get("error")) return page(`Google said: ${params.get("error")}`);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: params.get("code") ?? "",
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(origin),
      grant_type: "authorization_code",
    }),
  });
  const tokens = (await tokenRes.json()) as { access_token?: string; refresh_token?: string; error?: string };
  if (!tokens.access_token || !tokens.refresh_token) return page(`Sign-in failed: ${tokens.error ?? "no token returned"}`);

  // Make sure you signed in as the account this slot is for.
  const who = (await (
    await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
  ).json()) as { email?: string };
  if (who.email?.toLowerCase() !== ACCOUNTS[account]) {
    return page(`You signed in as ${who.email}, but this slot is for ${ACCOUNTS[account]}. Try again with the right account.`);
  }
  await env.TOKENS.put(`google:${account}`, JSON.stringify({ refresh_token: tokens.refresh_token, email: who.email }));
  return page(`Connected ${who.email}. You can close this tab.`);
}

export async function isConnected(env: Env, account: AccountKey): Promise<boolean> {
  return !!(await env.TOKENS.get(`google:${account}`));
}

/** Fresh access token for an account, or null if it was never connected. */
export async function accessToken(env: Env, account: AccountKey): Promise<string | null> {
  const cached = await env.TOKENS.get(`google-access:${account}`);
  if (cached) return cached;
  const stored = await env.TOKENS.get(`google:${account}`);
  if (!stored) return null;
  const { refresh_token } = JSON.parse(stored) as { refresh_token: string };
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) return null;
  await env.TOKENS.put(`google-access:${account}`, data.access_token, {
    expirationTtl: Math.max(60, (data.expires_in ?? 3600) - 120),
  });
  return data.access_token;
}

export interface AgendaEvent {
  title: string;
  start: string; // ISO date-time, or YYYY-MM-DD for all-day
  end: string;
  allDay: boolean;
  series: boolean; // part of a recurring meeting series
  location?: string;
  video: boolean; // has a Meet / Zoom link
}

interface GCalEvent {
  summary?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  recurringEventId?: string;
  location?: string;
  hangoutLink?: string;
  conferenceData?: unknown;
  attendees?: { self?: boolean; responseStatus?: string }[];
  eventType?: string;
}

export async function agenda(env: Env, timeMin: string, timeMax: string): Promise<AgendaEvent[] | null> {
  const token = await accessToken(env, "ali");
  if (!token) return null;
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.search = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  }).toString();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Calendar error ${res.status}`);
  const data = (await res.json()) as { items?: GCalEvent[] };
  return (data.items ?? [])
    .filter((e) => e.status !== "cancelled")
    .filter((e) => !e.attendees?.some((a) => a.self && a.responseStatus === "declined"))
    .filter((e) => e.eventType !== "workingLocation")
    .map((e) => ({
      title: e.summary?.trim() || "(no title)",
      start: e.start?.dateTime ?? e.start?.date ?? "",
      end: e.end?.dateTime ?? e.end?.date ?? "",
      allDay: !e.start?.dateTime,
      series: !!e.recurringEventId,
      location: e.location,
      video: !!(e.hangoutLink || e.conferenceData),
    }));
}

function page(message: string): Response {
  return new Response(
    `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Claude Dash</title>
     <body style="font:16px system-ui;padding:32px;background:#0e0f0f;color:#e8e8e6"><p>${message.replace(/</g, "&lt;")}</p></body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
