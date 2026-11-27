# Claude Dash: project context

Everything needed to keep building **Claude Dash**: Ali's personal Claude-powered dashboard for the **Even Realities G2** smart glasses. This file summarizes the full build conversation (Nov 18–24, 2026). It contains **no secret values**. Keys live in `.dev.vars` on Ali's Mac and as Cloudflare Worker secrets.

---

## 1. Who it's for and how to work with Ali

- **Ali (Syed Ali):** founder of **Echonos**, an AI music-video startup (echonos.ai). He also films reels, lifts weights, wears a WHOOP, and runs investor outreach.
- **Explanations:** simple and short. No over-explaining.
- **Visual changes:** show a mockup first, then build after he approves. He has asked for this more than once.
- **Before big changes:** he likes being asked a few clarifying questions, given as options.
- **After every change:** test it in the simulator, then ship a new beta version.
- **Secrets:** never paste keys or tokens in chat or into code. Ali saves them in `.dev.vars` himself.
  - Exception: once, at his request, the access token was shown in chat. It was then rotated.
- **Google access is read-only.** The dashboard never sends, deletes or changes email or calendar events.

## 2. Accounts and services

| Service | What it's used for | Notes |
|---|---|---|
| Even Realities / Even Hub | Glasses and app store (private beta) | Developer account signed in with **syedbali1996@gmail.com**. Package id `com.personal.claudedash`. Ali is the only beta tester. |
| Cloudflare Workers (free plan) | Always-on server | `https://claude-dash.claude-g2-dashboard.workers.dev`. Uses a KV namespace `TOKENS`. |
| Anthropic API | All Claude calls | Model `claude-opus-5-5`, `effort: "low"`, with `server-side-fallback-2026-07-01` and `fallbacks: "default"`. |
| Google Cloud project "Claude Dash" | Calendar + Gmail OAuth | Owned by the Gmail account. Audience: **External, In production**, unverified, so users see a "Google hasn't verified this app" warning and click Advanced → continue. Read-only scopes. Redirect: `/auth/google/callback`. Home page `/` and privacy page `/privacy` are served by the Worker. |
| Google accounts connected (4) | Inboxes | `ali@echonos.ai` (calendar + inbox, tag `ech`), `hello@echonos.ai` (`hel`), `ali@ali-syed.com` (`asy`, Google Workspace), `syedbali1996@gmail.com` (`gml`). |
| WHOOP developer app | Recovery, sleep, strain | OAuth. Redirect: `/auth/whoop/callback`. Scopes: `offline read:recovery read:cycles read:sleep read:workout read:profile`. Refresh tokens rotate on each use. |
| Groq (free tier) | Speech-to-text | `whisper-large-v3-turbo`. Used by the gym log and Ask Claude. |
| News feeds | News | Public RSS: BBC World, NPR World, `morningbrew.com/feed`, `techbrew.com/feed` (full text), TechCrunch, BBC Technology. |
| Yahoo Finance + Coinbase | Markets | S&P 500 day %, BTC price + 24h %. CoinGecko is blocked from Cloudflare, so it isn't used. |
| iPhone Shortcuts | Reminders sync | A "Send Reminders" Shortcut POSTs reminders due today to `/api/reminders`. |
| Claude Code Remote Control | Drive Claude Code from his phone | Requires a claude.ai subscription login (`/login` inside `claude`), then `claude rc`. |

**Secrets** (names only):
- On the Worker: `ANTHROPIC_API_KEY`, `APP_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GROQ_API_KEY`, `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`.
- `SERVER_URL` exists only in `.dev.vars`.
- Every `/api` route requires `Authorization: Bearer <APP_TOKEN>`.
- The token is **not** baked into the glasses package. Ali pastes it once in the phone settings (Connection → Access token), and also into the Shortcut's header.

## 3. Architecture

