// Gym log: the glasses send raw mic audio, Groq's free Whisper turns it into
// text, and we pull out exercise / weight / reps. Claude only steps in when the
// sentence is too messy for the simple parser.
import Anthropic from "@anthropic-ai/sdk";
import { canonicalName, knownName } from "../src/exercises";
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

/** Old app versions: raw PCM in, one set out. */
export async function parseSet(req: Request, env: Env): Promise<{ text: string; set: GymSet | null }> {
  if (!env.GROQ_API_KEY) throw new Error("Groq key missing on the server.");
  const pcm = new Uint8Array(await req.arrayBuffer());
  if (pcm.length < SAMPLE_RATE * 2 * 0.3) return { text: "", set: null }; // under 0.3 s: nothing said
  const text = await transcribe(env, pcm);
  if (!text) return { text, set: null };
  return { text, set: quickParse(text) ?? (await claudeParse(env, text)) };
}

// ---------- voice commands: log, undo, delete, edit, finish ----------

export type GymCommand =
  | { action: "log"; set: GymSet }
  | { action: "undo" } // remove the last set
  | { action: "delete"; target: number } // 1-based position in today's list
  | { action: "edit"; target: number; weight: number | null; reps: number | null; exercise: string | null }
  | { action: "finish" }
  | { action: "none" };

interface CommandRequest {
  audio?: string; // base64 16 kHz PCM
  text?: string; // typed (for testing)
  today?: GymSet[]; // today's sets, oldest first
  known?: string[]; // every exercise name in your history
}

const FINISH = /\b(workout(?:'s| is)? (?:complete|done|finished|over)|(?:i'?m|i am) (?:all )?done|end(?:ing)? (?:the |my )?workout|finish(?:ed)? (?:the |my )?workout|that'?s (?:it|a wrap)(?: for (?:today|the day))?|done for (?:today|the day)|wrap (?:it )?up|session (?:complete|done|over))\b/;
const UNDO = /^(?:undo(?: that| it)?|cancel(?: that| it| the last(?: set)?)?|scratch that|delete (?:that|it|the last(?: set)?)|remove (?:that|it|the last(?: set)?)|never ?mind|take that back|oops|that was wrong)$/;
const EDIT_WORDS = /\b(cancel|delete|remove|undo|scratch|change|fix|make (?:that|it)|actually|instead|wrong|should be|update|edit|correct)\b/;

const COMMAND_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["log", "undo", "delete", "edit", "finish", "none"] },
    target: { type: "integer", description: "For delete/edit: the number of the set in today's list. 0 otherwise." },
    exercise: { type: "string", description: "For log: the exercise. For edit: a new exercise name, or empty to keep it." },
    weight: { type: "number", description: "For log/edit: the weight, 0 for bodyweight. -1 on edit to keep it." },
    unit: { type: "string", enum: ["lb", "kg"] },
    reps: { type: "integer", description: "For log/edit: reps. -1 on edit to keep it." },
  },
  required: ["action", "target", "exercise", "weight", "unit", "reps"],
  additionalProperties: false,
};

