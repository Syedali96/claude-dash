// Who the dashboard is for. Set these as Worker secrets (see .dev.vars.example), so your
// name and interests never need to be written into the code.
import { accounts } from "./google";
import type { Env } from "./index";

/** Your first name, or "the user". */
export const ownerName = (env: Env) => env.OWNER_NAME?.trim() || "the user";

/** "Sam, founder of a small design studio" (or just the name when ABOUT_ME is empty). */
export function ownerIntro(env: Env): string {
  const about = env.ABOUT_ME?.trim();
  return about ? `${ownerName(env)}, ${about}` : ownerName(env);
}

/** One sentence listing the calendar and inboxes, for Claude's instructions. */
export function accountsLine(env: Env): string {
  const emails = Object.values(accounts(env));
  if (!emails.length) return "";
  return `(the calendar is ${emails[0]}; the inboxes are ${emails.join(", ")})`;
}

/** What the News card favors, most important first. */
export const DEFAULT_NEWS_INTERESTS =
  "AI (new models, AI video, image and music generation, AI companies and their funding); " +
  "startups and VC (big rounds, fundraising climate, launches, acquisitions, IPOs); " +
  "the music industry (labels, streaming, artists and AI, music tech, rights and royalties); " +
  "wearables and AR (smart glasses, headsets, Meta, Apple, Google, Even Realities, WHOOP, Garmin, Oura); " +
  "big tech and chips (Nvidia, OpenAI, Apple, Google, Meta, Microsoft) and tech policy that affects them";

export const newsInterests = (env: Env) => env.NEWS_INTERESTS?.trim() || DEFAULT_NEWS_INTERESTS;
