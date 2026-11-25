import {
  AppLocationAccuracy,
  AudioInputSource,
  DeviceConnectType,
  type EvenAppBridge,
  type EvenHubEvent,
  OsEventTypeList,
  waitForEvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { ApiError, api } from "./api";
import { alertFrame, alertPages, askPages, type AgendaEvent, briefPages, CARDS, type EmailAlert, type Markets, type DashState, fmtSet, footer, header, type InboxData, inboxPages, readerPages, restFor, sessionSets, summaryPages, TODAY_PAGES, storyLines, type WhoopToday } from "./cards";
import { drawBlank, drawFrame, type Frame, MENU, shapeChanged, updateRegion, updateTile } from "./layout";
import { canonicalName, exerciseKey, nextTip } from "./exercises";
import { mountPhoneUI } from "./phone";
import { type LoggedSet, loadGym, loadSettings, saveGym, saveSettings } from "./settings";

type Gesture = "next" | "prev" | "tap" | "double" | "long";

let bridge: EvenAppBridge | null = null;
let current = 0;
let battery: number | null = null;
let lastFrame: Frame | null = null;
const st: DashState = {
  settings: await loadSettings(null),
  now: new Date(),
  weather: null,
  brief: { text: "", at: null, loading: false, error: null },
  news: null,
  markets: null,
  alerts: [],
  alertView: null,
  newsCursor: 0,
  reader: null,
  agendaPage: 0,
  agenda: { events: null, loading: false, error: null, notConnected: false },
  inbox: { data: null, loading: false, error: null, page: 0 },
  whoop: null,
  briefPage: 0,
  ask: { phase: "ready", followUp: false, question: "", lines: [], page: 0, history: [], error: null },
  gym: {
    sets: await loadGym(null), recording: false, busy: false, message: null, restEndsAt: null, restLabel: "", notice: null,
    recovery: null, sessionStart: 0, summary: null,
  },
};

function frame(): Frame {
  const id = st.settings.cards[current];
  const body = alertFrame(st)?.body ?? CARDS[id].body(st); // a new-email pop-up covers the card
  return { ...header(st, current, battery), body, ...footer(st, current) };
}

/** Redraw what changed. Full rebuild only when the card itself changes. */
async function render(full = false) {
  const f = frame();
  phone.preview(f);
  if (!bridge || asleep) return;
  if (full || !lastFrame || shapeChanged(lastFrame, f)) {
    await drawFrame(bridge, f, st.settings);
  } else {
    if (f.title !== lastFrame.title) await updateRegion(bridge, "title", f.title);
    if (f.status !== lastFrame.status) await updateRegion(bridge, "status", f.status);
    if (f.dots !== lastFrame.dots) await updateRegion(bridge, "dots", f.dots);
    if (f.hint !== lastFrame.hint) await updateRegion(bridge, "hint", f.hint);
    // Same tiles in the same places: just swap the text that changed.
    const old = lastFrame.body.tiles;
    for (const [i, t] of f.body.tiles.entries()) if (t.text !== old[i]?.text) await updateTile(bridge, i, t.text);
  }
  lastFrame = f;
}

// ---------- data ----------

const WMO: Record<number, string> = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog",
  51: "drizzle", 53: "drizzle", 55: "drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 80: "showers", 81: "showers", 82: "heavy showers",
  95: "thunderstorm", 96: "thunderstorm", 99: "thunderstorm",
};

