// Stale-while-revalidate over KV: a request always gets the saved copy at once,
// and a copy older than `freshMs` is refreshed in the background for next time.
// Only a first-ever request (nothing saved yet) waits for the real work.
import type { Env } from "./index";

export interface Ctx { waitUntil(p: Promise<unknown>): void }

interface Saved<T> { at: number; v: T }


export async function peek<T>(env: Env, key: string): Promise<Saved<T> | null> {
  const raw = await env.TOKENS.get(key);
  return raw ? (JSON.parse(raw) as Saved<T>) : null;
}

/** Run `compute` and save its result. A null result (e.g. not connected) isn't saved. */
// (No sharing of in-flight refreshes between requests: Workers can cancel another request's I/O.)
export async function refresh<T>(env: Env, key: string, compute: () => Promise<T>, keepSec: number): Promise<T> {
  const v = await compute();
  if (v != null) await env.TOKENS.put(key, JSON.stringify({ at: Date.now(), v }), { expirationTtl: keepSec });
  return v;
}

export async function swr<T>(
  env: Env, ctx: Ctx | undefined, key: string, freshMs: number, compute: () => Promise<T>, keepSec = 24 * 3600,
): Promise<T> {
  const hit = await peek<T>(env, key);
  if (hit && Date.now() - hit.at < freshMs) return hit.v;
  if (hit && ctx) {
    ctx.waitUntil(refresh(env, key, compute, keepSec).catch((e) => console.error("refresh", key, e)));
    return hit.v;
  }
  if (!hit) return refresh(env, key, compute, keepSec);
  return refresh(env, key, compute, keepSec).catch(() => hit.v); // an old copy beats an error
}
