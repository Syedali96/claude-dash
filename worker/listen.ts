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
Answer right away from what you know. Reply in exactly this plain-text format, nothing else:
TOPIC: <2 to 5 words>
- <key point, at most 55 characters>
- <key point>
- <key point>
- <key point>
SEARCH: <a short web search query, or NONE>
Give 4 to 6 points, most useful first: what it is, why it matters, then a useful detail or number.
SEARCH is a query only when fresh facts would clearly help (recent news, earnings, prices, launches,
anything that may have changed since your training); otherwise NONE. Don't hedge in the points about
facts you'd search for. No markdown, no emoji, no source links.
If the transcript has nothing to explain, reply only: TOPIC: NONE`;

const LATEST_SYSTEM = `Search the web once, then reply with exactly one line, nothing else:
LATEST: <the single most useful fresh fact, at most 48 characters, with a number or date if possible>
Use the most recent figures available as of "Now" and name the period (e.g. "Q3 FY27"). Only include something new that the existing points don't already say. If nothing new, reply: LATEST: NONE
Plain text, no markdown, no links.`;

/** POST raw 16 kHz PCM, get back {text}. `?prev=` is the end of the transcript so far (helps Whisper). */
export async function listenTranscribe(req: Request, env: Env, url: URL): Promise<{ text: string }> {
  const pcm = new Uint8Array(await req.arrayBuffer());
  if (pcm.length < MIN_AUDIO) return { text: "" };
  const prev = (url.searchParams.get("prev") ?? "").slice(-200);
  return { text: await transcribe(env, pcm, prev || "A conversation between two or more people.") };
}

/**
 * Form fields: transcript (text so far), audio (optional raw PCM, the last few seconds), now, timeZone.
 * Streams plain text: "HEARD: ..." (if audio), "TOPIC: ...", "- point" lines, "SEARCH: query|NONE",
 * then, only when a search was asked for, "LATEST: fact|NONE" a few seconds later.
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
  const now = `(Now: ${form.get("now") ?? new Date().toISOString()}, time zone ${form.get("timeZone") || "America/New_York"})`;
  // Step 1: answer straight away from what Claude knows (no tools, so nothing waits on a search).
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 1500,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: `${now}\nTranscript:\n${transcript.slice(-6000)}` }],
  });

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  (async () => {
    try {
      if (heardLine) await writer.write(enc.encode(heardLine));
      let answer = "";
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          answer += ev.delta.text;
          await writer.write(enc.encode(ev.delta.text));
        }
      }
      await writer.write(enc.encode("\n")); // ends the SEARCH line so the phone can show "checking latest..."
      // Step 2: if fresh facts would help, search now and send one "LATEST:" line.
      const query = /^SEARCH:\s*(.+)$/im.exec(answer)?.[1]?.trim() ?? "";
      if (query && !/^none$/i.test(query)) {
        const res = await client.beta.messages.create({
          model: MODEL,
          max_tokens: 1000,
          output_config: { effort: "low" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: LATEST_SYSTEM,
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 1 }],
          messages: [{ role: "user", content: `${now}\nSearch for: ${query}\nExisting points:\n${answer.replace(/^SEARCH:.*$/im, "").trim()}` }],
        });
        const out = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        const latest = /^LATEST:\s*(.+)$/im.exec(out)?.[1]?.trim() ?? "NONE";
        await writer.write(enc.encode(`LATEST: ${latest}\n`));
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
