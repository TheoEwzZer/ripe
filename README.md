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
npm run probe -- --steps perceive,segment,cook,plate
```

`/lab` shows the newest recording as a freshness map.

## Layout

- `app/[lang]/` — routes, EN default with FR toggle (`proxy.ts` picks the locale)
- `convex/` — schema (sessions, scans, ingredients, masks, recipeRuns, recipes) and functions
- `lib/meta/` — Meta Model API calls: `perceive` (muse-spark-1.3), `segment` (sam-3.1), `cook` (muse-wonder-1.0), `plate` (muse-image-1.0), budget guard
- `lib/pantry/` — Zod schemas and freshness rules
- `lib/replay/` — recordings and replay
- `brand/` — logo files

Test photos in `public/fixtures/photos/` are CC0 / public domain; see `CREDITS.md` there.