```
Glasses (G2) ⇄ Even app WebView (phone) runs the Claude Dash web app (Vite + TypeScript)
                    │  fetch with Bearer token
                    ▼
     Cloudflare Worker (worker/*.ts) + KV ──► Google Calendar/Gmail, WHOOP, Groq,
                                              Anthropic, Morning Brew/Tech Brew,
                                              Yahoo/Coinbase
```

- **Glasses app**, in `src/`:
  - `main.ts`: state, data refreshes, gestures, mic, alerts, sleep.
  - `cards.ts`: what each card shows, built from "tiles".
  - `layout.ts`: turns tiles into SDK containers.
  - `settings.ts`: phone settings, migrations, gym history storage.
  - `phone.ts` + `index.html`: phone settings page and live preview.
  - `api.ts`: server calls.
- **Server**, in `worker/`:
  - `index.ts`: routes, setup page, day plan, Reminders.
  - `google.ts`: OAuth and calendar.
  - `gmail.ts`: inbox triage and new-email alerts.
  - `whoop.ts`: WHOOP OAuth, today's data, bedtime, tip.
  - `news.ts`: stories, summaries, markets.
  - `gym.ts`: speech-to-text and set parsing.
  - `ask.ts`: Ask Claude with tools.
- **Project folder** (as of Nov 24): a temporary folder the Claude desktop app made for the original session, named `claude-g2-dashboard/`. **Deleting that session deletes the code.** Move it somewhere permanent (e.g. `~/Projects/claude-g2-dashboard`) and ideally into a git repo.

### Server routes

| Route | Does |
|---|---|
| `GET /`, `GET /privacy` | Public home and privacy pages (needed for Google) |
| `GET /setup?token=` | Connect / Reconnect buttons for the 4 Google accounts and WHOOP. **Open on the Mac browser**, because Google blocks sign-in inside the Even app. |
| `/auth/google/start`, `/auth/google/callback` | Google OAuth (state stored in KV for 10 minutes) |
| `/auth/whoop/start`, `/auth/whoop/callback` | WHOOP OAuth (8-character state) |
| `GET /api/status` | Which accounts are connected |
| `GET /api/agenda?start&end` | Calendar events from ali@echonos.ai: no cancelled or declined events, and no working-location entries |
| `GET /api/inbox[?fresh]` | Triaged inbox across 4 accounts: `reply[]`, `followup[]`, `advice`. Cached 15 minutes. |
| `GET /api/alerts?since=<epoch s>` | New emails since the last check that need Ali, with a one-line summary and a 2–3 sentence summary. Stateless. |
| `GET /api/whoop?tz=` | Recovery, HRV, RHR, sleep, need, efficiency, strain, plus `bedtime` and a one-sentence `tip` |
| `GET /api/news` | Up to 10 relevant headlines |
| `GET /api/news/article?n=` | Easy-to-read summary of story n |
| `GET /api/markets` | `{sp500, btc, btcChange, spark:{sp500[], btc[]}}` (S&P since the open, 5-min closes; BTC last 24 h, 15-min; at most 48 points each), cached 5 minutes (`markets:v3`) |
| `GET/POST /api/reminders[?tz=]` | Reminders from the iOS Shortcut (POST `{items: text or array}`). GET returns `{items, at, today}`; `today` = sent today in `tz` (default America/New_York). `/api/brief` was removed in 0.15.0. |
| `POST /api/gym/parse` | Raw 16 kHz PCM in, `{text, set:{exercise,weight,unit,reps}}` out |
| `POST /api/gym/command` | `{audio(base64 PCM) or text, today[], known[]}` in, `{text, command}` out. Command is log / undo / delete / edit / finish / query / none |
| `POST /api/ask` | `{audio(base64 PCM) or text, history, now, timeZone}` in, `{question, answer}` out |
| `POST /api/listen/transcribe?prev=` | Raw 16 kHz PCM body in, `{text}` out. `prev` = end of the transcript so far (Whisper hint). |
| `POST /api/listen` | Form: `transcript`, optional `audio` (raw PCM tail), `now`, `timeZone`. Streams text: `HEARD:` line, `TOPIC:` line, `- ` points, `SEARCH:` line, then maybe `LATEST:` (`TOPIC: NONE` = nothing to explain, `ERROR:` on failure). Not stored or logged. |

