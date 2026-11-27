// The phone screen: settings editor + a live preview of what the glasses show.
import { setupUrl } from "./api";
import type { Frame } from "./layout";
import { CARD_LABELS, type CardId, type LoggedSet, type Settings } from "./settings";

type Gesture = "next" | "prev" | "tap" | "double" | "long";

interface Hooks {
  onChange(s: Settings): void;
  onGesture(g: Gesture): void;
  onGymUndo(): void;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const ALL: CardId[] = ["agenda", "news", "inbox", "gym", "brief", "ask", "listen"];

export function mountPhoneUI(initial: Settings, hooks: Hooks) {
  let s = structuredClone(initial);
  const emit = () => hooks.onChange(structuredClone(s));

  function renderCards() {
    const list = $("#cards");
    const order = [...s.cards, ...ALL.filter((c) => !s.cards.includes(c))];
    list.innerHTML = "";
    for (const id of order) {
      const on = s.cards.includes(id);
      const li = document.createElement("li");
      li.innerHTML = `
        <label><input type="checkbox" ${on ? "checked" : ""}> ${CARD_LABELS[id]}</label>
        <span class="move">
          <button data-d="-1" aria-label="Move up" ${on ? "" : "disabled"}>↑</button>
          <button data-d="1" aria-label="Move down" ${on ? "" : "disabled"}>↓</button>
        </span>`;
      li.querySelector("input")!.addEventListener("change", (e) => {
        const checked = (e.target as HTMLInputElement).checked;
        s.cards = checked ? [...s.cards, id] : s.cards.filter((c) => c !== id);
        if (!s.cards.length) s.cards = ["agenda"];
        renderCards();
        emit();
      });
      li.querySelectorAll<HTMLButtonElement>("button").forEach((b) =>
        b.addEventListener("click", () => {
          const i = s.cards.indexOf(id);
          const j = i + Number(b.dataset.d);
          if (i < 0 || j < 0 || j >= s.cards.length) return;
          [s.cards[i], s.cards[j]] = [s.cards[j], s.cards[i]];
          renderCards();
          emit();
        }),
      );
      list.appendChild(li);
    }
  }

  function fill() {
    $<HTMLTextAreaElement>("#tasks").value = s.tasks.join("\n");
    $<HTMLTextAreaElement>("#prompt").value = s.briefPrompt;
    $<HTMLInputElement>("#sleep").value = String(s.sleepSeconds);
    for (const k of ["heavy", "compound", "isolation"] as const) $<HTMLInputElement>(`#rest-${k}`).value = String(s.rest[k]);
    $<HTMLInputElement>("#h24").checked = s.use24h;
    $<HTMLInputElement>("#hints").checked = s.showHints;
    $<HTMLInputElement>("#posture").checked = s.postureCat;
    for (const k of ["header", "body", "footer"] as const) $<HTMLInputElement>(`#b-${k}`).value = String(s.brightness[k]);
    $<HTMLInputElement>("#server").value = s.serverUrl;
    $<HTMLInputElement>("#token").value = s.accessToken;
    $<HTMLAnchorElement>("#setup").href = setupUrl(s);
    renderCards();
  }

  $("#tasks").addEventListener("change", (e) => {
    s.tasks = (e.target as HTMLTextAreaElement).value.split("\n").map((t) => t.trim()).filter(Boolean);
    emit();
  });
  $("#prompt").addEventListener("change", (e) => {
    s.briefPrompt = (e.target as HTMLTextAreaElement).value.trim() || initial.briefPrompt;
    emit();
  });
  $("#sleep").addEventListener("change", (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    s.sleepSeconds = Number.isFinite(v) ? Math.min(600, Math.max(0, v)) : 30;
    emit();
  });
  for (const k of ["heavy", "compound", "isolation"] as const)
    $(`#rest-${k}`).addEventListener("change", (e) => {
      s.rest[k] = Math.min(600, Math.max(15, Number((e.target as HTMLInputElement).value) || s.rest[k]));
      emit();
    });
  $("#gym-undo").addEventListener("click", () => hooks.onGymUndo());
  $("#server").addEventListener("change", (e) => { s.serverUrl = (e.target as HTMLInputElement).value.trim(); fill(); emit(); });
  $("#token").addEventListener("change", (e) => { s.accessToken = (e.target as HTMLInputElement).value.trim(); fill(); emit(); });
  $("#h24").addEventListener("change", (e) => { s.use24h = (e.target as HTMLInputElement).checked; emit(); });
  $("#hints").addEventListener("change", (e) => { s.showHints = (e.target as HTMLInputElement).checked; emit(); });
  $("#posture").addEventListener("change", (e) => { s.postureCat = (e.target as HTMLInputElement).checked; emit(); });
  for (const k of ["header", "body", "footer"] as const)
    $(`#b-${k}`).addEventListener("input", (e) => { s.brightness[k] = Number((e.target as HTMLInputElement).value); emit(); });

  document.querySelectorAll<HTMLButtonElement>("[data-g]").forEach((b) =>
    b.addEventListener("click", () => hooks.onGesture(b.dataset.g as Gesture)),
  );

  fill();

  return {
    sync(next: Settings) { s = structuredClone(next); fill(); },
    showGym(sets: LoggedSet[]) {
      // Last 14 days, newest first, grouped by day and exercise.
      const days = new Map<string, Map<string, string[]>>();
      const cutoff = Date.now() - 14 * 86_400_000;
      for (const x of [...sets].reverse()) {
        if (x.t < cutoff) break;
        const day = new Date(x.t).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        const ex = days.get(day) ?? new Map<string, string[]>();
        const label = `${x.exercise}${x.weight ? ` (${x.unit})` : ""}`;
        ex.set(label, [x.weight ? `${x.weight}x${x.reps}` : `${x.reps} reps`, ...(ex.get(label) ?? [])]);
        days.set(day, ex);
      }
      const box = $("#gym-log");
      box.innerHTML = "";
      if (!days.size) box.textContent = "No sets in the last 14 days.";
      for (const [day, ex] of days) {
        const h = document.createElement("b");
        h.textContent = day;
        box.appendChild(h);
        for (const [name, list] of ex) {
          const row = document.createElement("div");
          row.textContent = `${name}: ${list.join(", ")}`;
          box.appendChild(row);
        }
      }
      $<HTMLButtonElement>("#gym-undo").disabled = !sets.length;
    },
    setConnected(ok: boolean) {
      $("#status").textContent = ok ? "Connected to the Even app" : "Preview mode: open this inside the Even app to drive the glasses";
      $("#status").classList.toggle("ok", ok);
    },
    preview(f: Frame) {
      $("#pv-header").textContent = `${f.title}    ${f.status}`;
      // Draw each tile as a positioned box (the body area is 576 x 202).
      const body = $("#pv-body");
      body.innerHTML = "";
      for (const t of f.body.tiles) {
        const d = document.createElement("div");
        d.className = `pv-tile${t.border ? " border" : ""}${t.dim ? " dim" : ""}`;
        Object.assign(d.style, { left: `${(t.x / 576) * 100}%`, top: `${(t.y / 202) * 100}%`, width: `${(t.w / 576) * 100}%`, height: `${(t.h / 202) * 100}%` });
        d.textContent = t.text;
        body.appendChild(d);
      }
      $("#pv-left").textContent = "";
      $("#pv-right").textContent = "";
      $("#pv-footer").textContent = `${f.dots}    ${f.hint}`;
      const lv = (n: number) => String(0.25 + (n / 4) * 0.75);
      $("#pv-header").style.opacity = lv(s.brightness.header);
      $("#pv-body").style.opacity = lv(s.brightness.body);
      $("#pv-left").style.opacity = lv(Math.max(0, s.brightness.body - 2));
      $("#pv-right").style.opacity = lv(s.brightness.body);
      $("#pv-footer").style.opacity = lv(s.brightness.footer);
    },
  };
}
