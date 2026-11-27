// Small drawn widgets ("Glyph mix", v0.15.0): rings, sparklines, the mic and the email box.
// Each one is drawn with Glyph (github.com/gabrielevierti/glyph, MIT, (c) 2026 theboredprog)
// into a small 16-level gray picture, turned into a PNG, and sent to one image container,
// the same way the posture cat is sent. All text stays in text containers except what is
// part of a widget's picture.
//
// Sending a picture goes over Bluetooth and costs battery, so each image remembers what the
// glasses already show (its `key`) and is only sent again when the key changes. Only one
// picture is sent at a time; if a newer one is wanted meanwhile, the in-between ones are
// skipped and only the latest is sent.
import { type EvenAppBridge, ImageContainerProperty, ImageRawDataUpdate, ImageRawDataUpdateResult } from "@evenrealities/even_hub_sdk";
import { countdownRing, GlyphRaster, gray as G, icon, listeningIndicator, panel, ringChart, sparkline, type TextStyle, wrapClamped } from "@gabrielevierti/glyph";

/** One drawn picture on the screen. x/y are screen coordinates (576 x 288). */
export interface Img {
  x: number;
  y: number;
  w: number; // 20..288
  h: number; // 20..144
  key: string; // same key = same picture (not sent again)
  draw: (g: GlyphRaster) => void;
  cover?: boolean; // sits over text (the email box): text tiles under it are blanked
}

export const IMG_ID = 20; // image containers use ids 20, 21, 22 (the cat is 30)
export const MAX_IMAGES = 3; // the G2 takes 4 image containers per page; one is kept for the cat

export function imgContainer(img: Img, i: number): ImageContainerProperty {
  return new ImageContainerProperty({
    xPosition: img.x, yPosition: img.y, width: img.w, height: img.h,
    containerID: IMG_ID + i, containerName: `img${i}`, zOrderIndex: 40 + i,
  });
}

// ---------- drawing ----------

const SANS = "system-ui, -apple-system, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, Menlo, monospace";
const st = (size: number, weight = 600, font = SANS): TextStyle => ({ font, size, weight, leading: Math.round(size * 1.2) });

const pngCache = new Map<string, Uint8Array>();