## 4. The glasses app today (v0.8.0)

**Cards, in order: Today → News → Inbox → Gym → Reminders → Listen.** (0.15.0: Day plan became Reminders.) Removed along the way: Home, Tasks, Focus, Teleprompter, Ask Claude (0.14.0: now an overlay opened from the left arm).

### Gestures

| Gesture | Effect |
|---|---|
| Swipe | Next or previous card |
| Tap | The card's action (shown in the footer hint) |
| Double tap | Go to Today. Special cases below. |
| Press-and-hold | Display off (blank). Any touch wakes it, and that touch does nothing else. |
| Left-arm tap (glasses) | Ask Claude over the current card (see below). Ring and right arm keep the gestures above. |

The SDK reports which surface was touched in `sysEvent.eventSource` (1 right arm, 2 ring, 3 left arm), checked on the G2 with `?touchtest` on Nov 26.

Double-tap special cases:
- **News:** open or close a story.
- **Today, when there are unread alerts:** read the new emails.

### Auto-sleep

- After `sleepSeconds` (default 30, phone setting, 0 = never) with no input, the whole screen blanks: a single borderless empty container.
- It doesn't sleep during gym recording or rest timers, or while Ask is listening or thinking.

### Design system: "Tiles" (design B, chosen by Ali)

- **Header:** title on the left at full brightness (e.g. `TODAY · Wed, Nov 18 ● 2 new`), time and battery dim on the right.
- **Body:** rounded tiles. Each is a text container with a 1px border, radius 8 and padding 6, plus unbordered "free" text areas.
  - The body area is 576×202, starting at y=42.
  - At most 4 tiles per screen. The SDK allows at most 8 containers in total, and exactly one with `isEventCapture`.
- **Footer:** page dots on the left; a dim hint on the right like `2/2   tap  more   2x  read new`.
- **Brightness (0–4):** title = header+2, status = header, body = body, dim labels = body−2, dots = footer+1, hint = footer. Phone defaults: header 2, body 4, footer 1.
- **Text metrics:** about 8.8 px per character and 27 px per line. A full-width tile fits 6 rows × about 60 characters.
- **Font:** proportional and fixed-size, with no bold, no colors, and no block glyphs (█ breaks). These glyphs render fine: `● ○ ◆ · >`.

### Each card

- **Today**
  - *Page 1:* NOW/NEXT tile, e.g. "NOW · until 7:00 PM / Brandon <> Mudassir Weekly *" or "NEXT · 6:00 PM · in 45 min". Later meetings are listed below with dim times. `*` marks a recurring series. "Nothing left today" when the day is done.
  - *Page 2, Recovery tile:* `57% YELLOW` (≥67 green, ≥34 yellow, else red), "Bed by 10:50 PM", and a short WHOOP tip under 45 characters.
  - *Page 2, Inbox tile:* REPLY TO with up to 3 "Name: reason" lines, then FOLLOW UP WITH with 1 line. Spare rows go to whichever list is longer.
  - *Email alerts:* the app checks every 2 minutes while open. A new email that needs Ali shows a pop-up ("● NEW EMAIL · sender · tag · one line"); tap reads the summary, double tap closes, and it auto-closes after 15 seconds. Unread ones show as "● N new" in the Today header. Pop-ups are held back while Ali is speaking to Ask or Gym.
