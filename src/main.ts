import {
  AppLocationAccuracy,
  AudioInputSource,
  DeviceConnectType,
  type EvenAppBridge,
  EventSourceType,
  type EvenHubEvent,
  OsEventTypeList,
  waitForEvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { ApiError, api, apiStream } from "./api";
import { ASK, alertFrame, alertPages, askPages, LISTEN_DOT_MS, LISTEN_SECONDS, listenLines, listenPages, type AgendaEvent, briefPages, CARDS, type EmailAlert, type Markets, type DashState, fmtSet, footer, header, type InboxData, inboxPages, readerPages, restFor, sessionSets, summaryPages, TODAY_PAGES, storyLines, type WhoopToday } from "./cards";
import { drawBlank, drawFrame, type Frame, MENU, shapeChanged, updateRegion, updateTile } from "./layout";
import { canonicalName, exerciseKey, nextTip } from "./exercises";
import { mountPhoneUI } from "./phone";
import * as posture from "./posture";
import { type LoggedSet, loadGym, loadSettings, loadSnapshot, saveGym, saveSettings, saveSnapshot } from "./settings";

// ltap / ldouble: a tap or double tap on the LEFT arm of the glasses (opens Ask Claude).
type Gesture = "next" | "prev" | "tap" | "double" | "long" | "ltap" | "ldouble";

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
  saved: {},
  briefPage: 0,
  askOpen: false,
  ask: { phase: "ready", followUp: false, question: "", lines: [], page: 0, history: [], error: null },
  listen: { phase: "off", topic: "", lines: [], page: 0, error: null },
  gym: {
    sets: await loadGym(null), recording: false, busy: false, message: null, restEndsAt: null, restLabel: "", notice: null,
    recovery: null, sessionStart: 0, summary: null,
  },
};

function frame(): Frame {
  const id = st.settings.cards[current];
  // Ask Claude covers the current card (an email pop-up still goes on top).
  if (st.askOpen && !st.alertView) {
    return { ...header(st, current, battery), body: ASK.body(st), ...footer(st, current), cat: false };
  }
  // Listening: nothing on screen but three dim dots.
  if (id === "listen" && st.listen.phase === "listening" && !st.alertView) {
    return { title: " ", status: " ", body: CARDS.listen.body(st), dots: " ", hint: " " };
  }
  const body = alertFrame(st)?.body ?? CARDS[id].body(st); // a new-email pop-up covers the card
  return { ...header(st, current, battery), body, ...footer(st, current), cat: !!posture.catPose() };
}

/** How many text boxes differ between two frames with the same layout. */
function changes(a: Frame, b: Frame): number {
  let n = 0;
  for (const k of ["title", "status", "dots", "hint"] as const) if (a[k] !== b[k]) n++;
  b.body.tiles.forEach((t, i) => { if (t.text !== a.body.tiles[i]?.text) n++; });
  return n;
}

/**
 * Redraw what changed. Swapping a few texts in place is quicker and doesn't flicker; a full
 * rebuild is only for a new layout, lots of changes at once (like a new card), or `force`.
 */
async function render(force = false) {
  const f = touchTest ? touchFrame() : frame();
  phone.preview(f);
  if (!bridge || asleep) return;
  if (force || !lastFrame || shapeChanged(lastFrame, f) || changes(lastFrame, f) > 3) {
    await drawFrame(bridge, f, st.settings);
    posture.resetSent(); // a rebuilt page starts with an empty cat box
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
  if (f.cat) await posture.syncImage(bridge);
}

// ---------- posture cat ----------

/** The cat stays away while Ask, Listen, the gym or an email pop-up needs the screen. */
function catAllowed(): boolean {
  const card = st.settings.cards[current];
  if (st.askOpen || card === "listen" || card === "gym") return false;
  if (st.alertView || st.ask.streaming) return false;
  return st.ask.phase !== "listening" && st.ask.phase !== "thinking" && st.listen.phase === "off" && !st.gym.recording;
}

/** The cat appeared, changed or went away: redraw (on the blank screen too, if the display is off). */
async function catChanged() {
  if (!asleep) return render();
  if (!bridge) return;
  const cat = !!posture.catPose();
  await drawBlank(bridge, cat).catch(() => {});
  posture.resetSent();
  if (cat) await posture.syncImage(bridge);
}

// ---------- data ----------

// The last data each card showed, saved on the phone so the next launch can show it at once.
interface Snapshot {
  agenda?: { at: number; events: AgendaEvent[] };
  news?: { at: number; headlines: string[] };
  markets?: Markets;
  inbox?: { at: number; data: InboxData };
  whoop?: WhoopToday;
  brief?: { at: number; text: string };
  weather?: string;
}
let snap: Snapshot = {};
let snapTimer: ReturnType<typeof setTimeout> | undefined;

function remember(part: Partial<Snapshot>) {
  snap = { ...snap, ...part };
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => saveSnapshot(bridge, snap), 3000); // one write for a burst of refreshes
}

