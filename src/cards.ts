// Each card decides what the body shows. Taps are handled in main.ts.
// Add a card: give it an id in settings.ts, then a renderer here.
import { exerciseKey, type LiftType, liftType } from "./exercises";
import type { CardId, LoggedSet, Settings } from "./settings";
import { emailWidget, type Img, micWidget, recoveryWidget, restWidget, sparkWidget, tickStep } from "./widgets";

export interface AgendaEvent {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  series: boolean;
  location?: string;
  video: boolean;
}

export interface InboxItem {
  line: string; // "Paul: content review, 11/26"
  tag: string; // which inbox: ech, hel, asy, gml
  ageHours: number; // how long they've waited (reply) or you've waited (follow up)
}

export interface InboxData {
  at: string;
  reply: InboxItem[];
  followup: InboxItem[];
  skipped: string[];
  advice: string; // "Reply to Paul first, then ..."
}

export interface WhoopToday {
  recovery: number | null;
  hrv: number | null;
  restingHr: number | null;
  recovery7d: number | null;
  sleepPerformance: number | null;
  sleepHours: number | null;
  sleepNeedHours: number | null;
  strain: number | null;
  workouts: string[];
  tip?: string; // one sentence: what to do today to raise recovery
  bedtime?: string; // "10:50 PM", from sleep need + alarm
}

export interface EmailAlert {
  id: string;
  tag: string;
  from: string;
  subject: string;
  line: string;
  summary: string;
  at: number;
}

export interface Markets {
  sp500: number | null;
  btc: number | null;
  btcChange: number | null;
  spark?: { sp500: number[]; btc: number[] }; // S&P since today's open, BTC over 24 hours
}

/** One box of text on the glasses. x/y are relative to the body area (576 x 202). */
export interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  border?: boolean; // rounded outline
  dim?: boolean; // dimmer text (labels, times)
  capture?: boolean; // receives gestures (default: the biggest tile)
}

/** A card body is a few tiles, plus maybe a few small drawn pictures. */
export interface Body { tiles: Tile[]; images?: Img[] }

export interface Reader {
  title: string;
  lines: string[];
  page: number;
  loading: boolean;
  error: string | null;
}

