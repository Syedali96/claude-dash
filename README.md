# Claude Dash for Even G2

A custom dashboard for Even Realities G2 glasses with a Claude-written brief.
Built on the official Even Hub SDK (`@evenrealities/even_hub_sdk` 0.0.16).

## How it fits together

```
Glasses (display) ◀─BLE─▶ Even app on phone (runs this web page)
                                   │  /api/brief
                                   ▼
                      Vite dev server on your computer ──▶ Claude API
                      (holds ANTHROPIC_API_KEY)
```

- The phone screen shows a **settings page** with a live preview of the glasses.
- The glasses show four cards: **Home**, **Claude brief**, **Tasks** and **Focus timer**.

## Controls (R1 ring or temple touchpad)

| Gesture | Action |
|---|---|
| Swipe down / up | Next / previous card |
| Tap | The card's action: refresh, ask Claude, mark top task done, start/pause timer |
| Double tap | Go to Home |
| Long press | Jump to the Claude brief and refresh it |
| System menu | Refresh brief · Go home · Close |

## Setup

1. Add your API key (get one at https://console.anthropic.com):
   ```bash
   cp .env.example .env.local   # then paste your key after ANTHROPIC_API_KEY=
   ```
2. Start the dev server:
   ```bash
   npm run dev
   ```
3. Try it without the glasses in the official simulator:
   ```bash
   npm run sim
   ```
4. On real glasses: put your phone on the same Wi-Fi as your computer, turn on
   developer mode in the Even app, then scan the QR code from:
   ```bash
   npm run qr
   ```

## Where to change things

| You want to change | Edit |
|---|---|
| Card order, tasks, brightness, Claude prompt, 24h clock | The settings page on your phone (no code) |
| Screen layout: region sizes, borders, padding | `src/layout.ts` (`REGION`, 576×288 screen) |
| What each card shows and what tap does | `src/cards.ts` |
| Gesture mapping, refresh timing | `src/main.ts` (`handle`, `toGesture`) |
| Claude's style, length and model | `server/claude.ts` (`SYSTEM`, `model`, `effort`) |
| Phone settings page look | `index.html` |

Limits from the SDK: up to 12 containers per page and 8 text boxes, brightness
levels 0–4, about 999 bytes per text box, and one container that receives
gestures. The glasses font has no block characters such as `█`, so use plain
ASCII for bars.

## Notes

- **Weather** uses your phone's location and https://open-meteo.com (no key
  needed). The simulator doesn't provide location, so it shows "Weather unavailable".
- **The Claude brief needs the dev server running.** A packed `.ehpk`
  (`npm run pack`) has no server, so for an always-on build you'd host
  `server/claude.ts` somewhere (any small Node host) and point `/api/brief` at it.
  Don't put the API key in the page itself.
- Each brief is a single `claude-opus-5-5` call at low effort, so it costs a fraction of a cent.

## Credits

Drawn widgets use [Glyph](https://github.com/gabrielevierti/glyph) (MIT, (c) 2026 theboredprog). The posture cat comes from [Posture Cat](https://github.com/unicco/even-g2-posture) (MIT, (c) 2026 Kansai Takako). See THIRD_PARTY_NOTICES.md.