- **News**
  - Top tiles: S&P 500 % and BTC $price %.
  - Up to 10 headlines with a `>` cursor. Tap moves the cursor; double tap opens a summary (main point, 3–4 bullets, "Why it matters"). Inside a summary, tap pages and double tap goes back.
  - Story selection: 3 world stories (BBC World, NPR World), then tech/business from Morning Brew, Tech Brew, TechCrunch and BBC Technology, favoring the last 4 hours (wider only if a group runs short). Since 0.14.1, no story stays on screen over 4 hours: each story remembers when it first appeared and is retired after 3.5 h, never returns (remembered 48 h), and Claude is told the retired topics so it moves on unless there's a real new development. Claude must **skip irrelevant topics** (celebrity casting, gift guides, lifestyle, college/student trends, sports) and never picks two stories about the same event. On slow days it shows 9 rather than padding.
- **Inbox:** two count tiles (N TO REPLY, N TO FOLLOW UP), then a list. "Reply" means threads from the last 7 days where a real person spoke last; newsletters, receipts and robots are filtered out. "Follow up" means Ali sent the last message 1–7 days ago with no reply. Claude writes the 36-character lines.
- **Gym**
  - Status tile shows READY / ● LISTENING / Logging... / REST mm:ss / GO.
  - Tap, say "bench, 185, 8 reps", then tap again. It auto-stops after 10 seconds.
  - Parsing uses a regex first, with a Claude fallback.
  - Rest time is a base 90 seconds (phone setting), +30 seconds when WHOOP recovery is yellow, +60 when red.
  - After logging, it shows last session's numbers for that exercise ("last time (Nov 14): 185x8 185x7").
  - History stays on the phone only (Even app storage, up to 2000 sets). The phone settings show the last 14 days and an "Undo last set" button.
- **Reminders** (replaced Day plan in 0.15.0)
  - Only today's iPhone reminders (KV `reminders:today`, POSTed by a Shortcut automation at 6 AM and when the Even app opens), one "◆" per item, tap pages.
  - Hidden completely (not in the dots or swipe order) when the stored list isn't from today or is empty.
- **Ask Claude** (an overlay since 0.14.0, flag `st.askOpen`)
  - A left-arm tap on any card opens Ask over it and starts listening. Left tap again sends; on an answer it pages, then asks a follow-up. Left double tap = new chat. A swipe (ring or right arm) closes Ask (cancels if listening) and returns to the card. Ring taps also work Ask while it's open. Hold = display off.
  - Speak, then tap again (stops by itself after 15 seconds). Groq transcribes it, then Claude uses tools to answer: `search_email` (all 4 inboxes, full text, Gmail search syntax, at most 2 searches per question), `get_calendar`, `get_whoop`, `get_reminders`, `get_inbox_summary`, `get_news`, plus Anthropic `web_search` (at most 2 uses).
  - The question appears in a top tile with the answer below, paged. Double tap asks a follow-up (the last 3 questions and answers are kept).
  - It's **read-only**: no sending or replying.
  - Read-aloud was removed in 0.9.0 (settings v11).
  - The system prompt tells Claude the user is Ali (founder of Echonos) and lists his inboxes.

- **Listen** (after Ask Claude)
  - Tap to start: the glasses mic stays on and the screen shows only three dim dots (no header or footer).
  - Since 0.11.0: silence is dropped on the phone (RMS < `QUIET_RMS`, 0.7 s hangover). Every 10 s (30 s before 0.13.0) the speech so far goes as raw bytes to `POST /api/listen/transcribe` (Groq) in the background; the phone keeps the text for the last 2 minutes (`LISTEN_SECONDS`). Audio leaves the phone while listening, but nothing is stored.
  - Tap: waits for any chunk in flight, then sends the transcript plus the unsent tail audio (multipart) to `POST /api/listen`. The reply streams as plain text: `HEARD: <tail text>` (kept for the next tap), then `TOPIC:` and 4–6 "- " points. The topic tile appears as soon as its line arrives and points fill in. Shown as a topic tile with "◆" points, paged; "● ● ●" in the footer means the mic is still on.
  - Since 0.13.0: answer first, search after. Step 1 is Opus low effort with no tools (topic ~0.7–1.7 s), ending with `SEARCH: <query>|NONE`. If there's a query, the hint shows "checking latest..." and step 2 (Opus low + 1 web search, ~8 s) sends `LATEST: <fact>|NONE`; a fact is shown on top as "> LATEST: ...". Tap waits at most 2 s for a chunk still at Groq. Measured Nov 26 before this: news topics took 11–13 s to show anything because the search ran first.
  - Model (0.11–0.12): Opus at low effort with at most 1 web search. Measured: first text ~0.6–0.9 s; Haiku was slower here (5–7 s) because it usually ran a web search first. Through the Worker the topic shows ~1–1.3 s after the text arrives.
  - Tap on the last page (or 2x) goes back to the dots; it keeps listening the whole time. 2x on the dots stops. Swiping to another card stops and forgets the audio. Hold = display off, still listening.
  - No auto-sleep and no email pop-ups while it's on (alerts go to the badge). No read-aloud.
  - 0.10.0 sent the whole 2 minutes on tap (3.8 MB, ~3–4 s from the Mac). Battery use not measured yet.