/** Show last launch's data straight away (each card refreshes right after). */
function restore(s: Snapshot | null) {
  if (!s) return;
  snap = s;
  if (s.agenda) { st.agenda.events = s.agenda.events; st.saved.agenda = s.agenda.at; }
  if (s.news) { st.news = s.news.headlines; st.saved.news = s.news.at; }
  if (s.markets) st.markets = s.markets;
  if (s.inbox) { st.inbox.data = s.inbox.data; st.saved.inbox = s.inbox.at; }
  if (s.whoop) { st.whoop = s.whoop; st.gym.recovery = s.whoop.recovery; }
  if (s.brief) st.brief = { text: s.brief.text, at: new Date(s.brief.at), loading: false, error: null };
  if (s.weather) st.weather = s.weather;
}

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
    remember({ weather: st.weather });
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
    delete st.saved.agenda;
    remember({ agenda: { at: Date.now(), events: data.events } });
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
    delete st.saved.inbox;
    remember({ inbox: { at: Date.now(), data } });
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
    remember({ whoop: st.whoop });
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
    remember({ markets: st.markets });
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
    const recording = st.gym.recording || st.ask.phase === "listening" || st.ask.phase === "thinking" || st.listen.phase !== "off";
    if (recording) return render();
    // Otherwise show it now: wake the display if it's asleep, and cover the current card.
    if (!st.alertView) st.alertView = { list: [...fresh], index: 0, expanded: false, page: 0, closeAt: Date.now() + POPUP_MS };
    lastInput = Date.now();
    if (asleep) asleep = false;
    await render();
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
  return render();
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
  if (st.reader) return; // don't swap stories while you're reading one
  try {
    st.news = (await api<{ headlines: string[] }>(st.settings, "/api/news")).headlines;
    st.newsCursor = Math.min(st.newsCursor, Math.max(0, st.news.length - 1));
    delete st.saved.news;
    remember({ news: { at: Date.now(), headlines: st.news } });
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

let briefBusy = false;

async function refreshBrief() {
  if (briefBusy) return;
  briefBusy = true;
  // With a plan already on screen, make the new one quietly in the background.
  st.brief = { ...st.brief, loading: !st.brief.text, error: null };
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
    remember({ brief: { at: Date.now(), text: data.text } });
  } catch (e) {
    st.brief = { ...st.brief, loading: false, error: e instanceof Error ? e.message : "Could not reach Claude." };
  }
  briefBusy = false;
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
    // Raw audio bytes (about a third smaller than base64 text).
    const form = new FormData();
    form.set("audio", new Blob([audio], { type: "application/octet-stream" }), "set.pcm");
    form.set("today", JSON.stringify(today.map(({ exercise, weight, unit, reps }) => ({ exercise, weight, unit, reps }))));
    form.set("known", JSON.stringify(knownExercises()));
    const res = await api<{ text: string; command: GymCommand }>(st.settings, "/api/gym/command", { method: "POST", body: form });
    await runGymCommand(res.command, res.text, today);
  } catch (e) {
    st.gym.message = e instanceof Error ? e.message : "Couldn't log that set.";
  }
  st.gym.busy = false;
  await render();
}

type GymCommand =
  | { action: "log"; set: Omit<LoggedSet, "t"> }
  | { action: "undo" }
  | { action: "delete"; target: number }
  | { action: "edit"; target: number; weight: number | null; reps: number | null; exercise: string | null }
  | { action: "finish" }
  | { action: "query"; exercise: string }
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
    case "query":
      return answerQuery(cmd.exercise);
  }
  st.gym.message = heard ? `Heard "${heard.slice(0, 28)}". Try again.` : "Didn't catch that. Tap to retry.";
}