/** Draw with Glyph, then turn its 0..15 levels into a grayscale PNG. */
export async function toPng(img: Img): Promise<Uint8Array> {
  const cached = pngCache.get(`${img.w}x${img.h}:${img.key}`);
  if (cached) return cached;
  const g = new GlyphRaster({ width: img.w, height: img.h, supersample: 2, surface: "outline" });
  g.clear(0);
  img.draw(g);
  const levels = g.toLevels();
  g.dispose();
  const canvas = document.createElement("canvas");
  canvas.width = img.w;
  canvas.height = img.h;
  const ctx = canvas.getContext("2d")!;
  const data = ctx.createImageData(img.w, img.h);
  for (let i = 0; i < levels.length; i++) {
    const v = levels[i] * 17;
    data.data[i * 4] = data.data[i * 4 + 1] = data.data[i * 4 + 2] = v;
    data.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (pngCache.size > 40) pngCache.clear();
  pngCache.set(`${img.w}x${img.h}:${img.key}`, bytes);
  return bytes;
}

/** A data URL of the picture, for the phone preview. */
export async function toDataUrl(img: Img): Promise<string> {
  const bytes = await toPng(img);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(bin)}`;
}

// ---------- the widgets ----------

const ZONE_NOTE: Record<string, string> = { GREEN: "ready to push", YELLOW: "go moderate", RED: "take it easy" };

/** Today page 2: recovery ring with the % inside, the zone big next to it, a short note under. */
export function recoveryWidget(x: number, y: number, recovery: number, zone: string): Img {
  return {
    x, y, w: 228, h: 82, key: `rec:${recovery}:${zone}`,
    draw: (g) => {
      ringChart(g, 40, 41, 34, recovery / 100, { width: 6, value: `${recovery}%` });
      g.text(zone, 92, 32, st(28, 800), G.max, "left", "middle");
      g.text(ZONE_NOTE[zone] ?? "", 93, 60, st(15, 500), G.secondary, "left", "middle");
    },
  };
}

/** News: a small line of today's prices at the right end of a market tile. */
export function sparkWidget(x: number, y: number, values: number[]): Img {
  const key = `spark:${values.map((v) => v.toPrecision(5)).join(",")}`;
  return {
    x, y, w: 90, h: 30, key,
    draw: (g) => sparkline(g, { x: 3, y: 4, width: 82, height: 22 }, values, { gray: G.max, width: 1.5, dot: true }),
  };
}

/** Gym: the rest countdown as a ring that empties, time in the middle, "REST" under it. */
export function restWidget(x: number, y: number, remainingSec: number, totalSec: number): Img {
  return {
    x, y, w: 144, h: 144, key: `rest:${remainingSec}:${totalSec}`,
    draw: (g) => {
      countdownRing(g, 72, 66, 60, remainingSec, totalSec, { width: 6 });
      g.text("REST", 72, 94, st(13, 700), G.secondary, "center", "middle");
    },
  };
}

/** Listen: a still mic with rings (no animation, to save battery). */
export function micWidget(x: number, y: number): Img {
  return {
    x, y, w: 144, h: 144, key: "mic",
    draw: (g) => listeningIndicator(g, 72, 72, 66, 0.8, 0, { state: "listening" }),
  };
}

/** New email: a 288 x 144 box over the card, so the card stays in view behind it. */
export function emailWidget(x: number, y: number, a: { from: string; line: string; summary: string; tag: string; at: number }, count: string): Img {
  const ago = Math.max(0, Math.round((Date.now() - a.at) / 60_000));
  const when = ago < 2 ? "now" : ago < 60 ? `${ago}m` : `${Math.round(ago / 60)}h`;
  return {
    x, y, w: 288, h: 144, cover: true, key: `mail:${a.from}:${a.line}:${a.summary.slice(0, 40)}:${when}:${count}`,
    draw: (g) => {
      g.rect({ x: 0, y: 0, width: 288, height: 144 }, { fill: 0 });
      panel(g, { x: 0.5, y: 0.5, width: 287, height: 143 }, { radius: 10, stroke: G.max, strokeWidth: 1.5 });
      icon(g, "mail", 20, 19, 16, G.max);
      g.text(`NEW EMAIL  ·  ${a.tag.toUpperCase()}${count}`, 34, 19, st(12, 700), G.strong, "left", "middle");
      g.text(when, 276, 19, st(12, 600), G.secondary, "right", "middle");
      const bold = st(16, 800);
      const head = wrapClamped(g.measure, `${a.from}: ${a.line}`, bold, 264, 1)[0] ?? "";
      g.text(head, 12, 46, bold, G.max, "left", "middle");
      const body = st(13, 500);
      wrapClamped(g.measure, a.summary.replace(/\s+/g, " "), body, 264, 3).forEach((l, i) => g.text(l, 12, 70 + i * 17, body, G.primary, "left", "middle"));
      g.hline(10, 278, 120, G.hairline);
      g.text("TAP  READ     2X  CLOSE", 144, 132, st(11, 700, MONO), G.secondary, "center", "middle");
    },
  };
}

// ---------- sending ----------

let sent: (string | null)[] = []; // what each image container shows now
let wanted: (Img | null)[] = [];
let sending = false;
let gen = 0; // bumped by a rebuild, so a send that was already on its way isn't counted for the new page
let bridgeRef: EvenAppBridge | null = null;
export const timing = { sends: 0, lastMs: 0, avgMs: 0, skipped: 0 };

/**
 * How often (seconds) a ticking picture (the gym rest ring) should change. Every second while
 * pictures arrive quickly; every 2-5 s when Bluetooth is slow (the exact time then also shows as text).
 */
export function tickStep(): number {
  const ms = Math.max(timing.avgMs, timing.lastMs);
  return ms < 600 ? 1 : ms < 1500 ? 2 : ms < 3000 ? 3 : 5;
}

/** After a full page rebuild every image container starts empty. */
export function resetSent() {
  sent = [];
  gen++;
}

/** True while a picture is still on its way to the glasses. */
export function busy(): boolean {
  return sending;
}

/** Ask for these pictures to be on the glasses. Sends only what changed, one at a time. */
export function sync(bridge: EvenAppBridge, images: Img[]) {
  bridgeRef = bridge;
  wanted = images.slice(0, MAX_IMAGES);
  if (sending) { timing.skipped++; return; } // the loop below picks up the newest wish when it's free
  void pump();
}

async function pump() {
  sending = true;
  try {
    for (let guard = 0; guard < 12; guard++) {
      const i = wanted.findIndex((img, n) => img && sent[n] !== img.key);
      if (i < 0 || !bridgeRef) break;
      const img = wanted[i]!;
      const data = await toPng(img);
      const myGen = gen;
      const t0 = performance.now();
      const r = await bridgeRef.updateImageRawData(new ImageRawDataUpdate({ containerID: IMG_ID + i, containerName: `img${i}`, imageData: data })).catch(() => null);
      const ms = performance.now() - t0;
      timing.sends++;
      timing.lastMs = Math.round(ms);
      timing.avgMs = Math.round(timing.avgMs + (ms - timing.avgMs) / timing.sends);
      if (import.meta.env.DEV) console.log(`[img] ${img.key.slice(0, 24)} ${img.w}x${img.h} ${data.length} B in ${Math.round(ms)} ms (${r})`);
      if (r === ImageRawDataUpdateResult.success) { if (myGen === gen) sent[i] = img.key; }
      else await new Promise((res) => setTimeout(res, 400)); // Bluetooth hiccup: try again shortly
    }
  } finally {
    sending = false;
  }
}