### Phone settings page

- Card list with on/off and reordering.
- Day plan prompt, tasks, gym rest seconds plus history and undo.
- Connection: server URL (built in) and access token, plus a link to the setup page.
- Display: brightness ×3, 24-hour clock, hints, read-aloud toggle, and sleep seconds.
- Settings are stored with `bridge.setLocalStorage`. A `SETTINGS_VERSION` (currently **13**) with migrations adds or removes cards on update.

## 5. Even Hub SDK facts learned (v0.0.16)

- **Building the page:**
  - Construct models with `new` (e.g. `new TextContainerProperty({...})`); plain objects fail.
  - Call `createStartUpPageContainer` first. On a reload it can return 1 (already exists), so fall back to `rebuildPageContainer`.
  - Use `textContainerUpgrade` for in-place text changes.
- **Events:**
  - CLICK=0 often arrives with **no eventType** (treat undefined as tap). SCROLL_TOP=1 = prev, SCROLL_BOTTOM=2 = next, DOUBLE_CLICK=3, FOREGROUND_ENTER/EXIT=4/5, LONG_PRESS=9, LONG_PRESS_RELEASE=10.
  - Menu items arrive as `menuItemClickEvent`.
- **Mic:** `bridge.audioControl(true, AudioInputSource.Glasses)` (only after the page exists). Audio arrives as `ev.audioEvent.audioPcm`: 16 kHz, 16-bit, mono.
- **Permissions** in `app.json`: `network` (with a whitelist of the Worker URL and open-meteo), `location`, `g2-microphone`.
- **Other:** `getAppLocation` doesn't exist in the simulator, so weather is unavailable there. There's an image container (20–288 × 20–144) that isn't used yet. Apps can be launched from the glasses' own menu. There's **no** way to replace the native dashboard.
- **Simulator:**
  - Run with `npm run sim`, or `npx evenhub-simulator "http://localhost:5173/" --automation-port 9898`.
  - Automation API: `GET /api/ping`, `GET /api/screenshot/glasses` (also `/webview`), `POST /api/input {"action":"up|down|click|double_click|long_press|long_press_release"}`, and `GET/DELETE /api/console`.
  - Timers are throttled in the simulator ("ShadowTimers") when its window isn't visible. Test timing in the browser preview instead.
  - `?demo` uses sample data; `?alerttest` shows the last day's alerts once.
- **Native notifications:** turn on Auto Display in the Even app (Settings → Notifications), and set iPhone Show Previews to Always.

## 6. How to change and ship

```bash
npm run dev           # Vite on :5173, proxies /api to the Worker with the token from .dev.vars
npm run sim           # simulator
npx tsc --noEmit      # type-check app + worker
npx wrangler deploy   # deploy the server (takes about 20–40 s to propagate)
npx wrangler secret bulk <file.json>     # upload secrets (temp file, delete after)
npx wrangler kv key delete --binding TOKENS --remote "<key>"   # clear a cache (news:top10, inbox:cache, markets, whoop:today, whoop:tip3:*)
```

