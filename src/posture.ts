// Posture cat: a small cat that pops up in the bottom-right corner when you slouch.
// It watches head tilt from the glasses' motion sensor (IMU), so it needs no camera,
// mic or network. Head down for a while = cat with "!", longer = cat goes limp,
// head up = cat disappears.
//
// The detection and the cat drawings come from Posture Cat by Kansai Takako
// (github.com/unicco/even-g2-posture), MIT License:
//   Copyright (c) 2026 Kansai Takako
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software
//   without restriction, including without limitation the rights to use, copy, modify, merge,
//   publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
//   to whom the Software is furnished to do so, subject to the following conditions:
//   The above copyright notice and this permission notice shall be included in all copies or
//   substantial portions of the Software.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
//   PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
//   FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
//   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//   DEALINGS IN THE SOFTWARE.
//
// Changes for Claude Dash: the sensor is read slowly (once a second) to save battery, the cat
// is a static pop-up over the current card (no tail wag, so fewer Bluetooth image sends), and
// it only shows when slouching, never while you sit up straight.
import {
  type EvenAppBridge,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  ImuReportPace,
  OsEventTypeList,
  type Sys_ItemEvent,
} from "@evenrealities/even_hub_sdk";

export type CatPose = "warn" | "limp";

/** Where the cat sits: bottom-right corner, over the footer. */
export const CAT = { id: 30, name: "cat", x: 504, y: 216, w: 64, h: 64, z: 50 } as const;

const PACE = ImuReportPace.P1000; // slowest the glasses offer: about one reading a second
const TILT_X = -0.3; // head pitched down past this counts as slouching (a quick glance down doesn't)
const EXIT_MARGIN = 0.08; // must come back up this much past the line to count as fixed
const EMA_ALPHA = 0.5;
const WARN_MS = 45_000; // "!" after this long slouching
const LIMP_MS = 120_000; // limp after this long
const QUIET_MS = 10 * 60_000; // after you sit up, no new cat for this long
const REARM_MS = 20_000; // no readings for this long: ask for them again (they stop while you hold still, too)

let latestX: number | null = null;
let lastSampleAt = 0;
let smoothedX: number | null = null;
let engaged = false;
let holdMs = 0;
let lastTick = 0;
let lastArm = 0;
let armed = false;
let foreground = true;
let pose: CatPose | null = null;
let quietUntil = 0; // no new pop-up before this time
let sentPose: CatPose | null = null;
let sending = false;
const pngs: Partial<Record<CatPose, Uint8Array>> = {};

/** The cat to show right now, or null when you're sitting up (or it isn't allowed). */
export function catPose(): CatPose | null {
  return pose;
}

/** Image container for a page that shows the cat. */
export function catContainer(): ImageContainerProperty {
  return new ImageContainerProperty({ xPosition: CAT.x, yPosition: CAT.y, width: CAT.w, height: CAT.h, containerID: CAT.id, containerName: CAT.name, zOrderIndex: CAT.z });
}

/** Turn the motion sensor on (slowly) or off. Safe to call often. */
export async function arm(bridge: EvenAppBridge, on: boolean) {
  if (on && !foreground) on = false;
  if (!on && !armed) return;
  armed = on;
  lastArm = Date.now();
  try { await bridge.imuControl(on, PACE); } catch { /* the simulator has no IMU; real glasses retry on the next tick */ }
}

/**
 * Handle a system event. Returns true when it was posture data (nothing else to do with it).
 * Also stops the sensor when Claude Dash leaves the screen and restarts it when it comes back.
 */
export function onSysEvent(bridge: EvenAppBridge, sys: Sys_ItemEvent, enabled: boolean): boolean {
  if (sys.imuData) {
    if (typeof sys.imuData.x === "number") { latestX = sys.imuData.x; lastSampleAt = Date.now(); }
    return true;
  }
  const t = sys.eventType;
  if (t === OsEventTypeList.FOREGROUND_EXIT_EVENT || t === OsEventTypeList.ABNORMAL_EXIT_EVENT || t === OsEventTypeList.SYSTEM_EXIT_EVENT) {
    void arm(bridge, false);
    foreground = false;
    return true;
  }
  if (t === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    foreground = true;
    if (enabled) void arm(bridge, true);
    return true;
  }
  return false;
}

/**
 * Run once a second. `allowed` is false while something else needs the screen (Ask, Listen, gym,
 * an email pop-up). Returns true when the cat should appear, change or go away.
 */
