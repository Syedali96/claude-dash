// Everything you can change from the phone without touching code.
// Stored through the Even app's storage, so it survives restarts.
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

export type CardId = "agenda" | "news" | "inbox" | "gym" | "brief" | "ask";

export const CARD_LABELS: Record<CardId, string> = {
  agenda: "Today (schedule, WHOOP + inbox, email alerts)",
  news: "News (markets + top stories)",
  ask: "Ask Claude (voice)",
  inbox: "Inbox (reply + follow up)",
  gym: "Gym log (voice)",
  brief: "Day plan (Claude + WHOOP)",
};

export interface Settings {
  version: number;
  // Leave serverUrl blank while testing from your Mac (npm run dev).
  // After deploying, paste your Worker URL and access token here.
  serverUrl: string;
  accessToken: string;
  cards: CardId[]; // order on the glasses; leave one out to hide it
  briefPrompt: string;
  tasks: string[];
  sleepSeconds: number; // blank the glasses after this long with no input (0 = never)
  rest: { heavy: number; compound: number; isolation: number }; // seconds by lift type; WHOOP recovery adds to it
  use24h: boolean;
  // Brightness levels 0-4 (4 = brightest) for each region of the screen.
  brightness: { header: number; body: number; footer: number };
  showHints: boolean; // gesture hints in the footer
}

export const SETTINGS_VERSION = 11;

export const DAY_PLAN_PROMPT = "Suggest what I should focus on for the rest of today.";
const V5_PROMPT =
  "Plan the rest of my day: meetings, tasks, emails to answer, and when to hit the gym, matched to my energy. End with what WHOOP says I should do.";
const OLD_PROMPT = "Give me a focused brief for the next few hours: what to do first and anything to watch out for.";

export const DEFAULTS: Settings = {
  version: SETTINGS_VERSION,
  serverUrl: "",
  accessToken: "",
  cards: ["agenda", "news", "inbox", "gym", "brief", "ask"],
  briefPrompt: DAY_PLAN_PROMPT,
  tasks: ["Reply to investor emails", "Review reel cuts", "Gym at 6pm"],
  sleepSeconds: 30,
  rest: { heavy: 150, compound: 120, isolation: 60 },
  use24h: false,
  brightness: { header: 2, body: 4, footer: 1 },
  showHints: true,
};

const KEY = "claude-dash-settings";

export async function loadSettings(bridge: EvenAppBridge | null): Promise<Settings> {
  let raw = "";
  try {
    raw = bridge ? await bridge.getLocalStorage(KEY) : localStorage.getItem(KEY) ?? "";
  } catch {
    /* storage unavailable: use defaults */
  }
  if (!raw) return structuredClone(DEFAULTS);
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged = { ...structuredClone(DEFAULTS), ...parsed, brightness: { ...DEFAULTS.brightness, ...parsed.brightness }, rest: { ...DEFAULTS.rest, ...parsed.rest } };
    // v11 replaced one rest time with rest by lift type, and dropped read-aloud (the G2 has no speaker).
    delete (merged as Partial<Settings> & { restSeconds?: number; speakAnswers?: boolean }).restSeconds;
    delete (merged as Partial<Settings> & { restSeconds?: number; speakAnswers?: boolean }).speakAnswers;
    // v2 added the Agenda card: put it first for settings saved before then.
    if ((parsed.version ?? 1) < 2 && !merged.cards.includes("agenda")) merged.cards = ["agenda", ...merged.cards];
    // v3 added the Inbox card: put it right after Agenda.
    if ((parsed.version ?? 1) < 3 && !merged.cards.includes("inbox")) {
      const i = merged.cards.indexOf("agenda");
      merged.cards.splice(i + 1, 0, "inbox");
    }
    // v4 added the Gym card: put it after Inbox.
    if ((parsed.version ?? 1) < 4 && !merged.cards.includes("gym")) {
      const i = merged.cards.indexOf("inbox");
      merged.cards.splice(i + 1, 0, "gym");
    }
    // v5 turned the brief into a personal day plan (only if you never edited the prompt).
    if ((parsed.version ?? 1) < 5 && merged.briefPrompt === OLD_PROMPT) merged.briefPrompt = DAY_PLAN_PROMPT;
    // v7 removed Tasks and Focus; v8 removed Home and Teleprompter. Drop unknown cards.
    merged.cards = merged.cards.filter((c) => c in CARD_LABELS);
    if (!merged.cards.length) merged.cards = [...DEFAULTS.cards];
    // v9 gave News its own card (right after Today) and simplified the day plan prompt.
    if ((parsed.version ?? 1) < 9) {
      if (!merged.cards.includes("news")) merged.cards.splice(merged.cards.indexOf("agenda") + 1, 0, "news");
      if (merged.briefPrompt === V5_PROMPT || merged.briefPrompt === OLD_PROMPT) merged.briefPrompt = DAY_PLAN_PROMPT;
    }
    // v10 added the Ask Claude card at the end.
    if ((parsed.version ?? 1) < 10 && !merged.cards.includes("ask")) merged.cards.push("ask");
    merged.version = SETTINGS_VERSION;
    return merged;
  } catch {
    return structuredClone(DEFAULTS);
  }
}

// ---------- gym history (kept apart from settings; stays on the phone) ----------

export interface LoggedSet {
  t: number; // when it was logged (ms)
  exercise: string;
  weight: number;
  unit: "lb" | "kg";
  reps: number;
}

const GYM_KEY = "claude-dash-gym";
const GYM_MAX = 2000;

export async function loadGym(bridge: EvenAppBridge | null): Promise<LoggedSet[]> {
  try {
    const raw = bridge ? await bridge.getLocalStorage(GYM_KEY) : localStorage.getItem(GYM_KEY) ?? "";
    return raw ? (JSON.parse(raw) as LoggedSet[]) : [];
  } catch {
    return [];
  }
}

export async function saveGym(bridge: EvenAppBridge | null, sets: LoggedSet[]): Promise<void> {
  const raw = JSON.stringify(sets.slice(-GYM_MAX));
  try {
    if (bridge) await bridge.setLocalStorage(GYM_KEY, raw);
    else localStorage.setItem(GYM_KEY, raw);
  } catch {
    /* ignore */
  }
}

export async function saveSettings(bridge: EvenAppBridge | null, s: Settings): Promise<void> {
  const raw = JSON.stringify(s);
  try {
    if (bridge) await bridge.setLocalStorage(KEY, raw);
    else localStorage.setItem(KEY, raw);
  } catch {
    /* ignore */
  }
}