**Shipping a new glasses version:**
1. Bump `"version"` in `app.json`.
2. Run `npm run pack` to build `claude-dash.ehpk`.
3. Check that the APP_TOKEN is **not** in `dist/`.
4. `npx evenhub upload claude-dash.ehpk -m "<changelog>"`
5. `npx evenhub promote <version> --to beta --package-id com.personal.claudedash`
6. Ali updates or reinstalls in the Even app.

`evenhub login` asks for a password in an interactive terminal; Ali logs in himself.

**Version history:**
- 0.1.0: first install.
- 0.2.0: Today with 3 pages, °F, auto-sleep, removed Tasks and Focus.
- 0.3.0: WHOOP tip, inbox advice, 8 news stories with summaries, Reminders day plan, removed Home and Teleprompter, fully blank sleep.
- 0.4.0: email alerts, bedtime, News card with markets and 10 stories, REMINDERS + TODAY'S FOCUS.
- 0.5.0: clean header and footer.
- 0.6.0: **Tiles design**.
- 0.7.0: Ask Claude, hold = display off, double tap on Day plan = new plan, inbox names.
- 0.8.0: inbox "Name: reason", Ask web search + read aloud, gym last-time numbers, day plan refreshes every 2 hours.
- 0.9.0 (built Nov 24, not shipped yet): gym voice edits ("cancel that", "delete my second bench set", "that was 10 reps"), exercise name merging (`src/exercises.ts`), rest by lift type (heavy 2:30 / compound 2:00 / isolation 1:00, +0:30 yellow, +1:00 red), "workout complete" summary (volume vs last, PRs, sets, WHOOP strain, best set per exercise vs last time), no "first time" text; after each set a "next: 145x8 (add 5 lb)" tip (double progression: heavy 5-8, compound 8-12, isolation 10-15 reps; +10 lb big lower-body lifts, +5 lb others); summary fits one page (◆ lifts that beat last time, then "Matched last time / Below last time / No history yet" groups). The logger also answers questions ("what was my last bench?") with last session's sets and a "start at" weight. Ask: read-aloud removed, tap on last page = follow-up with context (last 6 kept), double tap = new chat. Settings v11.
- News (also v0.9.0): 3 world stories first (BBC World, NPR World), then Morning Brew / Tech Brew. The app polls every 15 min; the server re-checks feeds at most every 15 min (cache `news:top10:v2`) and only calls Claude when the feed titles changed. World-story summaries read the article page because those feeds only carry teasers.
- 0.10.0: Listen card (Ali's choices: 2 minutes back, quick explainer, keeps listening after an answer, no read-aloud). Footer dots widened for 7 cards. Settings v12.
- 0.11.0: faster Listen: background transcription every 30 s, silence dropped, raw audio instead of base64, streamed answer (topic first).
- 0.12.0 (Nov 26): speed. Worker returns saved copies at once and refreshes in the background (`worker/cache.ts`, keys `inbox:v2`, `whoop:today:v2`, `markets:v2`); a 15-minute cron (`scheduled` in `worker/index.ts`, `triggers` in `wrangler.jsonc`) rebuilds inbox, news, WHOOP and markets, and the inbox only re-asks Claude when the threads changed (SHA-1 signature). Ask streams: multipart in (raw audio), reply is `QUESTION: ...\n` then text, `\x1e` = drop the text before a lookup. Gym also sends raw audio (multipart; JSON still accepted). Streams send `Content-Encoding: identity` (gzip held Listen/Ask text until the end). Email alerts and the WHOOP tip use `claude-haiku-5-5` (about 1 s faster, measured); gym and everything else stay on Opus. Phone saves the last screens (`claude-dash-snapshot`) and shows them at launch, with "updated h:mm" in the footer when over 5 minutes old; the day plan isn't remade at launch if under 2 hours old. Redraws only swap changed text unless the layout changed or more than 3 boxes changed. Listen dots are smaller and animate (one bright dot steps every 0.5 s). Ali chose to keep background polling while asleep as it was.
- 0.13.0: Listen answers first and searches after ("> LATEST" line), 10-second background chunks, 2 s max wait at tap.
- 0.15.0 (Nov 27): "Glyph mix". Small drawn pictures (Glyph, MIT, see THIRD_PARTY_NOTICES.md) in image containers, made in `src/widgets.ts` and sent as PNGs like the posture cat. Each picture has a `key`; it's only resent when the key changes, one send at a time, newer wishes replace older ones (in-flight = skip). Today page 2: recovery ring + zone + note (tip shortened to ~26 chars, cache `whoop:tip4`). News: sparklines at the right of each market tile, BTC shown as `$97.2k  -1.8%`. Inbox: wait time column (2h/5h/1d/3d), title `INBOX · 4 accounts`. Ask tool `dismiss_inbox_item` (KV `inbox:dismissed`, thread id + newest message time; comes back when a newer message arrives; Gmail untouched); the stream ends with `\x1f` and the glasses reload Inbox. Gym rest: countdown ring (1 s, or every 2-5 s with the exact time as text if image sends get slow, `tickStep()`), set + last time top right. Listen: still mic picture, no dot animation. New email: a 288x144 box over the current card (tap = full reader); in the simulator the picture hides the text under it (`BLANK_UNDER_COVER` in layout.ts can blank tiles if the glasses don't). Day plan card replaced by Reminders (settings v14 migrates `brief` → `reminders`; hidden when nothing was sent today). Menu "New day plan" became "Refresh everything". Posture cat calmer (bigger tilt, 45 s / 2 min, 10 min quiet after). Image sends took 3-6 ms in the simulator (no Bluetooth); real-glasses timing not measured yet. Dev hooks: `?gymrest`, `?alertdemo`, `?card=<id>`.
- 0.14.0: Ask Claude card removed; a left-arm tap opens Ask over any card (`st.askOpen`). Settings v13 drops "ask" from saved card lists. Built together with the posture cat.
- Testing hooks (dev only): `?savedtest` shows the "updated" footer; `?listentest=<transcript>` shows a Listen answer, `?listentest=dots` the listening screen; `LOCAL_API=1 npm run dev` uses the local Worker; `?gymseed` loads sample history, `?gymtest=a|b` runs typed gym commands, `?asktest=q1|q2` asks typed questions in one chat (opens the Ask overlay).