export interface DashState {
  settings: Settings;
  now: Date;
  weather: string | null; // "56°F · clear" (used by the day plan)
  reminders: { items: string[] | null; today: boolean; page: number }; // iPhone reminders due today
  agenda: { events: AgendaEvent[] | null; loading: boolean; error: string | null; notConnected: boolean };
  agendaPage: number; // 0 schedule, 1 WHOOP + inbox
  news: string[] | null; // up to 10 headlines
  markets: Markets | null;
  alerts: EmailAlert[]; // new emails you haven't opened yet
  alertView: { list: EmailAlert[]; index: number; expanded: boolean; page: number; closeAt: number | null } | null;
  newsCursor: number;
  reader: Reader | null; // an open news story
  inbox: { data: InboxData | null; loading: boolean; error: string | null; page: number };
  whoop: WhoopToday | null;
  saved: Partial<Record<CardId, number>>; // cards still showing last launch's data: when it was fetched (ms)
  askOpen: boolean; // Ask Claude is open over the current card (a left-arm tap opens it)
  ask: {
    phase: "ready" | "listening" | "thinking" | "answer" | "error";
    followUp: boolean;
    question: string;
    lines: string[]; // the answer, wrapped
    page: number;
    history: { q: string; a: string }[];
    error: string | null;
    streaming?: boolean; // the answer is still arriving
  };
  listen: {
    // off: not listening. listening: only the dots. thinking/answer/error: the mic keeps going underneath.
    phase: "off" | "listening" | "thinking" | "answer" | "error";
    topic: string;
    lines: string[]; // the key points, wrapped
    page: number;
    error: string | null;
    dot?: number; // which of the three listening dots is lit (animation step)
    checking?: boolean; // answer shown, still searching the web for a fresh fact
  };
  gym: {
    sets: LoggedSet[];
    recording: boolean;
    busy: boolean;
    message: string | null;
    restEndsAt: number | null;
    restLabel: string; // "heavy lift 2:30 + yellow day 0:30"
    notice: string | null; // "REMOVED   Bench Press 185x8 (set 2)" shown in the status tile
    recovery: number | null; // WHOOP recovery %, once WHOOP is connected
    sessionStart: number; // sets before this belong to an earlier (finished) workout
    summary: { end: number; page: number } | null; // the workout-complete screen
    lastLogged: { set: LoggedSet; last: LoggedSet[]; tip: string } | null; // the set you just logged, and last session's sets for it
    restTotal: number; // seconds of the current rest
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function clock(d: Date, use24h: boolean): string {
  if (use24h) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const h = d.getHours() % 12 || 12;
  return `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

function mmss(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

interface CardDef {
  title(st: DashState): string;
  body(st: DashState): Body;
  tapHint(st: DashState): string;
}

// ---------- text fitting ----------

const CHAR_W = 8.8; // average width of a character in the glasses font (px)
const LINE_H = 27; // line height (px)
const padOf = (border: boolean) => (border ? 6 : 4);
const colsFor = (w: number, border = true) => Math.floor((w - 2 * padOf(border) - 4) / CHAR_W);
const rowsFor = (h: number, border = true) => Math.floor((h - 2 * padOf(border)) / LINE_H);

const trim = (t: string, max: number) => (t.length > max ? t.slice(0, max - 3).trimEnd() + "..." : t);

/** Wrap to a width, keeping the text's own line breaks. */
export function wrap(text: string, width: number, indent = ""): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if (line && (line + " " + word).length > width) { out.push(line); line = indent + word; }
      else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

/** Lines that fit a box: extra lines are dropped and the last visible one gets "...". */
function fitLines(lines: string[], rows: number): string[] {
  if (lines.length <= rows) return lines;
  const out = lines.slice(0, rows);
  out[rows - 1] = out[rows - 1].replace(/[\s.,;:]*$/, "") + "...";
  return out;
}

interface TileOpts { border?: boolean; dim?: boolean; capture?: boolean }

/** A tile whose text is already split into lines; it's trimmed to fit. */
function box(x: number, y: number, w: number, h: number, lines: string[], o: TileOpts = {}): Tile {
  const border = o.border ?? true;
  const cols = colsFor(w, border);
  const fitted = fitLines(lines.flatMap((l) => (l.length > cols ? wrap(l, cols, l.startsWith("- ") ? "  " : "") : [l])), rowsFor(h, border));
  return { x, y, w, h, text: fitted.join("\n"), border, dim: o.dim, capture: o.capture };
}

// Standard spots inside the body area (576 x 202).
const FULL = { x: 8, y: 2, w: 560, h: 196 }; // one big tile: 6 rows
const ROWS = rowsFor(FULL.h); // 6
const COLS = colsFor(FULL.w); // ~60
const full = (lines: string[], o?: TileOpts) => box(FULL.x, FULL.y, FULL.w, FULL.h, lines, o);
const message = (text: string): Body => ({ tiles: [full(wrap(text, COLS))] });

const isHeader = (l: string) => /^[A-Z0-9' ]{4,}$/.test(l.trim());

/**
 * Split into pages of `rows` lines. Each group (e.g. one wrapped bullet) stays on
 * one page, and a section header never sits alone at the bottom of a page.
 */
function pagesOf(groups: string[][], rows = ROWS): string[][] {
  const out: string[][] = [[]];
  for (const g of groups) {
    let page = out[out.length - 1];
    const fits = page.length + g.length <= rows;
    const lonelyHeader = isHeader(g[0] ?? "") && page.length > 0 && page.length >= rows - 2;
    if ((!fits && g.length <= rows) || lonelyHeader) { page = []; out.push(page); }
    for (const line of g) {
      if (page.length >= rows) { page = []; out.push(page); }
      if (!page.length && !line.trim()) continue; // no blank line at the top of a page
      page.push(line);
    }
  }
  return out.filter((p, i) => p.length || i === 0);
}
const pages = (lines: string[], rows = ROWS) => pagesOf(lines.map((l) => [l]), rows);

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const short = (d: Date, use24h: boolean) => clock(d, use24h).replace(" AM", "a").replace(" PM", "p");

// ---------- today, page 1: schedule ----------
// [ NOW · until 7:00 PM / Brandon <> Mudassir Weekly ]   (2-row tile)
//   later times (dim)   later titles

function scheduleBody(st: DashState): Body {
  const a = st.agenda;
  if (a.notConnected) return message("Connect your calendar: open the setup page on your Mac (link in phone settings).");
  if (a.error && !a.events) return message(`${a.error}\n\nTap to retry.`);
  if (!a.events) return message("Loading your day...");

  const now = st.now.getTime();
  const allDay = a.events.filter((e) => e.allDay);
  const timed = a.events.filter((e) => !e.allDay);
  const upcoming = timed.filter((e) => new Date(e.end).getTime() > now);
  const done = timed.length - upcoming.length;
  const u24 = st.settings.use24h;

  let head: string[];
  const first = upcoming[0];
  if (first) {
    const start = new Date(first.start);
    const live = start.getTime() <= now;
    const mins = Math.round((start.getTime() - now) / 60_000);
    const when = live
      ? `NOW  ·  until ${clock(new Date(first.end), u24)}`
      : `NEXT  ·  ${clock(start, u24)}${mins < 120 ? `  ·  in ${mins} min` : ""}`;
    head = [when, `${first.title}${first.series ? "  *" : ""}`];
  } else {
    head = ["NOTHING LEFT TODAY", timed.length ? `${done} meeting${done === 1 ? "" : "s"} done` : "Your calendar is clear"];
  }

  const left: string[] = [];
  const right: string[] = [];
  if (allDay.length) { left.push("all day"); right.push(allDay.map((e) => e.title).join(", ")); }
  const later = upcoming.slice(1);
  const room = 4 - left.length;
  const shown = later.slice(0, later.length > room ? room - 1 : room);
  for (const e of shown) { left.push(short(new Date(e.start), u24)); right.push(`${e.title}${e.series ? "  *" : ""}`); }
  if (later.length > shown.length) { left.push(""); right.push(`+${later.length - shown.length} more`); }
  else if (done && upcoming.length && left.length < 4) { left.push(""); right.push(`${done} done, ${upcoming.length} to go`); }

  const tiles: Tile[] = [box(8, 2, 560, 68, head)];
  if (right.length) {
    const cols = colsFor(472, false);
    tiles.push(box(8, 78, 84, 122, left, { border: false, dim: true }));
    tiles.push(box(96, 78, 472, 122, right.map((r) => trim(r, cols)), { border: false }));
  }
  return { tiles };
}

// ---------- today, page 2: recovery tile + inbox tile ----------

function zone(r: number): string {
  return r >= 67 ? "GREEN" : r >= 34 ? "YELLOW" : "RED";
}

// The recovery ring is a drawn picture in rows 2-4 of the tile; the text leaves those rows empty.
const REC_IMG = { x: 16, y: 76 };

function lifeBody(st: DashState): Body {
  const w = st.whoop;
  let rec: string[];
  const images: Img[] = [];
  if (w?.recovery != null) {
    rec = ["RECOVERY", "", "", ""];
    images.push(recoveryWidget(REC_IMG.x, REC_IMG.y, w.recovery, zone(w.recovery)));
    if (w.bedtime) rec.push(`Bed by ${w.bedtime}`);
    if (w.tip) rec.push(trim(w.tip, colsFor(244)));
  } else rec = ["RECOVERY", w ? "Not scored yet" : "WHOOP not connected"];

  const ib = st.inbox.data;
  let inbox: string[];
  if (ib) {
    // "Name: what they want", one per line, most important first.
    const cols = colsFor(308);
    const lines = (items: InboxItem[], n: number) => items.slice(0, n).map((i) => trim(i.line, cols));
    // 6 rows: up to 3 replies + 1 follow-up; spare rows go to whichever list has more.
    const replyN = Math.min(ib.reply.length, ib.followup.length ? 3 : 5);
    const followN = Math.min(ib.followup.length, 6 - (replyN ? replyN + 1 : 0) - 1);
    inbox = [];
    if (ib.reply.length) inbox.push("REPLY TO", ...lines(ib.reply, replyN));
    if (followN) inbox.push("FOLLOW UP WITH", ...lines(ib.followup, followN));
    if (!inbox.length) inbox = ["INBOX", "", "Nothing needs you."];
  } else inbox = ["INBOX", "", st.inbox.error ?? "Reading your inboxes..."];

  return { tiles: [box(8, 2, 244, 196, rec), box(260, 2, 308, 196, inbox)], images };
}

export const TODAY_PAGES = 2;

// ---------- news: two market tiles, then the stories ----------

const pct1 = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const kUsd = (n: number) => (n >= 10_000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n).toLocaleString("en-US")}`);
// A small price line at the right end of each market tile (screen coordinates).
const SPARK = { sp500: { x: 186, y: 52 }, btc: { x: 470, y: 52 } };

function marketTiles(m: Markets | null): { tiles: Tile[]; images: Img[] } {
  const sp = m?.sp500 == null ? "S&P 500   --" : `S&P 500   ${pct(m.sp500)}`;
  const btc = m?.btc == null ? "BTC   --" : `BTC  ${kUsd(m.btc)}  ${m.btcChange == null ? "" : pct1(m.btcChange)}`;
  const images: Img[] = [];
  if (m?.spark?.sp500 && m.spark.sp500.length >= 2) images.push(sparkWidget(SPARK.sp500.x, SPARK.sp500.y, m.spark.sp500));
  if (m?.spark?.btc && m.spark.btc.length >= 2) images.push(sparkWidget(SPARK.btc.x, SPARK.btc.y, m.spark.btc));
  return { tiles: [box(8, 2, 276, 42, [m ? sp : "Markets loading..."]), box(292, 2, 276, 42, [m ? btc : ""])], images };
}

const LIST = { x: 0, y: 52, w: 576, h: 148 }; // free list under one-row tiles: 5 rows

function readerLines(st: DashState): string[][] {
  return st.reader ? pages(st.reader.lines) : [[]];
}

export function readerPages(st: DashState): number {
  return st.reader && !st.reader.loading ? readerLines(st).length : 1;
}

/** The summary of a news story, wrapped for a full-width tile. */
export function storyLines(summary: string): string[] {
  return summary.split("\n").flatMap((p) => wrap(p, COLS, p.startsWith("- ") ? "  " : ""));
}

function newsBody(st: DashState): Body {
  const r = st.reader;
  if (r) {
    if (r.loading) return { tiles: [full([r.title, "", "Summarizing..."])] };
    if (r.error) return { tiles: [full([r.error, "", "Double tap to go back."])] };
    const p = readerLines(st);
    return { tiles: [full(p[Math.min(r.page, p.length - 1)])] };
  }
  const { tiles, images } = marketTiles(st.markets);
  const n = st.news;
  const rows = rowsFor(LIST.h, false);
  let lines: string[];
  if (!n) lines = ["Loading Morning Brew..."];
  else if (!n.length) lines = ["No new stories."];
  else {
    const c = st.newsCursor;
    const start = Math.max(0, Math.min(c - 2, n.length - rows));
    lines = n.slice(start, start + rows).map((h, i) => `${start + i === c ? ">" : "  "}  ${h}`);
  }
  tiles.push(box(LIST.x, LIST.y, LIST.w, LIST.h, lines, { border: false, capture: true }));
  return { tiles, images };
}

// ---------- email alert pop-up ----------

export function alertLines(a: EmailAlert): string[] {
  return [`${a.from}  ·  ${a.tag}`, ...wrap(`Re: ${a.subject}`, COLS, "  "), "", ...a.summary.split("\n").flatMap((p) => wrap(p, COLS))];
}

export function alertPages(st: DashState): number {
  const v = st.alertView;
  return v?.expanded ? pages(alertLines(v.list[v.index])).length : 1;
}

/** Where the new-email box sits: centred over the card. */
export const ALERT_BOX = { x: 144, y: 70 };

/**
 * A new email. Not opened yet: a drawn box over the card you're on (no `body`, the card stays
 * behind it). Opened (tap): the full-screen reader.
 */
export function alertFrame(st: DashState): { title?: string; body?: Body; image?: Img; hint: string } | null {
  const v = st.alertView;
  if (!v) return null;
  const a = v.list[v.index];
  const count = v.list.length > 1 ? `  ${v.index + 1}/${v.list.length}` : "";
  if (!v.expanded) {
    return { image: emailWidget(ALERT_BOX.x, ALERT_BOX.y, a, count), hint: "tap  read   2x  close" };
  }
  const p = pages(alertLines(a));
  const page = Math.min(v.page, p.length - 1);
  const last = page >= p.length - 1;
  const next = last ? (v.index < v.list.length - 1 ? "tap  next email" : "tap  close") : "tap  more";
  return {
    title: `EMAIL${count}  ·  ${a.tag}`,
    body: { tiles: [full(p[page])] },
    hint: `${p.length > 1 ? `${page + 1}/${p.length}   ` : ""}${next}`,
  };
}

// ---------- inbox: two count tiles, then the list ----------

/** "2h", "5h", "1d", "3d": how long someone has waited. */
export function waited(hours: number): string {
  const h = Math.max(0, Math.round(hours));
  return h < 1 ? "now" : h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

// The list, with how long each person has waited in a dim column on the right.
const INBOX_LIST = { x: 0, y: 52, w: 492, h: 148 };
const INBOX_AGE = { x: 500, y: 52, w: 76, h: 148 };

function inboxRowsOf(d: InboxData): { line: string; age: string }[] {
  const cols = colsFor(INBOX_LIST.w, false);
  const out: { line: string; age: string }[] = [];
  const add = (label: string, items: InboxItem[]) => {
    if (!items.length) return;
    out.push({ line: label, age: "" });
    for (const i of items) out.push({ line: trim(`  ${i.line}`, cols), age: waited(i.ageHours) });
  };
  add("REPLY", d.reply);
  add("FOLLOW UP", d.followup);
  return out;
}

const inboxRows = () => rowsFor(LIST.h, false);

/** Pages of rows; a section label never sits alone at the bottom of a page. */
function inboxPaged(d: InboxData): { line: string; age: string }[][] {
  const rows = inboxRowsOf(d);
  const n = inboxRows();
  const out: { line: string; age: string }[][] = [[]];
  for (const r of rows) {
    let page = out[out.length - 1];
    const lonely = !r.age && page.length >= n - 1;
    if (page.length >= n || (lonely && page.length)) { page = []; out.push(page); }
    page.push(r);
  }
  return out;
}

export function inboxPages(st: DashState): number {
  return st.inbox.data ? inboxPaged(st.inbox.data).length : 1;
}

function inboxBody(st: DashState): Body {
  const ib = st.inbox;
  if (!ib.data) return message(ib.error ? `${ib.error}\n\nTap to retry.` : "Reading your 4 inboxes...");
  const d = ib.data;
  if (!d.reply.length && !d.followup.length) return message("Inbox zero. Nothing needs you.");
  const p = inboxPaged(d);
  const page = p[Math.min(ib.page, p.length - 1)];
  return {
    tiles: [
      box(8, 2, 276, 42, [`${d.reply.length}   TO REPLY`]),
      box(292, 2, 276, 42, [`${d.followup.length}   TO FOLLOW UP`]),
      box(INBOX_LIST.x, INBOX_LIST.y, INBOX_LIST.w, INBOX_LIST.h, page.map((r) => r.line), { border: false, capture: true }),
      box(INBOX_AGE.x, INBOX_AGE.y, INBOX_AGE.w, INBOX_AGE.h, page.map((r) => r.age), { border: false, dim: true }),
    ],
  };
}

// ---------- reminders: today's iPhone reminders, one big tile per page ----------

/** The Reminders card only shows when the iPhone sent a list today with something on it. */
export const hasReminders = (st: DashState) => st.reminders.today && !!st.reminders.items?.length;

export function reminderPages(st: DashState): string[][] {
  const items = st.reminders.items ?? [];
  if (!items.length) return [[]];
  return pagesOf(items.map((t) => wrap(`◆ ${t}`, COLS, "   ")));
}

/** The cards you can swipe to right now (Reminders hides itself on days with none). */
export function visibleCards(st: DashState): CardId[] {
  const list = st.settings.cards.filter((c) => c !== "reminders" || hasReminders(st));
  return list.length ? list : ["agenda"];
}

// ---------- gym: status tile, then today's sets ----------

const TYPE_LABEL: Record<LiftType, string> = { heavy: "heavy lift", compound: "compound", isolation: "isolation" };
const TYPE_SHORT: Record<string, string> = { heavy: "heavy", compound: "compound", isolation: "isolation" };
const m_ss = (secs: number) => `${Math.floor(secs / 60)}:${pad(secs % 60)}`;

/** Rest after a set: by lift type, plus more when WHOOP says you're under-recovered. */
export function restFor(st: DashState, exercise: string): { seconds: number; label: string } {
  const type = liftType(exercise);
  const base = st.settings.rest[type];
  const r = st.gym.recovery;
  const extra = r == null || r >= 67 ? 0 : r >= 34 ? 30 : 60;
  const day = r == null || r >= 67 ? "" : r >= 34 ? "yellow day" : "red day";
  const label = extra ? `${TYPE_LABEL[type]} ${m_ss(base)} + ${day} ${m_ss(extra)}` : TYPE_LABEL[type];
  return { seconds: base + extra, label };
}

export const fmtSet = (s: { weight: number; unit: string; reps: number }) =>
  s.weight ? `${s.weight}x${s.reps}` : `${s.reps} reps`;

// Resting: a drawn countdown ring on the left, the set you just logged top right, the list under it.
const REST_IMG = { x: 12, y: 46 };

function restBody(st: DashState, now: number): Body {
  const g = st.gym;
  const total = g.restTotal || 90;
  const left = Math.min(total, Math.max(0, Math.ceil((g.restEndsAt! - now) / 1000)));
  // On slow Bluetooth the ring moves every few seconds and the exact time shows as text too.
  const step = tickStep();
  const ringLeft = Math.min(total, Math.ceil(left / step) * step);
  const ll = g.lastLogged;
  let logged: string[];
  if (ll) {
    const unit = ll.set.weight ? ` ${ll.set.unit}` : "";
    const lastBest = ll.last.length ? ll.last.reduce((a, b) => (score(b) > score(a) ? b : a)) : null;
    const next = ll.tip.replace(/^next:\s*/, "next ");
    logged = [trim(`${ll.set.exercise}  ${fmtSet(ll.set)}${unit}`, colsFor(400)), trim(lastBest ? `last time ${fmtSet(lastBest)}  ·  ${next}` : next, colsFor(400))];
  } else logged = [trim(g.message ?? "Resting", colsFor(400)), ""];
  if (g.notice) logged = [trim(g.notice, colsFor(400)), trim(g.message ?? "", colsFor(400))];
  return {
    tiles: [
      box(160, 2, 408, 68, logged),
      box(156, 78, 420, 122, setLines(st), { border: false, capture: true }),
      box(8, 158, 148, 40, [step > 1 ? `${m_ss(left)}  ${TYPE_SHORT[g.restLabel.split(" ")[0]] ?? ""}` : trim(g.restLabel.split(" + ")[0], 15)], { border: false, dim: true }),
    ],
    images: [restWidget(REST_IMG.x, REST_IMG.y, ringLeft, total)],
  };
}

/** This workout's sets grouped by exercise, most recent exercise first. */
function setLines(st: DashState): string[] {
  const today = sessionSets(st);
  const groups = new Map<string, LoggedSet[]>();
  for (const s of [...today].reverse()) {
    const k = exerciseKey(s.exercise);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const lines = [...groups.values()].map((sets) => {
    const unit = sets[0].weight ? ` (${sets[0].unit})` : "";
    return `${sets[0].exercise}${unit}   ${[...sets].reverse().map(fmtSet).join("  ")}`;
  });
  return lines.length ? lines : ["No sets yet today."];
}

function gymBody(st: DashState): Body {
  const g = st.gym;
  if (g.summary) return summaryBody(st);
  const now = st.now.getTime();
  if (!g.recording && !g.busy && g.restEndsAt && g.restEndsAt > now) return restBody(st, now);
  let status: string;
  let sub = "";
  if (g.recording) { status = "● LISTENING"; sub = "Log a set, or say \"cancel that\""; }
  else if (g.busy) status = "Logging...";
  else if (g.restEndsAt && g.restEndsAt > now) { status = `REST   ${mmss(g.restEndsAt - now)}   ·  ${g.restLabel}`; sub = g.message ?? ""; }
  else if (g.notice) { status = g.notice; sub = g.message ?? ""; }
  else if (g.restEndsAt && now - g.restEndsAt < 5 * 60_000) { status = "GO  ·  next set"; sub = g.message ?? ""; }
  else { status = "READY"; sub = g.message ?? 'Tap, then say "bench, 185, 8 reps"'; }

  return {
    tiles: [
      box(8, 2, 560, 68, [status, sub]),
      box(0, 78, 576, 122, setLines(st), { border: false, capture: true }),
    ],
  };
}

/** This workout's sets: today, after the last "workout complete". */
export function sessionSets(st: DashState, end = Infinity): LoggedSet[] {
  const start = Math.max(new Date(st.now).setHours(0, 0, 0, 0), st.gym.sessionStart);
  return st.gym.sets.filter((s) => s.t >= start && s.t <= end);
}

// ---------- workout complete ----------

const LB_PER_KG = 2.2046;
const lb = (s: LoggedSet) => (s.unit === "kg" ? s.weight * LB_PER_KG : s.weight);
/** Strength of a set (estimated 1-rep max); bodyweight sets count reps. */
const score = (s: LoggedSet) => (s.weight ? lb(s) * (1 + s.reps / 30) : s.reps);
const volume = (sets: LoggedSet[]) => sets.reduce((n, s) => n + lb(s) * s.reps, 0);
const best = (sets: LoggedSet[]) => sets.reduce((a, b) => (score(b) > score(a) ? b : a));
const dayOf = (t: number) => new Date(t).toDateString();

export interface WorkoutSummary {
  volume: number; // lb
  change: number | null; // % vs the last workout
  prs: number;
  sets: number;
  up: { line: string; gain: number }[]; // beat last time: "◆ Bench Press 205x5  (was 185x8)"
  rest: { name: string; line: string; kind: "same" | "lower" | "new" }[];
}

export function workoutSummary(st: DashState): WorkoutSummary | null {
  const end = st.gym.summary?.end ?? Date.now();
  const session = sessionSets(st, end);
  if (!session.length) return null;
  const startT = session[0].t;
  const before = st.gym.sets.filter((s) => s.t < startT);
  // The last workout: the most recent earlier day you trained.
  const lastDay = before.length ? dayOf(before[before.length - 1].t) : null;
  const lastWorkout = lastDay ? before.filter((s) => dayOf(s.t) === lastDay) : [];
  const vol = volume(session);
  const lastVol = volume(lastWorkout);

  const byKey = new Map<string, LoggedSet[]>();
  for (const s of session) byKey.set(exerciseKey(s.exercise), [...(byKey.get(exerciseKey(s.exercise)) ?? []), s]);
  let prs = 0;
  const up: WorkoutSummary["up"] = [];
  const rest: WorkoutSummary["rest"] = [];
  for (const [key, sets] of byKey) {
    const top = best(sets);
    const prior = before.filter((s) => exerciseKey(s.exercise) === key);
    const name = `${top.exercise} ${fmtSet(top)}`;
    if (!prior.length) { rest.push({ name: top.exercise, line: `   ${name}  (no history yet)`, kind: "new" }); continue; }
    if (score(top) > Math.max(...prior.map(score))) prs++;
    const pDay = dayOf(prior[prior.length - 1].t);
    const last = best(prior.filter((s) => dayOf(s.t) === pDay));
    const diff = score(top) - score(last);
    if (diff > 0.01) up.push({ line: `◆ ${name}  (last time ${fmtSet(last)})`, gain: diff / score(last) });
    else if (Math.abs(diff) < 0.01) rest.push({ name: top.exercise, line: `   ${name}  (same as last time)`, kind: "same" });
    else rest.push({ name: top.exercise, line: `   ${name}  (below last time: ${fmtSet(last)})`, kind: "lower" });
  }
  up.sort((a, b) => b.gain - a.gain);
  return {
    volume: Math.round(vol),
    change: lastVol > 0 ? Math.round(((vol - lastVol) / lastVol) * 100) : null,
    prs,
    sets: session.length,
    up,
    rest,
  };
}

const SUMMARY_ROWS = 4;

/** Everything on one page: lifts that went up get a line each; the rest share one line. */
function summaryLines(w: WorkoutSummary): string[] {
  const all = [...w.up.map((u) => u.line), ...w.rest.map((r) => r.line)];
  if (all.length <= SUMMARY_ROWS) return all;
  const ups = w.up.slice(0, SUMMARY_ROWS - 1).map((u) => u.line);
  const extraUp = w.up.length - ups.length;
  const group = (kind: string, label: string) => {
    const names = w.rest.filter((r) => r.kind === kind).map((r) => r.name);
    return names.length ? `${label}: ${names.join(", ")}` : "";
  };
  const parts = [extraUp ? `+${extraUp} more beat last time` : "", group("same", "Matched last time"), group("lower", "Below last time"),
    group("new", "No history yet")].filter(Boolean);
  const room = SUMMARY_ROWS - ups.length;
  // One group per line when there's room; otherwise share lines.
  let tail = parts.map((p) => trim(p, COLS));
  if (tail.length > room) {
    // Pack groups onto shared lines, never starting a line with the separator.
    const packed: string[] = [];
    for (const p of tail) {
      const cur = packed[packed.length - 1];
      if (cur && (cur + "  ·  " + p).length <= COLS) packed[packed.length - 1] = cur + "  ·  " + p;
      else packed.push(p);
    }
    tail = packed.slice(0, room);
  }
  return [...ups, ...tail];
}

export function summaryPages(_st: DashState): number {
  return 1;
}

function summaryBody(st: DashState): Body {
  const w = workoutSummary(st);
  if (!w) return message("No sets logged in this workout.\n\nTap to close.");
  const strain = st.whoop?.strain;
  const change = w.change == null ? "" : `${w.change >= 0 ? "+" : ""}${w.change}% vs last`;
  return {
    tiles: [
      box(8, 2, 180, 68, [`VOLUME  ${w.volume.toLocaleString("en-US")} lb`, change]),
      box(198, 2, 180, 68, [`PRs  ${w.prs} new`, `${w.sets} sets`]),
      box(388, 2, 180, 68, [`STRAIN  ${strain != null ? strain.toFixed(1) : "--"}`, "WHOOP so far"]),
      box(8, 76, 560, 124, summaryLines(w), { capture: true }),
    ],
  };
}

// ---------- ask claude ----------

const ANSWER = { x: 0, y: 52, w: 576, h: 148 }; // free text under a one-row question tile: 5 rows
const answerRows = () => rowsFor(ANSWER.h, false);

export function askPages(st: DashState): number {
  return pages(st.ask.lines, answerRows()).length;
}

function askBody(st: DashState): Body {
  const a = st.ask;
  const q = (text: string) => box(8, 2, 560, 42, [`"${trim(text, COLS - 2)}"`]);
  switch (a.phase) {
    case "listening":
      return {
        tiles: [
          box(8, 2, 560, 42, ["●  LISTENING..."]),
          box(ANSWER.x, ANSWER.y, ANSWER.w, ANSWER.h, [a.followUp ? "Ask your follow-up, then tap the left arm." : "Speak your question, then tap the left arm."], { border: false, capture: true }),
        ],
      };
    case "thinking":
      return {
        tiles: [q(a.question || "..."), box(ANSWER.x, ANSWER.y, ANSWER.w, ANSWER.h, ["Looking into it..."], { border: false, capture: true })],
      };
    case "answer": {
      const p = pages(a.lines, answerRows());
      return { tiles: [q(a.question), box(ANSWER.x, ANSWER.y, ANSWER.w, ANSWER.h, p[Math.min(a.page, p.length - 1)], { border: false, capture: true })] };
    }
    case "error":
      return message(`${a.error ?? "Something went wrong."}\n\nTap the left arm to try again${a.history.length ? ", double tap it for a new chat" : ""}.`);
    default:
      return {
        tiles: [full(["NEW CHAT", "Tap the left arm and ask anything, like:", "", '"What did Paul say about the 11/26 post?"',
          '"When is my next meeting with Brandon?"', '"Summarize what Apple Support wants."'])],
      };
  }
}

// ---------- listen ----------

export const LISTEN_SECONDS = 120; // how far back a tap looks

/** Key points as "◆ ..." lines, wrapped under the topic tile. */
export function listenLines(points: string[], mark = "◆ "): string[] {
  const cols = colsFor(ANSWER.w, false);
  return points.flatMap((p) => wrap(`${mark}${p}`, cols, "   "));
}

export function listenPages(st: DashState): number {
  return pagesOf(listenGroups(st), answerRows()).length;
}

/** Keep each wrapped point together on one page. */
function listenGroups(st: DashState): string[][] {
  const out: string[][] = [];
  for (const l of st.listen.lines) {
    if (l.startsWith("◆") || l.startsWith(">") || !out.length) out.push([l]);
    else out[out.length - 1].push(l);
  }
  return out;
}

function listenBody(st: DashState): Body {
  const l = st.listen;
  switch (l.phase) {
    case "listening":
      // A still mic with rings (drawn once, no animation) and "Listening" under it.
      return {
        tiles: [box(244, 150, 100, 40, ["Listening"], { border: false, dim: true, capture: true })],
        images: [micWidget(216, 44)],
      };
    case "thinking":
      return { tiles: [box(ANSWER.x, 2, ANSWER.w, 196, ["Looking into it..."], { border: false, capture: true })] };
    case "answer": {
      const p = pagesOf(listenGroups(st), answerRows());
      return {
        tiles: [
          box(8, 2, 560, 42, [trim(l.topic.toUpperCase(), COLS - 2)]),
          box(ANSWER.x, ANSWER.y, ANSWER.w, ANSWER.h, p[Math.min(l.page, p.length - 1)], { border: false, capture: true }),
        ],
      };
    }
    case "error":
      return message(`${l.error ?? "Something went wrong."}\n\nStill listening. Tap to go back to the dots.`);
    default:
      return {
        tiles: [full(["Tap to start listening.", "Then tap any time to learn more about", "what you're talking about.", "",
          "Uses the last 2 minutes. Nothing is saved."])],
      };
  }
}

// ---------- the cards ----------

const shortDate = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

export const CARDS: Record<CardId, CardDef> = {
  agenda: {
    title: (st) => `TODAY  ·  ${shortDate(st.now)}${st.alerts.length ? `   ● ${st.alerts.length} new` : ""}`,
    tapHint: (st) => `${st.agendaPage + 1}/${TODAY_PAGES}   tap  more${st.alerts.length ? "   2x  read new" : ""}`,
    body: (st) => [scheduleBody, lifeBody][st.agendaPage % TODAY_PAGES](st),
  },
  news: {
    title: (st) => (st.reader ? `NEWS  ·  ${trim(st.reader.title, 30)}` : "NEWS"),
    tapHint: (st) => {
      if (st.reader) return `${readerPages(st) > 1 ? `${st.reader.page + 1}/${readerPages(st)}   ` : ""}tap  more   2x  back`;
      return `${st.news?.length ? `${st.newsCursor + 1}/${st.news.length}   ` : ""}tap  next   2x  read`;
    },
    body: newsBody,
  },
  inbox: {
    title: (st) => {
    const d = st.inbox.data;
    return d ? `INBOX  ·  ${4 - d.skipped.length} accounts` : "INBOX";
  },
    tapHint: (st) => {
      const n = inboxPages(st);
      return `${n > 1 ? `${Math.min(st.inbox.page, n - 1) + 1}/${n}   ` : ""}tap  more`;
    },
    body: inboxBody,
  },
  gym: {
    title: (st) => {
      if (st.gym.summary) return `WORKOUT COMPLETE  ·  ${shortDate(st.now)}`;
      const n = sessionSets(st).length;
      return `GYM${n ? `  ·  ${n} set${n === 1 ? "" : "s"} today` : ""}`;
    },
    tapHint: (st) => {
      if (st.gym.summary) {
        const n = summaryPages(st);
        const p = Math.min(st.gym.summary.page, n - 1);
        return `${n > 1 ? `${p + 1}/${n}   ` : ""}tap  ${p + 1 < n ? "more" : "close"}`;
      }
      return st.gym.recording ? "tap  done" : "tap  log or edit";
    },
    body: gymBody,
  },
  listen: {
    title: () => "LISTEN",
    tapHint: (st) => {
      const l = st.listen;
      if (l.phase === "off") return "tap  start";
      if (l.phase === "thinking") return "";
      if (l.phase === "answer") {
        const n = listenPages(st);
        const more = l.page + 1 < n;
        const page = n > 1 ? `${l.page + 1}/${n}   ` : "";
        if (l.checking) return `${page}checking latest...`;
        return `${page}${more ? "tap  more   2x  back" : "tap  back"}`;
      }
      if (l.phase === "error") return "tap  back   2x  stop";
      return "";
    },
    body: listenBody,
  },
  reminders: {
    title: (st) => {
      const n = st.reminders.items?.length ?? 0;
      return `REMINDERS  ·  ${n} today`;
    },
    tapHint: (st) => {
      const n = reminderPages(st).length;
      return n > 1 ? `${Math.min(st.reminders.page, n - 1) + 1}/${n}   tap  more` : "";
    },
    body: (st) => {
      const p = reminderPages(st);
      return { tiles: [full(p[Math.min(st.reminders.page, p.length - 1)])] };
    },
  },
};

/** Ask Claude: not a card any more, an overlay a left-arm tap opens over whatever card you're on. */
export const ASK: CardDef = {
  title: (st) => {
    const n = st.ask.history.length;
    return n ? `ASK CLAUDE  ·  chat · ${n} question${n === 1 ? "" : "s"}` : "ASK CLAUDE  ·  new chat";
  },
  tapHint: (st) => {
    const a = st.ask;
    if (a.phase === "listening") return "L tap  send   swipe  back";
    if (a.phase === "thinking" || a.streaming) return "swipe  back";
    if (a.phase === "answer") {
      const n = askPages(st);
      const more = a.page + 1 < n;
      return `${n > 1 ? `${a.page + 1}/${n}   ` : ""}L tap  ${more ? "more" : "follow-up"}   swipe  back`;
    }
    return `L tap  ask   ${a.history.length ? "L 2x  new chat   " : ""}swipe  back`;
  },
  body: askBody,
};

const SAVED_LABEL_MS = 5 * 60_000; // younger saved data needs no label

/** Footer: page dots on the left, a short dim hint on the right. */
export function footer(st: DashState, current: number): { dots: string; hint: string } {
  const cards = visibleCards(st);
  const id = cards[current] ?? cards[0];
  // On the Listen card, "● ● ●" in the corner means the mic is still on.
  const listening = id === "listen" && st.listen.phase !== "off" && !alertFrame(st) && !st.askOpen;
  const dots = listening ? "● ● ●" : cards.map((_, i) => (i === current ? "●" : "○")).join(" ");
  if (!st.settings.showHints) return { dots, hint: "" };
  const alert = alertFrame(st);
  if (alert) return { dots, hint: alert.hint };
  if (st.askOpen) return { dots, hint: ASK.tapHint(st) };
  // Last launch's data, still refreshing (or offline): say how old it is instead of the hint.
  const saved = st.saved[id];
  if (saved && st.now.getTime() - saved > SAVED_LABEL_MS) return { dots, hint: `updated ${clock(new Date(saved), st.settings.use24h)}` };
  return { dots, hint: CARDS[id].tapHint(st) };
}

/** Battery levels (0-100) of the glasses and the R1 ring; null until the device reports in. */
export interface Batteries { glasses: number | null; ring: number | null }

/**
 * Header: card title on the left, time + battery on the right. With `drawn`, the batteries are a
 * small picture next to the time (see batteryWidget), so the text is just the time; otherwise
 * they're text: "82%" for the glasses and "R 64" for the ring.
 */
export function header(st: DashState, current: number, batt: Batteries, drawn = false): { title: string; status: string } {
  const cards = visibleCards(st);
  const title = alertFrame(st)?.title ?? (st.askOpen ? ASK : CARDS[cards[current] ?? cards[0]]).title(st);
  const time = clock(st.now, st.settings.use24h);
  if (drawn) return { title, status: time };
  const levels = [batt.glasses != null ? `${batt.glasses}%` : "", batt.ring != null ? `R ${batt.ring}` : ""].filter(Boolean).join("  ");
  return { title, status: [time, levels].filter(Boolean).join("   ") };
}