async function claudeCommand(env: Env, text: string, today: GymSet[], known: string[]): Promise<GymCommand> {
  const list = today.map((s, i) => `${i + 1}. ${s.exercise} ${s.weight ? `${s.weight}${s.unit} x ${s.reps}` : `${s.reps} reps`}`).join("\n") || "(no sets yet)";
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 1000,
    output_config: { effort: "low", format: { type: "json_schema", schema: COMMAND_SCHEMA } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system:
      "You run a voice gym log. The sentence came from speech-to-text, so allow for mis-hearings. Decide what the lifter wants:\n" +
      "- log: a new set. Use a short, standard exercise name in Title Case; if it is the same lift as one of the known names, use that exact known name. Weight 0 for bodyweight. Unit lb unless kilos are said.\n" +
      "- undo: remove the most recent set (\"cancel that\", \"scratch that\", \"delete the last one\").\n" +
      "- delete: remove a specific earlier set (\"delete my second bench set\"). Set target to its number in today's list.\n" +
      "- edit: fix a set (\"that was 10 reps\", \"change my last squat to 225\"). Target its number; -1 for fields that stay the same; exercise empty unless renamed.\n" +
      "- finish: the workout is over.\n" +
      "- none: anything else.\n" +
      "\"Last\" or \"that\" means the most recent matching set.",
    messages: [{ role: "user", content: `Today's sets:\n${list}\n\nKnown exercise names: ${known.join(", ") || "(none)"}\n\nThey said: "${text}"` }],
  });
  if (response.stop_reason === "refusal") return { action: "none" };
  const o = JSON.parse(response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")) as {
    action: GymCommand["action"]; target: number; exercise: string; weight: number; unit: "lb" | "kg"; reps: number;
  };
  const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= today.length;
  switch (o.action) {
    case "log":
      if (!o.exercise || o.reps <= 0) return { action: "none" };
      return { action: "log", set: { exercise: canonicalName(o.exercise, known), weight: Math.max(0, o.weight), unit: o.unit, reps: o.reps } };
    case "undo":
      return today.length ? { action: "undo" } : { action: "none" };
    case "delete":
      return valid(o.target) ? { action: "delete", target: o.target } : { action: "none" };
    case "edit":
      if (!valid(o.target)) return { action: "none" };
      return {
        action: "edit",
        target: o.target,
        weight: o.weight >= 0 ? o.weight : null,
        reps: o.reps > 0 ? o.reps : null,
        exercise: o.exercise ? canonicalName(o.exercise, known) : null,
      };
    default:
      return { action: o.action === "finish" ? "finish" : "none" };
  }
}

/** Ask Claude whether a new name is a lift you've already logged under another name. */
async function matchKnown(env: Env, name: string, known: string[]): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 500,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: { type: "object", properties: { match: { type: "string" } }, required: ["match"], additionalProperties: false } },
    },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system:
      "Is this gym exercise the same movement as one in the list (just said differently, e.g. \"seated pull down\" = \"Lat Pulldown\")? " +
      "Reply with the exact list name, or an empty string if it's a different exercise. Don't merge genuinely different lifts (incline vs flat bench, front vs back squat).",
    messages: [{ role: "user", content: `Exercise: ${name}\nList: ${known.join(", ")}` }],
  });
  if (response.stop_reason === "refusal") return name;
  const { match } = JSON.parse(response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")) as { match: string };
  return known.includes(match) ? match : name;
}

export async function gymCommand(req: Request, env: Env): Promise<{ text: string; command: GymCommand }> {
  const body = (await req.json()) as CommandRequest;
  const today = body.today ?? [];
  const known = [...new Set(body.known ?? [])].slice(0, 200);
  let text = body.text?.trim() ?? "";
  if (!text && body.audio) {
    if (!env.GROQ_API_KEY) throw new Error("Groq key missing on the server.");
    const pcm = Uint8Array.from(atob(body.audio), (c) => c.charCodeAt(0));
    if (pcm.length < SAMPLE_RATE * 2 * 0.3) return { text: "", command: { action: "none" } };
    text = await transcribe(env, pcm, "Gym log. Bench press, 185 pounds, 8 reps. Cancel that. Delete my second squat set. Workout complete.");
  }
  if (!text) return { text, command: { action: "none" } };

  const t = text.toLowerCase().replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim();
  if (FINISH.test(t)) return { text, command: { action: "finish" } };
  if (UNDO.test(t)) return { text, command: today.length ? { action: "undo" } : { action: "none" } };
  if (!EDIT_WORDS.test(t)) {
    const set = quickParse(text);
    if (set) {
      let exercise = canonicalName(set.exercise, known);
      // A name we don't recognize: check it isn't a lift you've logged under another name.
      if (exercise === set.exercise && !knownName(exercise) && known.length && !known.includes(exercise)) {
        exercise = await matchKnown(env, exercise, known).catch(() => exercise);
      }
      return { text, command: { action: "log", set: { ...set, exercise } } };
    }
  }
  return { text, command: await claudeCommand(env, text, today, known) };
}
