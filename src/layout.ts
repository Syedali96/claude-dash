// The glasses screen: 576 x 288, monochrome green, origin top-left.
// Design "Tiles": a quiet header (title left, time right), a body made of
// rounded tiles that group each topic, and a dim footer (dots left, hint right).
// Change the numbers here to redesign the layout.
import {
  CreateStartUpPageContainer,
  type EvenAppBridge,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import type { Body, Tile } from "./cards";
import type { Settings } from "./settings";

export const SCREEN = { width: 576, height: 288 };
/** The body area tiles are placed in (tile x/y are relative to it). */
export const BODY = { x: 0, y: 42, w: 576, h: 202 };
export const PAD = { tile: 6, free: 4 };

export const REGION = {
  title: { id: 1, name: "title", x: 0, y: 0, w: 410, h: 39 },
  status: { id: 2, name: "status", x: 430, y: 0, w: 146, h: 39 }, // time + battery, tucked right
  dots: { id: 3, name: "dots", x: 0, y: 246, w: 196, h: 42 }, // room for 7 card dots
  hint: { id: 4, name: "hint", x: 196, y: 246, w: 380, h: 42 },
} as const;
const TILE_ID = 10; // tiles use ids 10, 11, 12, ... (at most 4 per screen)

export const MENU = { refresh: 1, home: 2, close: 3 } as const;

const menuObject = new MenuContainerProperty({
  menuItems: [
    new MenuItemProperty({ itemID: MENU.refresh, itemName: "New day plan" }),
    new MenuItemProperty({ itemID: MENU.home, itemName: "Go to Today" }),
    new MenuItemProperty({ itemID: MENU.close, itemName: "Close Claude Dash" }),
  ],
});

export interface Frame {
  title: string; // "TODAY  ·  Wed, Nov 18"
  status: string; // "7:13 PM   82%"
  body: Body;
  dots: string; // "● ○ ○ ○ ○"
  hint: string; // "2/2   tap  more"
}

function text(
  id: number, name: string, x: number, y: number, w: number, h: number,
  content: string, brightness: number, capture: boolean, z: number, border: boolean, pad: number,
): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: x, yPosition: y, width: w, height: h,
    containerID: id, containerName: name, content,
    textColor: brightness,
    isEventCapture: capture ? 1 : 0, // exactly one container receives ring / temple gestures
    zOrderIndex: z,
    paddingLength: pad,
    borderWidth: border ? 1 : 0,
    borderColor: border ? 4 : 0,
    borderRadius: border ? 8 : 0,
  });
}

/** Which tile takes the gestures: the one marked, else the biggest. */
function captureIndex(tiles: Tile[]): number {
  const marked = tiles.findIndex((t) => t.capture);
  if (marked >= 0) return marked;
  let best = 0;
  tiles.forEach((t, i) => { if (t.w * t.h > tiles[best].w * tiles[best].h) best = i; });
  return best;
}

function page(frame: Frame, s: Settings) {
  const b = s.brightness;
  const cap = captureIndex(frame.body.tiles);
  const tiles = frame.body.tiles.map((t, i) =>
    text(
      TILE_ID + i, `tile${i}`, BODY.x + t.x, BODY.y + t.y, t.w, t.h, t.text || " ",
      t.dim ? Math.max(1, b.body - 2) : b.body, i === cap, 10 + i, !!t.border, t.border ? PAD.tile : PAD.free,
    ),
  );
  const r = REGION;
  const textObject = [
    text(r.title.id, r.title.name, r.title.x, r.title.y, r.title.w, r.title.h, frame.title, Math.min(4, b.header + 2), false, 1, false, 4),
    text(r.status.id, r.status.name, r.status.x, r.status.y, r.status.w, r.status.h, frame.status, b.header, false, 2, false, 4),
    ...tiles,
    text(r.dots.id, r.dots.name, r.dots.x, r.dots.y, r.dots.w, r.dots.h, frame.dots, b.footer + 1, false, 3, false, 4),
    text(r.hint.id, r.hint.name, r.hint.x, r.hint.y, r.hint.w, r.hint.h, frame.hint, b.footer, false, 4, false, 4),
  ];
  return { containerTotalNum: textObject.length, textObject, menuObject };
}

/** True when the tile arrangement changed (needs a rebuild, not just new text). */
export function shapeChanged(a: Frame, b: Frame): boolean {
  const sig = (f: Frame) => `${captureIndex(f.body.tiles)}:` + f.body.tiles.map((t) => `${t.x},${t.y},${t.w},${t.h},${!!t.border},${!!t.dim}`).join("|");
  return sig(a) !== sig(b);
}

let created = false;

/** Draw a full frame. First call creates the page; later calls rebuild it. */
export async function drawFrame(bridge: EvenAppBridge, frame: Frame, s: Settings): Promise<boolean> {
  if (!created) {
    const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page(frame, s)));
    if (result === StartUpPageCreateResult.success) return (created = true);
    // A page can already exist (e.g. the web view reloaded while the glasses
    // kept showing our app). Take it over with a rebuild instead.
    created = await bridge.rebuildPageContainer(new RebuildPageContainer(page(frame, s)));
    if (!created) console.warn("Could not create or rebuild the glasses page:", result);
    return created;
  }
  return bridge.rebuildPageContainer(new RebuildPageContainer(page(frame, s)));
}

/** Sleep: replace everything with one empty, borderless box so nothing is lit. Taps still reach us. */
export async function drawBlank(bridge: EvenAppBridge): Promise<boolean> {
  const blank = text(9, "sleep", 0, 0, SCREEN.width, SCREEN.height, " ", 0, true, 1, false, 0);
  return bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: 1, textObject: [blank], menuObject }));
}

/** Update a header/footer region in place (cheaper than a rebuild, no flicker). */
export function updateRegion(bridge: EvenAppBridge, region: keyof typeof REGION, content: string) {
  const r = REGION[region];
  return bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: r.id, containerName: r.name, content }));
}

/** Update one tile's text in place. */
export function updateTile(bridge: EvenAppBridge, index: number, content: string) {
  return bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: TILE_ID + index, containerName: `tile${index}`, content: content || " " }));
}