/** "What was my last bench?": your last session for that lift, and where to start today. */
function answerQuery(name: string) {
  const key = exerciseKey(name);
  const all = st.gym.sets.filter((x) => exerciseKey(x.exercise) === key);
  const todayStr = new Date().toDateString();
  const earlier = all.filter((x) => new Date(x.t).toDateString() !== todayStr);
  const pool = earlier.length ? earlier : all;
  if (!pool.length) {
    st.gym.notice = `NO ${name.toUpperCase()} HISTORY YET`;
    st.gym.message = "Log a set and it'll be here next time";
    return;
  }
  const day = new Date(pool[pool.length - 1].t).toDateString();
  const last = pool.filter((x) => new Date(x.t).toDateString() === day);
  // Start from your heaviest set last time (most reps at that weight).
  const top = last.reduce((a, b) => (b.weight > a.weight || (b.weight === a.weight && b.reps > a.reps) ? b : a));
  const when = new Date(day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const unit = top.weight ? ` ${top.unit}` : "";
  const start = nextTip(top, []).replace(/^next:/, "start at");
  st.gym.notice = `LAST ${last[0].exercise.toUpperCase()}  ·  ${when}`;
  st.gym.message = `${last.map(fmtSet).join("  ")}${unit}  ·  ${start}`;
  if (st.gym.restEndsAt && st.gym.restEndsAt > Date.now()) st.gym.message = `Last ${last[0].exercise} (${when}): ${last.map(fmtSet).join(" ")}  ·  ${start}`;
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
  await render();
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
    st.askOpen = true;
    st.ask = { ...st.ask, phase: "thinking" };
    await askStream({ text });
  }
  await render();
}

// ---------- ask claude (voice) ----------

const ASK_MAX_MS = 15_000;
let askTimer: ReturnType<typeof setTimeout> | undefined;

async function startAsk(followUp: boolean) {
  if (!bridge) {
    st.ask = { ...st.ask, phase: "error", error: "Asking by voice works on the glasses." };
    return render();
  }
  pcm = [];
  const ok = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
  if (!ok) {
    st.ask = { ...st.ask, phase: "error", error: "Mic didn't start." };
    return render();
  }
  if (!followUp) st.ask.history = [];
  st.ask = { ...st.ask, phase: "listening", followUp, page: 0, error: null };
  askTimer = setTimeout(stopAsk, ASK_MAX_MS);
  await render();
}

async function cancelAsk() {
  clearTimeout(askTimer);
  if (st.ask.phase !== "listening") return;
  await bridge?.audioControl(false).catch(() => false);
  pcm = [];
  st.ask = { ...st.ask, phase: st.ask.lines.length ? "answer" : "ready" };
}

/** A left-arm tap (or 2x = new chat). Opens Ask and starts listening; then send, next page, follow-up. */
async function askGesture(newChat: boolean) {
  const a = st.ask;
  if (a.phase === "thinking" || a.streaming) {
    if (!st.askOpen) { st.askOpen = true; return render(); } // just show the answer that's coming
    return;
  }
  // The gym mic is busy: don't take it.
  if (st.gym.recording || st.gym.busy) return;
  if (!st.askOpen) {
    st.askOpen = true;
    st.alertView = null;
    if (st.listen.phase !== "off") await stopListen(); // one mic at a time
    if (newChat) st.ask = { ...st.ask, lines: [], question: "", page: 0, history: [] };
    return startAsk(!newChat && a.history.length > 0);
  }
  if (newChat) {
    await cancelAsk();
    st.ask = { ...st.ask, phase: "ready", followUp: false, question: "", lines: [], page: 0, history: [], error: null };
    return startAsk(false);
  }
  if (a.phase === "listening") return stopAsk();
  if (a.phase === "answer" && a.page + 1 < askPages(st)) { a.page++; return render(); }
  return startAsk(a.history.length > 0); // keeps the conversation going
}

/** Swipe while Ask is open: stop listening (nothing is sent) and go back to the card you were on. */
async function closeAsk() {
  await cancelAsk();
  st.askOpen = false;
  return render();
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
  await render();
  await askStream({ audio });
}

/**
 * Send the question and show the answer as it's written: the question you asked appears
 * first, then the answer fills in. "\x1e" in the stream means Claude went to look something
 * up, so the text before it was only a note and is dropped.
 */
