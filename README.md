# CF Car Race

A browser-based 3D time-trial car racing game (Three.js + cannon-es),
architected to run entirely on the **Cloudflare Workers free plan**.

- All rendering, physics, and game logic run **client-side** in the browser.
- The Worker's only jobs: serve the static build, and optionally run a tiny
  stateless leaderboard API (Workers KV) — no live game state on the server,
  no Durable Objects, no persistent process.

Current state: a drivable box-car placeholder on a procedurally generated
closed-loop circuit, with checkpoints, lap timing, best-lap tracking
(localStorage), a chase camera, barriers, and basic scenery. This is the
MVP scaffold described in the build prompt — swap in real glTF models and
tune physics from here.

## Project layout

```
├── src/                # Browser app (Vite + TS + Three.js + cannon-es)
│   ├── main.ts          # Scene/camera/physics setup, game loop
│   ├── car.ts            # Vehicle: RaycastVehicle physics + placeholder mesh
│   ├── track.ts           # Procedural track ribbon, barriers, checkpoints
│   ├── input.ts             # Keyboard input state
│   ├── hud.ts                 # DOM HUD bindings (speed/lap/time)
│   └── leaderboard.ts           # Client for the optional Worker API
├── worker/
│   ├── worker.ts        # Stateless Worker: /api/leaderboard (GET/POST) via KV
│   └── tsconfig.json    # Separate TS config (Workers runtime types)
├── index.html            # HTML shell + HUD overlay markup/CSS
├── wrangler.toml         # Static assets + Worker + KV binding config
└── vite.config.ts
```

## Local development

```bash
npm install
npm run dev
```

Open the printed local URL (default `http://localhost:5173`). Controls:
**WASD / Arrow keys** to drive, **Space** to handbrake, **R** to reset to
the start line.

The leaderboard API isn't available under `npm run dev` (that's pure Vite,
no Worker runtime) — `submitScore`/`fetchLeaderboard` fail silently and the
game keeps using `localStorage` for your best lap. To test the API locally,
run the Worker separately:

```bash
npm run worker:dev   # runs `wrangler dev`, serves the Worker on its own port
```

## Deploying to Cloudflare (free plan)

1. **Install Wrangler & log in** (already a devDependency, so `npx` finds it):
   ```bash
   npx wrangler login
   ```
2. **(Optional) Create the KV namespace for the leaderboard**, if you want
   scores to sync beyond `localStorage`:
   ```bash
   npx wrangler kv namespace create LEADERBOARD
   ```
   This prints an `id`. Paste it into `wrangler.toml` under
   `[[kv_namespaces]]` → `id = "..."`. For local `wrangler dev` testing,
   also create a preview namespace:
   ```bash
   npx wrangler kv namespace create LEADERBOARD --preview
   ```
   and paste that into `preview_id`. If you skip this step entirely, the
   game still works — it just won't sync a global leaderboard.
3. **Build the static site:**
   ```bash
   npm run build
   ```
   This runs `tsc -b` then `vite build`, producing `dist/`.
4. **Deploy:**
   ```bash
   npx wrangler deploy
   ```
   Wrangler reads `wrangler.toml`: it uploads `dist/` as static assets
   (served at the edge, no Worker invocation needed for `/`, JS/CSS/glTF
   files, etc.) and deploys `worker/worker.ts` to handle `/api/*`.

Or use the combined helper: `npm run deploy` (build + deploy in one step).

## Free-plan limits that apply here

Cloudflare's limits can change — check
[developers.cloudflare.com/workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/)
before you rely on exact numbers — but as of this writing, on the Workers
Free plan:

| Resource | Free-tier limit | Relevance here |
|---|---|---|
| Worker requests | 100,000/day (account-wide) | Only `/api/leaderboard` calls hit this — static asset requests are served from Cloudflare's edge cache and aren't counted the same way. A casual leaderboard won't come close. |
| Worker CPU time | 10ms per request | Fine for parsing a small JSON body and doing one KV read/write. **Not** enough for a server-authoritative game loop — this is exactly why all physics/rendering stays client-side. |
| Workers KV reads | 100,000/day | Every `GET /api/leaderboard` is one read. |
| Workers KV writes | 1,000/day | Every lap submission (`POST /api/leaderboard`) is one write. This is the tightest limit — if the game gets popular, ~1,000 best-lap submissions/day is the ceiling before you'd need to batch writes, add client-side throttling (e.g. only submit if it beats your previous best), or move to D1/a paid plan. |
| Workers KV storage | 1 GB total | The whole leaderboard is one small JSON blob (top 50 entries) — effectively unlimited for this use case. |
| Static asset payload | Practically large, but slow to load if bloated | Keep glTF/texture sizes modest for fast first paint, especially on mobile — see "Performance" below. |

If you outgrow KV's write quota, swap `worker/worker.ts` to use **D1**
(Cloudflare's serverless SQLite, also free-tier eligible) for proper
ranked queries — the Worker stays just as stateless either way.

## What's next (stretch goals, not yet implemented)

- Replace the box placeholder and geometry track with real low-poly glTF
  models (car + track), loaded via `GLTFLoader`.
- Ghost replay of your best lap (record a transform buffer, play it back
  as a semi-transparent car).
- Ranked global leaderboard UI reading from `/api/leaderboard`.
- WebRTC peer-to-peer racing (no server authority — matches the
  free-plan-friendly architecture).
- Post-processing (bloom/motion blur) — only if frame rate holds up on
  mid-range hardware; profile before adding.

## Performance notes

- Target 60fps on mid-range laptops/phones. Profile with the browser's
  performance panel early — the current scaffold uses instanced meshes
  for barriers/trees specifically to keep draw calls low as you add more
  scenery.
- Keep future glTF assets low-poly and texture-light; large payloads hurt
  first-load time more than they hurt Cloudflare's static-asset limits
  (which are generous), so treat this as a UX concern, not just a quota one.