export function tick(bridge: EvenAppBridge | null, enabled: boolean, allowed: boolean): boolean {
  const now = Date.now();
  const dt = lastTick ? now - lastTick : 0;
  lastTick = now;

  if (bridge) {
    if (!enabled && armed) void arm(bridge, false);
    // Readings stop while your head is still, so only re-ask after a long quiet spell.
    if (enabled && foreground && (!armed || (now - Math.max(lastSampleAt, lastArm) > REARM_MS))) void arm(bridge, true);
  }

  if (enabled && latestX !== null) {
    smoothedX = smoothedX === null ? latestX : smoothedX * (1 - EMA_ALPHA) + latestX * EMA_ALPHA;
    if (!engaged && smoothedX <= TILT_X) engaged = true;
    else if (engaged && smoothedX > TILT_X + EXIT_MARGIN) engaged = false;
    holdMs = engaged ? holdMs + dt : 0;
  } else {
    engaged = false;
    holdMs = 0;
  }

  let next: CatPose | null = null;
  if (holdMs >= LIMP_MS) next = "limp";
  else if (holdMs >= WARN_MS) next = "warn";
  // You sat up after the cat showed: give it a rest before the next one.
  if (pose && !next) quietUntil = now + QUIET_MS;
  if (!pose && now < quietUntil) next = null; // still resting (a cat already showing can still go limp)
  if (!allowed) next = null; // keep timing, just don't show it

  const changed = next !== pose;
  pose = next;
  return changed;
}

/** Forget what the glasses show (after a full rebuild the image box starts empty). */
export function resetSent() {
  sentPose = null;
}

/** Send the cat picture if the glasses don't have the right one yet. Retries if Bluetooth drops it. */
export async function syncImage(bridge: EvenAppBridge) {
  if (!pose || pose === sentPose || sending) return;
  sending = true;
  try {
    for (let i = 0; i < 4 && pose && pose !== sentPose; i++) {
      const target = pose;
      const data = pngs[target] ?? (pngs[target] = await makePng(target === "warn" ? drawWarn : drawLimp));
      const r = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: CAT.id, containerName: CAT.name, imageData: data })).catch(() => null);
      if (r === ImageRawDataUpdateResult.success) sentPose = target;
      else await new Promise((res) => setTimeout(res, 400));
    }
  } finally {
    sending = false;
  }
}

/** Dev only: pretend the head goes down. ?posturetest=warn or =limp shows that cat right away. */
export function devTest(which: string | null) {
  if (!which) return;
  latestX = -0.5;
  lastSampleAt = Date.now();
  holdMs = which === "limp" ? LIMP_MS : WARN_MS;
  engaged = true;
  smoothedX = -0.5;
}

// ---------- drawings (from Posture Cat) ----------

const W = CAT.w;
const H = CAT.h;
const CX = W * 0.42;

async function makePng(draw: (ctx: CanvasRenderingContext2D) => void): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  draw(ctx);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

function drawWarn(ctx: CanvasRenderingContext2D) {
  // Body, head and ears.
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(CX - W * 0.24, H * 0.94);
  ctx.quadraticCurveTo(CX - W * 0.32, H * 0.55, CX - W * 0.15, H * 0.44);
  ctx.lineTo(CX + W * 0.15, H * 0.44);
  ctx.quadraticCurveTo(CX + W * 0.32, H * 0.55, CX + W * 0.24, H * 0.94);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(CX, H * 0.32, H * 0.18, 0, Math.PI * 2);
  ctx.fill();
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(CX + s * H * 0.17, H * 0.21);
    ctx.lineTo(CX + s * H * 0.08, H * 0.04);
    ctx.lineTo(CX + s * H * 0.01, H * 0.2);
    ctx.closePath();
    ctx.fill();
  }
  // Tail.
  ctx.lineWidth = W * 0.1;
  ctx.strokeStyle = "#fff";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(CX + W * 0.2, H * 0.9);
  ctx.quadraticCurveTo(CX + W * 0.44, H * 0.78, CX + W * 0.3, H * 0.5);
  ctx.stroke();
  // Eyes.
  ctx.fillStyle = "#000";
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(CX + s * H * 0.07, H * 0.32, H * 0.03, 0, Math.PI * 2);
    ctx.fill();
  }
  // "!"
  ctx.fillStyle = "#fff";
  ctx.fillRect(W * 0.82, H * 0.04, W * 0.06, H * 0.14);
  ctx.beginPath();
  ctx.arc(W * 0.85, H * 0.24, W * 0.045, 0, Math.PI * 2);
  ctx.fill();
}

function drawLimp(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.ellipse(W * 0.52, H * 0.76, W * 0.34, H * 0.15, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(W * 0.24, H * 0.66, H * 0.17, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(W * 0.2, H * 0.54);
  ctx.lineTo(W * 0.08, H * 0.48);
  ctx.lineTo(W * 0.22, H * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(W * 0.28, H * 0.52);
  ctx.lineTo(W * 0.28, H * 0.42);
  ctx.lineTo(W * 0.37, H * 0.52);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = W * 0.09;
  ctx.strokeStyle = "#fff";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(W * 0.84, H * 0.78);
  ctx.quadraticCurveTo(W * 0.94, H * 0.82, W * 0.89, H * 0.92);
  ctx.stroke();
  // Closed eyes.
  ctx.strokeStyle = "#000";
  ctx.lineWidth = H * 0.025;
  ctx.beginPath();
  ctx.moveTo(W * 0.17, H * 0.64);
  ctx.lineTo(W * 0.24, H * 0.64);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(W * 0.28, H * 0.64);
  ctx.lineTo(W * 0.35, H * 0.64);
  ctx.stroke();
}
