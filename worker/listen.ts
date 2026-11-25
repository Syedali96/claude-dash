// "Listen" card: the glasses keep the last 2 minutes of a conversation in the
// phone's memory. When Ali taps, that audio comes here once: Groq turns it into
// text, and Claude explains the topic being discussed. Nothing is stored or logged.
import Anthropic from "@anthropic-ai/sdk";
import { transcribe } from "./gym";
import type { Env } from "./index";

interface ListenRequest {
  audio?: string; // base64 16 kHz PCM, the last ~2 minutes
  text?: string; // or a typed transcript (used for testing)
  now?: string;
  timeZone?: string;
}

export interface Explainer { topic: string; points: string[] }

const SYSTEM = `Ali is wearing smart glasses during a live conversation. You get a rough speech-to-text
transcript of the last couple of minutes (no speaker labels, may have errors). He tapped because he
wants to quickly understand what's being discussed, so he can follow along and educate himself.

Pick the ONE topic most worth explaining: usually the most recent concept, term, company, person,
event or claim that came up, favoring things a smart founder might not know in depth. Then explain it.
Use web_search only when the topic depends on recent facts (news, prices, new products).

Reply in exactly this plain-text format, nothing else:
TOPIC: <2 to 5 words>
- <key point, at most 55 characters>
- <key point>
- <key point>
- <key point>
Give 4 to 6 points, most useful first: what it is, why it matters, then a useful detail or number.
No markdown, no emoji, no source links. If the transcript has nothing to explain, reply only: TOPIC: NONE`;

/** "TOPIC: X\n- a\n- b" → { topic, points } */
export function parseExplainer(text: string): Explainer {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const t = lines.find((l) => /^topic:/i.test(l));
  const topic = (t ?? "").replace(/^topic:\s*/i, "").trim();
  const points = lines.filter((l) => /^[-•*◆]\s*/.test(l)).map((l) => l.replace(/^[-•*◆]\s*/, "").trim()).filter(Boolean);
  if (!topic || /^none$/i.test(topic)) return { topic: "", points: [] };
  return { topic, points: points.length ? points : lines.filter((l) => l !== t).slice(0, 6) };
}

export async function listen(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as ListenRequest;
  let transcript = body.text?.trim() ?? "";
  if (!transcript && body.audio) {
    const pcm = Uint8Array.from(atob(body.audio), (c) => c.charCodeAt(0));
    if (pcm.length < 16_000 * 2 * 1.5) return Response.json({ topic: "", points: [] });
    transcript = await transcribe(env, pcm, "A conversation between two or more people.");
  }
  if (transcript.split(/\s+/).length < 4) return Response.json({ topic: "", points: [] });

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const final = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 1 }],
    messages: [{
      role: "user",
      content: `(Now: ${body.now ?? new Date().toISOString()}, time zone ${body.timeZone || "America/New_York"})\nTranscript:\n${transcript.slice(-6000)}`,
    }],
  });
  if (final.stop_reason === "refusal") return Response.json({ topic: "", points: [] });
  // Only the text after the last search, so notes made before searching aren't shown.
  const lastTool = final.content.map((b) => b.type !== "text").lastIndexOf(true);
  const text = final.content.slice(lastTool + 1).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
  return Response.json(parseExplainer(text));
}