async function refreshWeather() {
  try {
    const loc = bridge
      ? await bridge.getAppLocation({ accuracy: AppLocationAccuracy.Low, timeoutMs: 5000 })
      : await new Promise<{ latitude: number; longitude: number } | null>((res) =>
          navigator.geolocation
            ? navigator.geolocation.getCurrentPosition((p) => res(p.coords), () => res(null), { timeout: 5000 })
            : res(null),
        );
    if (!loc) return;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude.toFixed(2)}&longitude=${loc.longitude.toFixed(2)}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`;
    const data = (await (await fetch(url)).json()) as { current: { temperature_2m: number; weather_code: number } };
    const t = Math.round(data.current.temperature_2m);
    st.weather = `${t}°F · ${WMO[data.current.weather_code] ?? "—"}`;
    await render();
  } catch (e) {
    console.warn("weather failed", e);
  }
}

// Open the app with ?demo to preview the Agenda design with sample meetings.
function demoAgenda(): AgendaEvent[] {
  const at = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const now = new Date();
  const liveStart = new Date(now.getTime() - 20 * 60_000).toISOString();
  const liveEnd = new Date(now.getTime() + 25 * 60_000).toISOString();
  const later = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();
  return [
    { title: "Founder focus block", start: at(0), end: at(0), allDay: true, series: false, video: false },
    { title: "Standup with Brandon", start: at(0, 30), end: at(0, 45), allDay: false, series: true, video: true },
    { title: "Investor call: seed round intro", start: liveStart, end: liveEnd, allDay: false, series: false, video: true },
    { title: "Reel shoot: AI music video demo", start: later(60), end: later(120), allDay: false, series: false, video: false },
    { title: "Weekly product review", start: later(180), end: later(240), allDay: false, series: true, video: true },
    { title: "Gym", start: later(300), end: later(360), allDay: false, series: true, video: false },
    { title: "Dinner with the team", start: later(420), end: later(480), allDay: false, series: false, video: false },
  ];
}

async function refreshAgenda() {
  if (new URLSearchParams(location.search).has("demo")) {
    st.agenda = { events: demoAgenda(), loading: false, error: null, notConnected: false };
    return render();
  }
  if (st.agenda.loading) return;
  st.agenda.loading = true;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  try {
    const q = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
    const data = await api<{ events: AgendaEvent[] }>(st.settings, `/api/agenda?${q}`);
    st.agenda = { events: data.events, loading: false, error: null, notConnected: false };
  } catch (e) {
    const notConnected = e instanceof ApiError && e.code === "not_connected";
    st.agenda = { ...st.agenda, loading: false, notConnected, error: e instanceof Error ? e.message : "Calendar error" };
  }
  await render();
}

function demoInbox(): InboxData {
  return {
    at: new Date().toISOString(),
    reply: [
      { line: "Paul: content review, 11/26 post", tag: "ech", ageHours: 3 },
      { line: "Rishi: register for TAP Dec 1", tag: "ech", ageHours: 16 },
      { line: "Bailey: needs COI", tag: "gml", ageHours: 31 },
      { line: "Apple Dev: upload enrollment docs", tag: "hel", ageHours: 150 },
    ],
    followup: [
      { line: "Sascha: chase label pilot", tag: "ech", ageHours: 47 },
      { line: "Brandon: chase project update", tag: "asy", ageHours: 120 },
    ],
    skipped: [],
    advice: "Reply to Paul first about the 11/26 post, then Rishi. Nudge Sascha on the label pilot.",
  };
}

async function refreshInbox() {
  if (new URLSearchParams(location.search).has("demo")) {
    st.inbox = { ...st.inbox, data: demoInbox(), loading: false, error: null };
    return render();
  }
  if (st.inbox.loading) return;
  st.inbox.loading = true;
  try {
    const data = await api<InboxData>(st.settings, "/api/inbox");
    st.inbox = { ...st.inbox, data, loading: false, error: null };
  } catch (e) {
    st.inbox = { ...st.inbox, loading: false, error: e instanceof Error ? e.message : "Inbox error" };
  }
  await render();
}

async function refreshWhoop() {
  try {
    const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
    st.whoop = await api<WhoopToday>(st.settings, `/api/whoop?tz=${tz}`);
    st.gym.recovery = st.whoop.recovery;
    await render();
  } catch {
    /* not connected yet: rest timer uses your base time */
  }
}

function todayRange() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  return { start, end };
}

async function refreshMarkets() {
  try {
    st.markets = await api<Markets>(st.settings, "/api/markets");
    await render();
  } catch {
    /* keep the last snapshot */
  }
}

// ---------- new-email alerts ----------

const ALERT_EVERY_MS = 2 * 60_000;
const POPUP_MS = 15_000; // an unopened pop-up closes itself after this
let alertsSince = Math.floor(Date.now() / 1000);
const seenAlerts = new Set<string>();

async function pollAlerts() {
  try {
    const data = await api<{ now: number; alerts: EmailAlert[] }>(st.settings, `/api/alerts?since=${alertsSince - 30}`);
    alertsSince = data.now;
    const fresh = data.alerts.filter((a) => !seenAlerts.has(a.id));
    fresh.forEach((a) => seenAlerts.add(a.id));
    if (!fresh.length) return;
    st.alerts = [...fresh, ...st.alerts].slice(0, 20);
    // While you're speaking to the glasses (Ask or Gym), just add to the badge.
    const recording = st.gym.recording || st.ask.phase === "listening" || st.ask.phase === "thinking";
    if (recording) return render();
    // Otherwise show it now: wake the display if it's asleep, and cover the current card.
    if (!st.alertView) st.alertView = { list: [...fresh], index: 0, expanded: false, page: 0, closeAt: Date.now() + POPUP_MS };
    lastInput = Date.now();
    if (asleep) asleep = false;
    await render(true);
  } catch {
    /* try again next time */
  }
}

function closeAlerts() {
  const v = st.alertView;
  if (v) {
    // Anything you opened is read; the rest stays in the [N new] badge.
    const read = new Set(v.list.slice(0, v.expanded ? v.index + 1 : v.index).map((a) => a.id));
    st.alerts = st.alerts.filter((a) => !read.has(a.id));
  }
  st.alertView = null;
  return render(true);
}

/** Gestures while a pop-up is showing. Returns true when it handled the gesture. */
async function alertGesture(g: Gesture): Promise<boolean> {
  const v = st.alertView;
  if (!v) return false;
  v.closeAt = null; // you're interacting: don't auto-close
  if (g === "tap") {
    if (!v.expanded) { v.expanded = true; v.page = 0; }
    else if (v.page + 1 < alertPages(st)) v.page++;
    else if (v.index + 1 < v.list.length) { v.index++; v.page = 0; }
    else { await closeAlerts(); return true; }
    await render();
    return true;
  }
  await closeAlerts(); // double tap, swipe or hold closes it
  return true;
}

async function refreshNews() {
  if (new URLSearchParams(location.search).has("demo")) {
    st.news = ["Anthropic IPO tests AI industry", "Nvidia posts strong earnings", "US curbs chip exports", "SpaceX catches Starship",
      "Kalshi hires Martha Stewart", "Students skip US colleges", "Pattinson named next Bond", "Pet gift guide 2026"];
    return render();
  }
  try {
    st.news = (await api<{ headlines: string[] }>(st.settings, "/api/news")).headlines;
    await render();
  } catch {
    /* keep the last headlines */
  }
}

/** Open the highlighted headline as an easy-to-read summary. */
async function openStory() {
  const n = st.newsCursor;
  const title = st.news?.[n] ?? "";
  st.reader = { title, lines: [], page: 0, loading: true, error: null };
  await render();
  try {
    const data = await api<{ title: string; summary: string }>(st.settings, `/api/news/article?n=${n}`);
    if (st.reader?.title !== title) return; // closed or changed meanwhile
    st.reader = { title: data.title, lines: storyLines(data.summary), page: 0, loading: false, error: null };
  } catch (e) {
    if (st.reader) st.reader = { ...st.reader, loading: false, error: e instanceof Error ? e.message : "Couldn't load it." };
  }
  await render();
}

async function refreshBrief() {
  if (st.brief.loading) return;
  st.brief = { ...st.brief, loading: true, error: null };
  await render();
  try {
    const data = await api<{ text?: string }>(st.settings, "/api/brief", {
      method: "POST",
      body: JSON.stringify({
        prompt: st.settings.briefPrompt,
        now: new Date().toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
        weather: st.weather ?? undefined,
        tasks: st.settings.tasks,
        gym: st.gym.sets.filter((x) => x.t >= todayRange().start.getTime()).map((x) => `${x.exercise} ${fmtSet(x)}`),
        dayStart: todayRange().start.toISOString(),
        dayEnd: todayRange().end.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    if (!data.text) throw new Error("Claude returned an empty brief.");
    st.brief = { text: data.text, at: new Date(), loading: false, error: null };
    st.briefPage = 0;
  } catch (e) {
    st.brief = { ...st.brief, loading: false, error: e instanceof Error ? e.message : "Could not reach Claude." };
  }
  await render();
}

// ---------- gym: voice logging ----------

let pcm: Uint8Array[] = [];
let recTimer: ReturnType<typeof setTimeout> | undefined;
const MAX_RECORD_MS = 10_000;

function toBytes(a: unknown): Uint8Array {
  if (a instanceof Uint8Array) return a;
  if (Array.isArray(a)) return Uint8Array.from(a as number[]);
  if (typeof a === "string") return Uint8Array.from(atob(a), (c) => c.charCodeAt(0));
  return new Uint8Array();
}

async function startRecording() {
  if (!bridge) {
    st.gym.message = "Voice logging works on the glasses.";
    return render();
  }
  pcm = [];
  const ok = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
  if (!ok) {
    st.gym.message = "Mic didn't start. Try again.";
    return render();
  }
  st.gym.recording = true;
  st.gym.message = null;
  recTimer = setTimeout(stopRecording, MAX_RECORD_MS);
  await render();
}

async function stopRecording() {
  clearTimeout(recTimer);
  if (!st.gym.recording || !bridge) return;
  st.gym.recording = false;
  st.gym.busy = true;
  await bridge.audioControl(false).catch(() => false);
  await render();

  const audio = new Uint8Array(pcm.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of pcm) { audio.set(c, at); at += c.length; }
  pcm = [];

  try {
    const today = sessionSets(st);
    const res = await api<{ text: string; command: GymCommand }>(st.settings, "/api/gym/command", {
      method: "POST",
      body: JSON.stringify({
        audio: toBase64(audio),
        today: today.map(({ exercise, weight, unit, reps }) => ({ exercise, weight, unit, reps })),
        known: knownExercises(),
      }),
    });
    await runGymCommand(res.command, res.text, today);
  } catch (e) {
    st.gym.message = e instanceof Error ? e.message : "Couldn't log that set.";
  }
  st.gym.busy = false;
  await render(true);
}

type GymCommand =
  | { action: "log"; set: Omit<LoggedSet, "t"> }
  | { action: "undo" }
  | { action: "delete"; target: number }
  | { action: "edit"; target: number; weight: number | null; reps: number | null; exercise: string | null }
  | { action: "finish" }
  | { action: "none" };

/** Every exercise name you've logged, most recent first (so the server reuses your names). */
function knownExercises(): string[] {
  const seen = new Map<string, string>();
  for (const s of [...st.gym.sets].reverse()) if (!seen.has(exerciseKey(s.exercise))) seen.set(exerciseKey(s.exercise), s.exercise);
  return [...seen.values()];
}

/** "Bench Press 185x8 (set 2)" */
function describe(set: LoggedSet, today: LoggedSet[]): string {
  const same = today.filter((x) => exerciseKey(x.exercise) === exerciseKey(set.exercise));
  const n = same.indexOf(set) + 1;
  return `${set.exercise} ${fmtSet(set)}${same.length > 1 ? ` (set ${n})` : ""}`;
}

async function removeSet(set: LoggedSet, today: LoggedSet[], wasLast: boolean) {
  const label = describe(set, today);
  st.gym.sets = st.gym.sets.filter((x) => x !== set);
  if (wasLast) st.gym.restEndsAt = null; // the rest was for the set you just removed
  st.gym.notice = `REMOVED   ${label}`;
  st.gym.message = st.gym.restEndsAt ? `Removed ${label}` : 'Say "undo" or "cancel that" anytime to remove the last set';
  await saveGym(bridge, st.gym.sets);
  phone.showGym(st.gym.sets);
}

async function runGymCommand(cmd: GymCommand, heard: string, today: LoggedSet[]) {
  st.gym.notice = null;
  switch (cmd.action) {
    case "log":
      return logSet(cmd.set);
    case "undo": {
      const last = today[today.length - 1];
      if (last) return removeSet(last, today, true);
      st.gym.message = "No sets to remove yet.";
      return;
    }
    case "delete": {
      const set = today[cmd.target - 1];
      if (set) return removeSet(set, today, cmd.target === today.length);
      break;
    }
    case "edit": {
      const set = today[cmd.target - 1];
      if (!set) break;
      const before = describe(set, today);
      if (cmd.weight != null) set.weight = cmd.weight;
      if (cmd.reps != null) set.reps = cmd.reps;
      if (cmd.exercise) set.exercise = canonicalName(cmd.exercise, knownExercises());
      st.gym.sets = [...st.gym.sets];
      await saveGym(bridge, st.gym.sets);
      phone.showGym(st.gym.sets);
      st.gym.notice = `FIXED   ${describe(set, sessionSets(st))}`;
      st.gym.message = st.gym.restEndsAt ? `Fixed: was ${before}` : `Was ${before}`;
      return;
    }
    case "finish":
      return finishWorkout();
  }
  st.gym.message = heard ? `Heard "${heard.slice(0, 28)}". Try again.` : "Didn't catch that. Tap to retry.";
}

/** "Workout complete": stop the timer and show the summary. */
async function finishWorkout() {
  st.gym.restEndsAt = null;
  st.gym.message = null;
  st.gym.summary = { end: Date.now(), page: 0 };
  refreshWhoop(); // fresh strain for the summary
}

async function closeSummary() {
  if (!st.gym.summary) return;
  st.gym.sessionStart = st.gym.summary.end + 1; // later sets start a new workout
  st.gym.summary = null;
  await render(true);
}

async function logSet(heard: Omit<LoggedSet, "t">) {
  const set = { ...heard, exercise: canonicalName(heard.exercise, knownExercises()) };
  // Show what you did last session for this exercise, so you know what to beat.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const key = exerciseKey(set.exercise);
  const before = st.gym.sets.filter((x) => exerciseKey(x.exercise) === key && x.t < today.getTime());
  st.gym.sets = [...st.gym.sets, { ...set, t: Date.now() }];
  await saveGym(bridge, st.gym.sets);
  const rest = restFor(st, set.exercise);
  st.gym.restEndsAt = Date.now() + rest.seconds * 1000;
  st.gym.restLabel = rest.label;
  const lastDay = before.length ? new Date(before[before.length - 1].t).toDateString() : null;
  const last = lastDay ? before.filter((x) => new Date(x.t).toDateString() === lastDay) : [];
  // Instead of last time's numbers, say what to aim for next.
  st.gym.message = `Logged ${fmtSet(set)}  ·  ${nextTip(set, last)}`;
  phone.showGym(st.gym.sets);
}

/**
 * Testing only (npm run dev): ?gymseed loads sample history, and ?gymtest=a|b|c runs
 * typed voice commands in order, so the gym flow can be checked in the simulator.
 */
async function gymDevTest() {
  if (!import.meta.env.DEV) return;
  const q = new URLSearchParams(location.search);
  if (q.has("gymseed")) {
    const day = (d: number, h: number, m: number) => { const t = new Date(); t.setDate(t.getDate() - d); t.setHours(h, m, 0, 0); return t.getTime(); };
    const s = (d: number, m: number, exercise: string, weight: number, reps: number): LoggedSet => ({ t: day(d, 18, m), exercise, weight, unit: "lb", reps });
    st.gym.sets = [
      s(4, 0, "Pull Down", 130, 10), s(4, 3, "Pull Down", 130, 10), s(4, 8, "Squat", 225, 8), s(4, 12, "Squat", 225, 8),
      s(3, 0, "Bench Press", 195, 5), s(3, 4, "Bench Press", 185, 8), s(3, 8, "Bench Press", 185, 7), s(3, 12, "Lateral Raise", 25, 12),
    ];
    await saveGym(bridge, st.gym.sets);
  }
  for (const text of (q.get("gymtest") ?? "").split("|").filter(Boolean)) {
    const today = sessionSets(st);
    const res = await api<{ text: string; command: GymCommand }>(st.settings, "/api/gym/command", {
      method: "POST",
      body: JSON.stringify({ text, today: today.map(({ exercise, weight, unit, reps }) => ({ exercise, weight, unit, reps })), known: knownExercises() }),
    });
    await runGymCommand(res.command, res.text, today);
    await new Promise((r) => setTimeout(r, 50)); // distinct timestamps
  }
  const i = st.settings.cards.indexOf("gym");
  if (q.has("gymtest") && i >= 0) current = i;
  // ?asktest=q1|q2 asks typed questions in one chat (each keeps the earlier ones as context).
  for (const text of (q.get("asktest") ?? "").split("|").filter(Boolean)) {
    const res = await api<{ question: string; answer: string }>(st.settings, "/api/ask", {
      method: "POST",
      body: JSON.stringify({ text, history: st.ask.history, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    st.ask = { ...st.ask, phase: "answer", question: res.question, lines: storyLines(res.answer), page: 0,
      history: [...st.ask.history, { q: res.question, a: res.answer }].slice(-6) };
    current = st.settings.cards.indexOf("ask");
  }
  await render(true);
}

// ---------- ask claude (voice) ----------

const ASK_MAX_MS = 15_000;
let askTimer: ReturnType<typeof setTimeout> | undefined;

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function startAsk(followUp: boolean) {
  if (!bridge) {
    st.ask = { ...st.ask, phase: "error", error: "Asking by voice works on the glasses." };
    return render(true);
  }
  pcm = [];
  const ok = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
  if (!ok) {
    st.ask = { ...st.ask, phase: "error", error: "Mic didn't start." };
    return render(true);
  }
  if (!followUp) st.ask.history = [];
  st.ask = { ...st.ask, phase: "listening", followUp, page: 0, error: null };
  askTimer = setTimeout(stopAsk, ASK_MAX_MS);
  await render(true);
}

async function cancelAsk() {
  clearTimeout(askTimer);
  if (st.ask.phase !== "listening") return;
  await bridge?.audioControl(false).catch(() => false);
  pcm = [];
  st.ask = { ...st.ask, phase: st.ask.lines.length ? "answer" : "ready" };
}

async function stopAsk() {
  clearTimeout(askTimer);
  if (st.ask.phase !== "listening" || !bridge) return;
  await bridge.audioControl(false).catch(() => false);
  const audio = new Uint8Array(pcm.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of pcm) { audio.set(c, at); at += c.length; }
  pcm = [];
  st.ask = { ...st.ask, phase: "thinking", question: "" };
  await render(true);
  try {
    const res = await api<{ question: string; answer: string }>(st.settings, "/api/ask", {
      method: "POST",
      body: JSON.stringify({
        audio: toBase64(audio),
        history: st.ask.history,
        now: new Date().toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    if (!res.question) st.ask = { ...st.ask, phase: "error", error: "Didn't catch that." };
    else {
      st.ask = {
        ...st.ask,
        phase: "answer",
        question: res.question,
        lines: storyLines(res.answer),
        page: 0,
        history: [...st.ask.history, { q: res.question, a: res.answer }].slice(-6),
      };
    }
  } catch (e) {
    st.ask = { ...st.ask, phase: "error", error: e instanceof Error ? e.message : "Couldn't reach Claude." };
  }
  await render(true);
}

// ---------- input ----------

function toGesture(ev: EvenHubEvent): Gesture | null {
  const src = ev.textEvent ?? ev.listEvent ?? ev.sysEvent;
  if (!src) return null;
  if (ev.sysEvent?.imuData) return null;
  // CLICK_EVENT is 0, which protobuf hosts often omit, so a missing type means tap.
  const t = src.eventType ?? OsEventTypeList.CLICK_EVENT;
  switch (t) {
    case OsEventTypeList.SCROLL_BOTTOM_EVENT: return "next";
    case OsEventTypeList.SCROLL_TOP_EVENT: return "prev";
    case OsEventTypeList.CLICK_EVENT: return "tap";
    case OsEventTypeList.DOUBLE_CLICK_EVENT: return "double";
    case OsEventTypeList.LONG_PRESS_EVENT: return "long";
    default: return null;
  }
}

async function onTap() {
  const id = st.settings.cards[current];
  if (id === "brief") {
    if (!st.brief.text) return refreshBrief();
    st.briefPage = (st.briefPage + 1) % briefPages(st).length;
    return render();
  }
  if (id === "agenda") {
    st.agendaPage = (st.agendaPage + 1) % TODAY_PAGES;
    if (st.agendaPage === 0) refreshAgenda();
    return render(true);
  }
  if (id === "news") {
    if (st.reader) {
      // Reading a story: next page, then back to the headlines.
      if (st.reader.loading) return;
      if (st.reader.page + 1 < readerPages(st)) st.reader.page++;
      else st.reader = null;
      return render();
    }
    if (!st.news?.length) return refreshNews();
    // Move the ">" to the next headline; after the last, start over with fresh prices.
    st.newsCursor = (st.newsCursor + 1) % st.news.length;
    if (st.newsCursor === 0) refreshMarkets();
    return render();
  }
  if (id === "ask") {
    const a = st.ask;
    if (a.phase === "listening") return stopAsk();
    if (a.phase === "thinking") return;
    if (a.phase === "answer" && a.page + 1 < askPages(st)) { a.page++; return render(); }
    return startAsk(a.history.length > 0); // keeps the conversation going; 2x starts fresh
  }
  if (id === "gym") {
    const sum = st.gym.summary;
    if (sum) {
      if (sum.page + 1 < summaryPages(st)) { sum.page++; return render(); }
      return closeSummary();
    }
    if (st.gym.recording) return stopRecording();
    if (!st.gym.busy) return startRecording();
    return;
  }
  if (id === "inbox") {
    // Next page; after the last page, start over with the latest mail.
    const next = st.inbox.page + 1;
    st.inbox.page = next >= inboxPages(st) ? 0 : next;
    if (st.inbox.page === 0 || !st.inbox.data) refreshInbox();
    return render();
  }
  await render();
}

// ---------- auto-sleep: blank the display when idle, any touch wakes it ----------

let asleep = false;
let lastInput = Date.now();

function busy(): boolean {
  return st.gym.recording || st.gym.busy || (st.gym.restEndsAt ?? 0) > Date.now() || st.ask.phase === "listening" || st.ask.phase === "thinking";
}

async function goToSleep() {
  asleep = true;
  if (bridge) await drawBlank(bridge).catch(() => {});
  lastFrame = null;
}

function sleepTick() {
  const secs = st.settings.sleepSeconds;
  const idleSince = Math.max(lastInput, st.gym.restEndsAt ?? 0);
  if (!asleep && bridge && secs > 0 && !busy() && Date.now() - idleSince > secs * 1000) goToSleep();
}

async function handle(g: Gesture) {
  lastInput = Date.now();
  if (asleep) {
    asleep = false; // a touch only wakes the display
    return render(true);
  }
  if (await alertGesture(g)) return;
  const n = st.settings.cards.length;
  const card = st.settings.cards[current];
  // Press and hold anywhere turns the display off; any touch turns it back on.
  if (g === "long") { await cancelAsk(); return goToSleep(); }
  // Leaving the Ask card while it listens cancels the question.
  if ((g === "next" || g === "prev") && card === "ask") await cancelAsk();
  // Ask: double tap starts a new chat (forgets the conversation).
  if (g === "double" && card === "ask") {
    if (st.ask.phase === "listening" || st.ask.phase === "thinking") return;
    st.ask = { ...st.ask, phase: "ready", followUp: false, question: "", lines: [], page: 0, history: [], error: null };
    return render(true);
  }
  // Day plan: double tap makes a new plan.
  if (g === "double" && card === "brief") return refreshBrief();
  // News: double tap opens the highlighted story (or closes it).
  if (g === "double" && card === "news") {
    if (st.reader) { st.reader = null; return render(); }
    if (st.news?.length) return openStory();
  }
  // Today: double tap opens the new emails behind the [N new] badge.
  if (g === "double" && card === "agenda" && st.alerts.length) {
    st.alertView = { list: [...st.alerts], index: 0, expanded: true, page: 0, closeAt: null };
    return render(true);
  }
  if (g === "next") { current = (current + 1) % n; return render(true); }
  if (g === "prev") { current = (current - 1 + n) % n; return render(true); }
  if (g === "double") { current = 0; st.agendaPage = 0; return render(true); }
  return onTap();
}

// ---------- phone-side settings ----------

const phone = mountPhoneUI(st.settings, {
  async onChange(s) {
    const serverChanged = s.serverUrl !== st.settings.serverUrl || s.accessToken !== st.settings.accessToken;
    st.settings = s;
    current = Math.min(current, s.cards.length - 1);
    await saveSettings(bridge, s);
    await render(true);
    if (serverChanged) { refreshAgenda(); refreshInbox(); refreshWhoop(); refreshBrief(); }
  },
  onGesture: (g) => handle(g),
  async onGymUndo() {
    st.gym.sets = st.gym.sets.slice(0, -1);
    st.gym.restEndsAt = null;
    st.gym.notice = null;
    st.gym.message = "Removed the last set.";
    await saveGym(bridge, st.gym.sets);
    phone.showGym(st.gym.sets);
    await render();
  },
});

// ---------- boot ----------

async function boot() {
  // Outside the Even app (a plain browser) there is no bridge: preview only.
  // The SDK returns a bridge object even without a host, so check for the
  // Even app's WebView handler (the simulator provides one too).
  const hasHost = () => !!(window as { flutter_inappwebview?: unknown }).flutter_inappwebview;
  for (let i = 0; i < 15 && !hasHost(); i++) await new Promise((r) => setTimeout(r, 100));
  bridge = hasHost() ? await waitForEvenAppBridge() : null;
  phone.setConnected(!!bridge);

  if (bridge) {
    st.settings = await loadSettings(bridge);
    st.gym.sets = await loadGym(bridge);
    phone.sync(st.settings);
    phone.showGym(st.gym.sets);
    bridge.onEvenHubEvent(async (ev) => {
      if (ev.audioEvent) {
        if (st.gym.recording || st.ask.phase === "listening") pcm.push(toBytes(ev.audioEvent.audioPcm));
        return;
      }
      if (ev.menuItemClickEvent) {
        const id = ev.menuItemClickEvent.itemID;
        if (id === MENU.refresh) {
          const i = st.settings.cards.indexOf("brief");
          if (i >= 0) { current = i; await render(true); }
          await refreshBrief();
        }
        if (id === MENU.home) await handle("double");
        if (id === MENU.close) await bridge!.shutDownPageContainer(0);
        return;
      }
      const g = toGesture(ev);
      if (g) await handle(g);
    });
    bridge.onDeviceStatusChanged((s) => {
      if (s.connectType === DeviceConnectType.Connected && typeof s.batteryLevel === "number") {
        battery = s.batteryLevel;
        render();
      }
    });
  }

  phone.showGym(st.gym.sets);
  await gymDevTest();
  if (!st.settings.cards.length) st.settings.cards = ["agenda"];
  await render(true);
  refreshWeather();
  refreshWhoop();
  if (st.settings.cards.includes("agenda")) refreshAgenda();
  if (st.settings.cards.includes("news")) { refreshNews(); refreshMarkets(); }
  if (st.settings.cards.includes("agenda")) {
    if (new URLSearchParams(location.search).has("alerttest")) alertsSince -= 86_400; // show the last day's alerts once
    pollAlerts();
  }
  if (st.settings.cards.includes("inbox")) refreshInbox();
  if (st.settings.cards.includes("brief")) refreshBrief();

  // Tick: clock every minute, gym rest timer every second while it runs.
  let lastMinute = -1;
  setInterval(() => {
    st.now = new Date();
    sleepTick();
    if (st.alertView?.closeAt && Date.now() > st.alertView.closeAt) closeAlerts();
    const minute = st.now.getMinutes();
    const card = st.settings.cards[current];
    const restVisible = card === "gym" && st.gym.restEndsAt && st.now.getTime() - st.gym.restEndsAt < 2000;
    if (minute !== lastMinute || restVisible) {
      lastMinute = minute;
      render();
    }
  }, 1000);
  setInterval(refreshWeather, 15 * 60_000);
  setInterval(refreshAgenda, 5 * 60_000);
  setInterval(refreshInbox, 15 * 60_000);
  setInterval(refreshWhoop, 20 * 60_000);
  setInterval(refreshNews, 30 * 60_000);
  setInterval(refreshBrief, 2 * 60 * 60_000); // keep the day plan current
  setInterval(refreshMarkets, 5 * 60_000);
  setInterval(pollAlerts, ALERT_EVERY_MS);
}

boot();