async function askStream(q: { audio?: Uint8Array; text?: string }) {
  const form = new FormData();
  if (q.audio) form.set("audio", new Blob([q.audio], { type: "application/octet-stream" }), "ask.pcm");
  if (q.text) form.set("text", q.text);
  form.set("history", JSON.stringify(st.ask.history));
  form.set("now", new Date().toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
  form.set("timeZone", Intl.DateTimeFormat().resolvedOptions().timeZone);
  const parse = (text: string) => {
    const nl = text.indexOf("\n");
    const question = nl < 0 ? "" : text.slice(0, nl).replace(/^QUESTION:\s*/, "").trim();
    let rest = nl < 0 ? "" : text.slice(nl + 1);
    let error: string | null = null;
    const err = rest.match(/\nERROR: (.*)$/);
    if (err) { error = err[1]; rest = rest.slice(0, err.index); }
    return { headerDone: nl >= 0, question, answer: rest.slice(rest.lastIndexOf("\x1e") + 1).trim(), error };
  };
  let shown = "";
  const show = (text: string) => {
    const r = parse(text);
    if (!r.headerDone || !r.question) return;
    // Only redraw when a whole word arrived, so the glasses aren't flooded with updates.
    const visible = r.answer.replace(/\S*$/, "");
    const key = `${r.question}|${visible}`;
    if (key === shown || st.ask.phase === "listening") return;
    shown = key;
    st.ask = { ...st.ask, phase: "answer", streaming: true, question: r.question, lines: storyLines(visible || "..."), page: 0 };
    render();
  };
  try {
    const text = await apiStream(st.settings, "/api/ask", { method: "POST", body: form }, show);
    const r = parse(text);
    st.ask.streaming = false;
    if (st.ask.phase === "listening") return; // you started a new question meanwhile
    if (!r.question) st.ask = { ...st.ask, phase: "error", error: "Didn't catch that." };
    else if (r.error && !r.answer) st.ask = { ...st.ask, phase: "error", error: r.error };
    else {
      st.ask = {
        ...st.ask,
        phase: "answer",
        question: r.question,
        lines: storyLines(r.answer),
        page: 0,
        history: [...st.ask.history, { q: r.question, a: r.answer }].slice(-6),
      };
    }
  } catch (e) {
    st.ask = { ...st.ask, phase: "error", streaming: false, error: e instanceof Error ? e.message : "Couldn't reach Claude." };
  }
  await render();
}

// ---------- listen: transcribe as you talk, explain on tap ----------
//
// While it's on, speech (quiet stretches dropped) collects in `pending`. Every
// 30 seconds that goes to Groq in the background and the text is kept for the
// last 2 minutes. A tap only sends that text plus the few seconds not yet sent.

const BYTES_PER_SEC = 16_000 * 2; // 16 kHz, 16-bit, mono
const CHUNK_MS = 10_000; // short chunks: less left to transcribe when you tap
const QUIET_RMS = 150; // below this a mic chunk counts as silence (out of 32768)
const HANGOVER_MS = 700; // keep this much after speech so words aren't clipped
const MAX_PENDING = BYTES_PER_SEC * 60; // never hold more than a minute unsent

let pending: Uint8Array[] = [];
let pendingBytes = 0;
let lastQuiet: Uint8Array | null = null; // one chunk of lead-in before speech starts
let lastVoice = 0;
let segments: { seq: number; end: number; text: string }[] = [];
let seq = 0;
const inflight = new Set<Promise<void>>();
let chunkTimer: ReturnType<typeof setInterval> | undefined;
let listenAsk = 0; // ignores an answer that arrives after you went back or stopped
let listenAbort: AbortController | null = null;
let session = 0; // a chunk that comes back after you stopped (or restarted) is dropped

function rms(chunk: Uint8Array): number {
  const v = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  let sum = 0;
  const n = Math.floor(chunk.byteLength / 2);
  for (let i = 0; i < n; i++) { const x = v.getInt16(i * 2, true); sum += x * x; }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Keep speech, drop silence. Memory only. */
function keepAudio(chunk: Uint8Array) {
  const now = Date.now();
  const voiced = rms(chunk) >= QUIET_RMS;
  if (voiced) {
    if (now - lastVoice > HANGOVER_MS && lastQuiet) { pending.push(lastQuiet); pendingBytes += lastQuiet.length; }
    lastVoice = now;
  }
  if (voiced || now - lastVoice <= HANGOVER_MS) {
    pending.push(chunk);
    pendingBytes += chunk.length;
    while (pendingBytes > MAX_PENDING) pendingBytes -= pending.shift()!.length;
    lastQuiet = null;
  } else lastQuiet = chunk;
}

function takePending(): Uint8Array {
  const audio = new Uint8Array(pendingBytes);
  let at = 0;
  for (const c of pending) { audio.set(c, at); at += c.length; }
  pending = []; pendingBytes = 0;
  return audio;
}

/** The text of the last 2 minutes, oldest first. */
function transcript(): string {
  const cutoff = Date.now() - LISTEN_SECONDS * 1000;
  segments = segments.filter((x) => x.end >= cutoff);
  return segments.sort((a, b) => a.seq - b.seq).map((x) => x.text).filter(Boolean).join(" ");
}

/** Every 30 s: send the speech collected so far to Groq in the background. */
function sendChunk() {
  if (pendingBytes < BYTES_PER_SEC) return; // under a second of speech: wait for more
  const audio = takePending();
  const mine = ++seq;
  const prev = encodeURIComponent(transcript().slice(-200));
  const mySession = session;
  const p = api<{ text: string }>(st.settings, `/api/listen/transcribe?prev=${prev}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: audio,
  })
    .then((r) => { if (mySession === session) segments.push({ seq: mine, end: Date.now(), text: r.text }); })
    .catch(() => {
      // Put it back so the next chunk (or a tap) carries it, unless you stopped meanwhile.
      if (mySession !== session) return;
      pending.unshift(audio); pendingBytes += audio.length;
    })
    .finally(() => inflight.delete(p));
  inflight.add(p);
}

function resetListen() {
  session++;
  clearInterval(chunkTimer);
  pending = []; pendingBytes = 0; lastQuiet = null; lastVoice = 0;
  segments = []; seq = 0;
  inflight.clear();
}

async function startListen() {
  if (!bridge) {
    st.listen = { ...st.listen, phase: "error", error: "Listening works on the glasses." };
    return render();
  }
  resetListen();
  const ok = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
  if (!ok) {
    st.listen = { ...st.listen, phase: "error", error: "Mic didn't start." };
    return render();
  }
  st.listen = { phase: "listening", topic: "", lines: [], page: 0, error: null };
  chunkTimer = setInterval(sendChunk, CHUNK_MS);
  await render();
}

/** Mic off and everything (audio and text) thrown away. */
async function stopListen() {
  if (st.listen.phase === "off") return;
  listenAsk++;
  listenAbort?.abort();
  resetListen();
  st.listen = { phase: "off", topic: "", lines: [], page: 0, error: null };
  await bridge?.audioControl(false).catch(() => false);
}

/** Back to just the dots (the mic never stopped). */
function backToDots() {
  listenAsk++;
  listenAbort?.abort();
  st.listen = { phase: "listening", topic: "", lines: [], page: 0, error: null };
  return render();
}

/** "TOPIC: X\n- a\n- b" so far → topic and finished points (the last line may still be arriving). */
function parseStream(text: string, done: boolean): { topic: string; points: string[]; error: string | null; heard: string; checking: boolean; latest: string } {
  const lines = text.split("\n");
  if (!done) lines.pop(); // incomplete
  let topic = "";
  let points: string[] = [];
  let error: string | null = null;
  let heard = "";
  let search = "";
  let latest = "";
  let latestDone = false;
  for (const raw of lines.map((l) => l.trim())) {
    if (/^topic:/i.test(raw)) { topic = raw.replace(/^topic:\s*/i, ""); points = []; } // a new TOPIC replaces an earlier one
    else if (/^[-•*◆]\s*/.test(raw) && topic) points.push(raw.replace(/^[-•*◆]\s*/, ""));
    else if (/^error:/i.test(raw)) error = raw.replace(/^error:\s*/i, "");
    else if (/^heard:/i.test(raw)) heard = raw.replace(/^heard:\s*/i, "");
    else if (/^search:/i.test(raw)) search = raw.replace(/^search:\s*/i, "");
    else if (/^latest:/i.test(raw)) { latest = raw.replace(/^latest:\s*/i, ""); latestDone = true; }
  }
  if (/^none$/i.test(topic)) topic = "";
  if (/^none$/i.test(latest)) latest = "";
  const checking = !done && !!search && !/^none$/i.test(search) && !latestDone;
  return { topic, points, error, heard, checking, latest };
}

async function explain(typed?: string) {
  const id = ++listenAsk;
  listenAbort = new AbortController();
  st.listen = { ...st.listen, phase: "thinking", error: null };
  await render();
  // Wait for chunks already on their way to Groq, then add the few seconds not sent yet.
  if (inflight.size) await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, 2000))]);
  if (id !== listenAsk) return;
  const form = new FormData();
  form.set("transcript", typed ?? transcript());
  const tail = typed ? null : takePending();
  if (tail?.length) form.set("audio", new Blob([tail], { type: "application/octet-stream" }), "tail.pcm");
  form.set("now", new Date().toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
  form.set("timeZone", Intl.DateTimeFormat().resolvedOptions().timeZone);

  let shown = "";
  const show = async (text: string, done: boolean) => {
    if (id !== listenAsk) return;
    const r = parseStream(text, done);
    if (!r.topic) return;
    const key = `${r.topic}|${r.points.length}|${r.checking}|${r.latest}`;
    if (key === shown) return;
    const first = !shown;
    shown = key;
    // A fresh fact from the search goes on top, where it's seen without scrolling.
    const lines = [...(r.latest ? listenLines([r.latest], "> LATEST: ") : []), ...listenLines(r.points)];
    st.listen = { ...st.listen, phase: "answer", topic: r.topic, lines, checking: r.checking, page: st.listen.phase === "answer" ? st.listen.page : 0 };
    await render(first); // full redraw once for the topic tile, then just new points
  };
  try {
    const text = await apiStream(st.settings, "/api/listen", { method: "POST", body: form, signal: listenAbort.signal }, (t) => { show(t, false); });
    if (id !== listenAsk) return;
    const r = parseStream(text, true);
    // The server transcribed the unsent seconds: keep them for the next tap.
    if (r.heard) segments.push({ seq: ++seq, end: Date.now(), text: r.heard });
    if (r.error && !r.topic) st.listen = { ...st.listen, phase: "error", error: r.error };
    else if (!r.topic) st.listen = { ...st.listen, phase: "error", error: "Didn't hear enough to explain yet." };
    else { await show(text, true); return; }
  } catch (e) {
    if (id !== listenAsk) return;
    st.listen = { ...st.listen, phase: "error", error: e instanceof Error ? e.message : "Couldn't reach Claude." };
  }
  await render();
}

/** Testing only (npm run dev): ?savedtest pretends the cards are showing 40-minute-old saved data. */
function savedDevTest() {
  if (!import.meta.env.DEV || !new URLSearchParams(location.search).has("savedtest")) return;
  const at = Date.now() - 40 * 60_000;
  st.saved = { agenda: at, news: at, inbox: at };
}

/** Testing only (npm run dev): ?listentest=<transcript> shows the answer; ?listentest=dots shows the listening screen. */
async function listenDevTest() {
  if (!import.meta.env.DEV) return;
  const text = new URLSearchParams(location.search).get("listentest");
  if (!text) return;
  current = Math.max(0, st.settings.cards.indexOf("listen"));
  st.listen = { phase: "listening", topic: "", lines: [], page: 0, error: null };
  if (text !== "dots") await explain(text);
}

// ---------- touch test (dev only): ?touchtest shows which surface sent each event ----------

const touchTest = import.meta.env.DEV && new URLSearchParams(location.search).has("touchtest");
const touchLog: string[] = [];
let touchCount = 0;

const SOURCE_NAME: Record<number, string> = {
  [EventSourceType.TOUCH_EVENT_FROM_RING]: "RING",
  [EventSourceType.TOUCH_EVENT_FROM_GLASSES_R]: "RIGHT ARM",
  [EventSourceType.TOUCH_EVENT_FROM_GLASSES_L]: "LEFT ARM",
};

/** Find an eventSource anywhere in the raw host JSON (the parsed text/list events don't carry one). */
function rawSource(o: unknown, depth = 0): unknown {
  if (!o || typeof o !== "object" || depth > 4) return undefined;
  for (const [k, v] of Object.entries(o)) {
    if (k.replace(/_/g, "").toLowerCase() === "eventsource") return v;
    const found = rawSource(v, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function touchFrame(): Frame {
  const body = touchLog.length ? touchLog.join("\n") : "Tap the ring, left arm, right arm.\nTry double tap and long press too.";
  return {
    title: "TOUCH TEST",
    status: `${touchCount} events`,
    body: { tiles: [{ x: 0, y: 0, w: 576, h: 202, text: body, border: true }] },
    dots: "",
    hint: "newest on top",
  };
}

async function onTouchTestEvent(ev: EvenHubEvent) {
  const src = ev.textEvent ?? ev.listEvent ?? ev.sysEvent;
  console.log("[touchtest] raw event", JSON.stringify({ textEvent: ev.textEvent, listEvent: ev.listEvent, sysEvent: ev.sysEvent, jsonData: ev.jsonData }));
  if (!src || ev.sysEvent?.imuData) return;
  const t = src.eventType ?? OsEventTypeList.CLICK_EVENT;
  const gesture = OsEventTypeList[t] ?? `TYPE ${t}`;
  const kind = ev.textEvent ? "text" : ev.listEvent ? "list" : "sys";
  const parsed = ev.sysEvent?.eventSource;
  const raw = parsed ?? rawSource(ev.jsonData);
  const n = typeof raw === "string" ? (EventSourceType.fromJson(raw) ?? Number(raw)) : (raw as number | undefined);
  const where = n ? (SOURCE_NAME[n] ?? `SOURCE ${n}`) : "UNKNOWN";
  touchCount++;
  touchLog.unshift(`${touchCount}. ${gesture.replace(/_EVENT$/, "")} - ${where} (${kind})`);
  touchLog.length = Math.min(touchLog.length, 5);
  fetch("/__touchlog", { method: "POST", body: JSON.stringify({ line: touchLog[0], parsedSource: parsed ?? null, rawSource: raw ?? null, sysEvent: ev.sysEvent, textEvent: ev.textEvent, listEvent: ev.listEvent, jsonData: ev.jsonData }) }).catch(() => {});
  await render();
}

// ---------- input ----------

const simLeftTap = import.meta.env.DEV && new URLSearchParams(location.search).has("lefttap");

function toGesture(ev: EvenHubEvent): Gesture | null {
  const src = ev.textEvent ?? ev.listEvent ?? ev.sysEvent;
  if (!src) return null;
  if (ev.sysEvent?.imuData) return null;
  // CLICK_EVENT is 0, which protobuf hosts often omit, so a missing type means tap.
  const t = src.eventType ?? OsEventTypeList.CLICK_EVENT;
  // The left arm of the glasses is Ask Claude's button (the ring and right arm keep their gestures).
  // ?lefttap (dev only): the simulator can't say which surface was touched, so its taps count as the left arm.
  if (ev.sysEvent?.eventSource === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L || simLeftTap) {
    if (t === OsEventTypeList.CLICK_EVENT) return "ltap";
    if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) return "ldouble";
  }
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
    return render();
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
  if (id === "listen") {
    const l = st.listen;
    if (l.phase === "off") return startListen();
    if (l.phase === "listening") return explain();
    if (l.phase === "answer" && l.page + 1 < listenPages(st)) { l.page++; return render(); }
    if (l.phase === "answer" || l.phase === "error") return bridge ? backToDots() : stopListen().then(() => render());
    return; // thinking
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
  return st.gym.recording || st.gym.busy || (st.gym.restEndsAt ?? 0) > Date.now() || st.ask.phase === "listening" || st.ask.phase === "thinking" || st.listen.phase !== "off";
}

async function goToSleep() {
  asleep = true;
  lastFrame = null;
  if (!bridge) return;
  const cat = !!posture.catPose();
  await drawBlank(bridge, cat).catch(() => {});
  posture.resetSent();
  if (cat) await posture.syncImage(bridge);
}

function sleepTick() {
  const secs = st.settings.sleepSeconds;
  const idleSince = Math.max(lastInput, st.gym.restEndsAt ?? 0);
  if (touchTest) return;
  if (!asleep && bridge && secs > 0 && !busy() && Date.now() - idleSince > secs * 1000) goToSleep();
}

async function handle(g: Gesture) {
  lastInput = Date.now();
  if (asleep) {
    asleep = false; // a touch only wakes the display
    return render(true);
  }
  // Left arm: Ask Claude, over whatever card (or email pop-up) is showing.
  if (g === "ltap" || g === "ldouble") return askGesture(g === "ldouble");
  // Press and hold anywhere turns the display off; any touch turns it back on.
  if (g === "long") { await cancelAsk(); return goToSleep(); }
  // While Ask is open: a swipe closes it (back to your card); taps work Ask like the left arm.
  if (st.askOpen && !st.alertView) {
    if (g === "next" || g === "prev") return closeAsk();
    return askGesture(g === "double");
  }
  if (await alertGesture(g)) return;
  const n = st.settings.cards.length;
  const card = st.settings.cards[current];
  // Leaving the Listen card turns the mic off and forgets the audio.
  if ((g === "next" || g === "prev") && card === "listen") await stopListen();
  // Listen: double tap goes back to the dots, or stops listening from the dots.
  if (g === "double" && card === "listen" && st.listen.phase !== "off") {
    if (st.listen.phase === "listening" || st.listen.phase === "error") { await stopListen(); return render(); }
    return backToDots();
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
    return render();
  }
  if (g === "next") { current = (current + 1) % n; return render(); }
  if (g === "prev") { current = (current - 1 + n) % n; return render(); }
  if (g === "double") { current = 0; st.agendaPage = 0; return render(); }
  return onTap();
}

// ---------- phone-side settings ----------

const phone = mountPhoneUI(st.settings, {
  async onChange(s) {
    const serverChanged = s.serverUrl !== st.settings.serverUrl || s.accessToken !== st.settings.accessToken;
    st.settings = s;
    current = Math.min(current, s.cards.length - 1);
    await saveSettings(bridge, s);
    await render(true); // brightness or layout settings may have changed
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
    [st.settings, st.gym.sets] = await Promise.all([loadSettings(bridge), loadGym(bridge)]);
    restore(await loadSnapshot<Snapshot>(bridge));
    phone.sync(st.settings);
    phone.showGym(st.gym.sets);
    bridge.onEvenHubEvent(async (ev) => {
      if (ev.audioEvent) {
        if (st.listen.phase !== "off") keepAudio(toBytes(ev.audioEvent.audioPcm));
        else if (st.gym.recording || st.ask.phase === "listening") pcm.push(toBytes(ev.audioEvent.audioPcm));
        return;
      }
      if (ev.menuItemClickEvent) {
        const id = ev.menuItemClickEvent.itemID;
        if (id === MENU.refresh) {
          const i = st.settings.cards.indexOf("brief");
          if (i >= 0) { current = i; await render(); }
          await refreshBrief();
        }
        if (id === MENU.home) await handle("double");
        if (id === MENU.close) await bridge!.shutDownPageContainer(0);
        return;
      }
      if (ev.sysEvent && posture.onSysEvent(bridge!, ev.sysEvent, st.settings.postureCat)) return;
      if (touchTest) return onTouchTestEvent(ev);
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

  if (!bridge) restore(await loadSnapshot<Snapshot>(null));
  phone.showGym(st.gym.sets);
  await gymDevTest();
  await listenDevTest();
  savedDevTest();
  if (import.meta.env.DEV) posture.devTest(new URLSearchParams(location.search).get("posturetest"));
  if (!st.settings.cards.length) st.settings.cards = ["agenda"];
  await render();
  refreshWeather();
  refreshWhoop();
  if (st.settings.cards.includes("agenda")) refreshAgenda();
  if (st.settings.cards.includes("news")) { refreshNews(); refreshMarkets(); }
  if (st.settings.cards.includes("agenda")) {
    if (new URLSearchParams(location.search).has("alerttest")) alertsSince -= 86_400; // show the last day's alerts once
    pollAlerts();
  }
  if (st.settings.cards.includes("inbox")) refreshInbox();
  // The day plan is remade every 2 hours anyway, so a recent one from last launch is kept.
  const BRIEF_EVERY_MS = 2 * 60 * 60_000;
  if (st.settings.cards.includes("brief") && (!st.brief.at || Date.now() - st.brief.at.getTime() > BRIEF_EVERY_MS)) refreshBrief();

  // Listen: step the three dots while only the dots are on screen (one small text update each time).
  setInterval(() => {
    const showing = st.settings.cards[current] === "listen" && st.listen.phase === "listening" && !st.alertView && !asleep;
    if (!showing) return;
    st.listen.dot = ((st.listen.dot ?? 0) + 1) % 3;
    render();
  }, LISTEN_DOT_MS);

  // Tick: clock every minute, gym rest timer every second while it runs.
  let lastMinute = -1;
  setInterval(() => {
    st.now = new Date();
    sleepTick();
    if (posture.tick(bridge, st.settings.postureCat, catAllowed())) catChanged();
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
  setInterval(refreshNews, 15 * 60_000); // the server only re-picks when the feeds have new stories
  setInterval(refreshBrief, BRIEF_EVERY_MS); // keep the day plan current
  setInterval(refreshMarkets, 5 * 60_000);
  setInterval(pollAlerts, ALERT_EVERY_MS);
}

boot();
