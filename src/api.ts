// Talks to the Claude Dash server. During `npm run dev` requests go to the
// local server through Vite (which adds the token); after deploying they go
// straight to your Worker URL with the token from settings.
import type { Settings } from "./settings";

declare const __BUILD_SERVER__: string;
declare const __BUILD_TOKEN__: string;
const token = (s: Settings) => s.accessToken || __BUILD_TOKEN__;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

export function serverBase(s: Settings): string {
  return (s.serverUrl.trim() || __BUILD_SERVER__).replace(/\/+$/, "");
}

export async function api<T>(s: Settings, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token(s)) headers.set("Authorization", `Bearer ${token(s)}`);
  if (typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let res: Response;
  try {
    res = await fetch(serverBase(s) + path, { ...init, headers });
  } catch {
    throw new ApiError("Can't reach the server.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Server error ${res.status}`, res.status, data.error);
  return data;
}

/** Like api(), but the reply is streamed text: onText gets everything received so far. */
export async function apiStream(s: Settings, path: string, init: RequestInit, onText: (soFar: string) => void): Promise<string> {
  const headers = new Headers(init.headers);
  if (token(s)) headers.set("Authorization", `Bearer ${token(s)}`);
  let res: Response;
  try {
    res = await fetch(serverBase(s) + path, { ...init, headers });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError("Can't reach the server.", 0);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? `Server error ${res.status}`, res.status, data.error);
  }
  if (!res.body?.getReader) { const t = await res.text(); onText(t); return t; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    onText(text);
  }
  return text;
}

/** Link to the one-time setup page (open it on your Mac to connect Google). */
export function setupUrl(s: Settings): string {
  const base = serverBase(s) || location.origin;
  return `${base}/setup${token(s) ? `?token=${encodeURIComponent(token(s))}` : ""}`;
}
