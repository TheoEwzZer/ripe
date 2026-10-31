# Ripe — Cook what's ripe

Snap your fridge. Ripe outlines every ingredient with SAM 3.1, reads how fresh it is with Muse Spark, and cooks what needs eating first with Muse Wonder. Built for the Meta Global AI Developer Hackathon (Indie Developer track).

## Run it

```bash
npm install
npm run dev          # Convex dev deployment + Next.js
```

Open the URL Next prints (`/en` or `/fr`). Without a Convex account, `CONVEX_AGENT_MODE=anonymous npm run dev` runs a local backend instead.

Production: Vercel runs `npx convex deploy --cmd 'npm run build'` when `CONVEX_DEPLOY_KEY` is set (see `vercel.json`).

## $0 by default

| Piece | Cost |
| --- | --- |
| Next.js, Tailwind, Motion | free |
| Convex, free plan (or local anonymous deployment) | free |
| Vercel, Hobby plan | free |
| Meta Model API | pay-as-you-go, **not called** unless `MODEL_API_KEY` is set |

Without a key, everything runs on **recordings** in `fixtures/recordings/`: raw model outputs replayed through the same parser as live calls.

```bash
npm run fixtures:mock    # rebuild the synthetic recording (hand-placed boxes, real SAM wire format)
npm run probe            # with a key: one real pass, capped by META_BUDGET_USD (default $0.25)
npm run probe -- --steps perceive        # stop after Muse Spark
npm run record:recipes -- --locale en --plates   # real recipes and plates for the demo photo
npm run record:recipes -- --locale fr --plan     # a real 3-day plan
npm run record:tips                              # storage tips for the demo photo
npm run probe:track -- --video clip.mp4 --width 960 --height 720 --boxes "x1,y1,x2,y2;…"   # one SAM video call
```

`/lab` shows the newest recording as a freshness map.

## Voice

Sentences are recorded in the browser (16 kHz WAV, stopped by silence) and transcribed by `muse-voice-transcribe-1.0` through Convex; Muse Spark turns them into inventory changes or recipe filters. Hands-free cooking prefers Meta's realtime transcription, which takes the API key in its first frame, so it goes through a relay: `app/api/listen` on Vercel (needs `MODEL_API_KEY` in the Vercel environment too). `next dev` cannot upgrade WebSockets, so locally:

```bash
npm run listen-relay                                         # ws://localhost:8790
NEXT_PUBLIC_LISTEN_URL=ws://localhost:8790 npm run dev:frontend
```

Without the relay, hands-free cooking falls back to one recorded clip per sentence.

## Reminders, impact and sharing

- Reminders are Web Push notifications sent by Convex (`convex/notify.ts`, `web-push`) the evening before food goes off; `public/sw.js` shows them. Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in the Convex environment (`npx web-push generate-vapid-keys`); without them the button stays hidden.
- The impact counter (`lib/impact.ts`) values saved food with ADEME's Agribalyse 3.2 carbon factors (via Impact CO2) and Ripe's indicative prices; the household page keeps 30 days under an anonymous id stored on the device.
- `app/api/story/…` draws a 1080×1920 story card of a recipe with `next/og`, no model involved.
- A filmed fridge: the first frame goes through the photo pipeline, then SAM 3.1 tracks the boxed items through the clip (`lib/meta/track.ts`, `convex/tracking.ts`).

## Layout

- `app/[lang]/` — routes, EN default with FR toggle (`proxy.ts` picks the locale)
- `convex/` — schema (sessions, devices, scans, ingredients, masks, recipeRuns, recipes, offers) and functions
- `lib/meta/` — Meta Model API calls: `perceive` (muse-spark-1.3), `segment` (sam-3.1), `cook` (muse-wonder-1.0), `plate` (muse-image-1.0), `voice` (muse-voice-transcribe-1.0), `dates` and `receipt` (muse-spark-1.3), budget guard
- `lib/voice/` — spoken commands, sentence interpretation, the realtime relay
- `lib/pantry/` — Zod schemas and freshness rules
- `lib/replay/` — recordings and replay
- `brand/` — logo files

Test photos in `public/fixtures/photos/` are CC0 / public domain; see `CREDITS.md` there.