## 7. Known limits and gotchas

- WHOOP's API has **no coaching text**, so the tip is written by Claude from the numbers.
- The display is monochrome green, so colors appear as words (YELLOW).
- Smart alerts only work while Claude Dash is open (including when asleep). Texts and iMessage can only come through Even's native notifications. The SDK can't read phone notifications.
- Cloudflare free plan limits each request to about 50 outbound requests. That's why Gmail uses batch requests, and Ask caps email searches at 2.
- Google OAuth sign-in doesn't work inside the Even app's WebView. Use the Mac browser.
- Reading answers aloud while the phone is locked is untested.
- The simulator's fetch wrapper waits for the whole reply, so streaming (Ask, Listen) looks all-at-once there. Check streaming in a normal browser with `?asktest=`.
- The gym "last time" comparison is untested on real data.

## 8. Ideas Ali hasn't chosen yet

Meeting prep (5 minutes before), investor pipeline, Content/Reels (filming list + IG/TikTok stats), Echonos pulse (signups, revenue, generations), Tomorrow (after 6 PM), Slack (unread DMs and mentions), Linear sprint.

For the Today schedule, he gave no preference on: a meeting prep line, tomorrow's preview, call vs in person, and a 5-minute countdown.

For Ask, he didn't pick: drafting email replies (would need wider Gmail access) and adding Reminders by voice.

He wants the **News card and alert rules unchanged**.
