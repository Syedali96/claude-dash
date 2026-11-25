// Gym log: the glasses send raw mic audio, Groq's free Whisper turns it into
// text, and we pull out exercise / weight / reps. Claude only steps in when the
// sentence is too messy for the simple parser.
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./index";

const SAMPLE_RATE = 16_000; // glasses mic: 16 kHz, 16-bit, mono

export interface GymSet {
  exercise: string;
  weight: number; // 0 for bodyweight
  unit: "lb" | "kg";
  reps: number;
}

/** Wrap raw PCM in a WAV header so Whisper accepts it. */
function wav(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

export async function transcribe(env: Env, pcm: Uint8Array, hint?: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([wav(pcm)], { type: "audio/wav" }), "set.wav");
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", "en");
  form.append("response_format", "json");
  form.append("prompt", hint ?? "Gym log. Bench press, 185 pounds, 8 reps. Squat, 100 kilos, 5 reps. Pull-ups, 12 reps.");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: form,
  });
  if (res.status === 401) throw new Error("Groq key is invalid.");
  if (res.status === 429) throw new Error("Groq free limit hit. Try again in a minute.");
  if (!res.ok) throw new Error(`Speech-to-text error ${res.status}`);
  return ((await res.json()) as { text?: string }).text?.trim() ?? "";
}

const FILLER = /\b(um+|uh+|so|i|just|did|do|doing|a|set|of|at|with|and|for|times|x|reps?|repetitions?|pounds?|lbs?|kilos?|kilograms?|kgs?)\b/g;
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** Handles the usual "bench press, 185, 8 reps" shapes without calling Claude. */
export function quickParse(text: string): GymSet | null {
  const t = text.toLowerCase().replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim();
  const nums = [...t.matchAll(/\d+(?:\.\d+)?/g)].map((m) => ({ n: Number(m[0]), at: m.index! }));
  if (!nums.length || nums.length > 2) return null;
  const exercise = titleCase(t.slice(0, nums[0].at).replace(FILLER, " ").replace(/\s+/g, " ").trim());
  if (!exercise || exercise.length > 30) return null;
  const unit = /\b(kilo|kilos|kilograms?|kgs?)\b/.test(t) ? "kg" : "lb";
  if (nums.length === 2) return { exercise, weight: nums[0].n, unit, reps: Math.round(nums[1].n) };
  // One number: bodyweight reps ("pull-ups 12 reps").
  if (/\brep/.test(t)) return { exercise, weight: 0, unit, reps: Math.round(nums[0].n) };
  return null;
}

const SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    exercise: { type: "string" },
    weight: { type: "number" },
    unit: { type: "string", enum: ["lb", "kg"] },
    reps: { type: "integer" },
  },
  required: ["found", "exercise", "weight", "unit", "reps"],
  additionalProperties: false,
};

async function claudeParse(env: Env, text: string): Promise<GymSet | null> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 1000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system:
      "Extract one gym set from a spoken, speech-to-text sentence. Use a short, standard exercise name in Title Case. " +
      "Weight is 0 for bodyweight moves. Default unit is lb unless kilos are said. Set found=false if it isn't a gym set.",
    messages: [{ role: "user", content: text }],
  });
  if (response.stop_reason === "refusal") return null;
  const out = JSON.parse(response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")) as GymSet & { found: boolean };
  if (!out.found || !out.exercise || out.reps <= 0) return null;
  return { exercise: out.exercise, weight: out.weight, unit: out.unit, reps: out.reps };
}

export async function parseSet(req: Request, env: Env): Promise<{ text: string; set: GymSet | null }> {
  if (!env.GROQ_API_KEY) throw new Error("Groq key missing on the server.");
  const pcm = new Uint8Array(await req.arrayBuffer());
  if (pcm.length < SAMPLE_RATE * 2 * 0.3) return { text: "", set: null }; // under 0.3 s: nothing said
  const text = await transcribe(env, pcm);
  if (!text) return { text, set: null };
  return { text, set: quickParse(text) ?? (await claudeParse(env, text)) };
}
