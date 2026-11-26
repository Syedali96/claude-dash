// "Listen" card. While it's on, the phone sends each ~30 seconds of speech
// (silence already dropped) to /api/listen/transcribe and keeps the text for
// the last 2 minutes. On a tap it sends that transcript plus the last few
// seconds of audio to /api/listen, and Claude's explanation streams back line
// by line, so the topic shows first. Nothing is stored or logged.
import Anthropic from "@anthropic-ai/sdk";
import { transcribe } from "./gym";
import type { Env } from "./index";

// Measured Nov 25 with streaming: Opus at low effort shows its first words in ~0.6-0.9 s, same as
// Haiku, but Haiku tends to run a web search first (5-7 s). Haiku without web search is ~1.3 s total.
const MODEL = "claude-opus-5-5";
const MIN_AUDIO = 16_000 * 2 * 0.8; // under 0.8 s of speech isn't worth sending to Groq

const SYSTEM = `Ali is wearing smart glasses during a live conversation. You get a rough speech-to-text
transcript of the last couple of minutes (no speaker labels, may have errors). He tapped because he
wants to quickly understand what's being discussed, so he can follow along and educate himself.

Pick the ONE topic most worth explaining: usually the most recent concept, term, company, person,
event or claim that came up, favoring things a smart founder might not know in depth.
Decide first whether you need web_search (only for recent facts: news, prices, new products), and
search before writing anything.

Then reply in exactly this plain-text format, nothing else:
TOPIC: <2 to 5 words>
- <key point, at most 55 characters>
- <key point>
- <key point>
- <key point>
Give 4 to 6 points, most useful first: what it is, why it matters, then a useful detail or number.
No markdown, no emoji, no source links. If the transcript has nothing to explain, reply only: TOPIC: NONE`;

/** POST raw 16 kHz PCM, get back {text}. `?prev=` is the end of the transcript so far (helps Whisper). */
export async function listenTranscribe(req: Request, env: Env, url: URL): Promise<{ text: string }> {
  const pcm = new Uint8Array(await req.arrayBuffer());
  if (pcm.length < MIN_AUDIO) return { text: "" };
  const prev = (url.searchParams.get("prev") ?? "").slice(-200);
  return { text: await transcribe(env, pcm, prev || "A conversation between two or more people.") };
}

/**
 * Form fields: transcript (text so far), audio (optional raw PCM, the last few seconds), now, timeZone.
 * Streams plain text: "TOPIC: ...\n- point\n- point".
 */
export async function listen(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  let transcript = String(form.get("transcript") ?? "").trim();
  const audio = form.get("audio");
  let heard = ""; // the last few seconds, sent back first so the phone can keep them
  if (audio && typeof audio !== "string") {
    const pcm = new Uint8Array(await audio.arrayBuffer());
    if (pcm.length >= MIN_AUDIO) heard = (await transcribe(env, pcm, transcript.slice(-200) || undefined)).replace(/\s+/g, " ");
    transcript = `${transcript} ${heard}`.trim();
  }
  const heardLine = heard ? `HEARD: ${heard}\n` : "";
  const text = (t: string) => new Response(t, { headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" } });
  if (transcript.split(/\s+/).length < 4) return text(`${heardLine}TOPIC: NONE`);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 1500,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 1 }],
    messages: [{
      role: "user",
      content: `(Now: ${form.get("now") ?? new Date().toISOString()}, time zone ${form.get("timeZone") || "America/New_York"})\nTranscript:\n${transcript.slice(-6000)}`,
    }],
  });

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  (async () => {
    try {
      if (heardLine) await writer.write(enc.encode(heardLine));
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") await writer.write(enc.encode(ev.delta.text));
      }
    } catch (e) {
      await writer.write(enc.encode(`\nERROR: ${e instanceof Error ? e.message : "Claude error"}`)).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  // identity: compressing would hold the text back until the end instead of streaming it
  return new Response(readable, { headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache", "Content-Encoding": "identity" } });
}
