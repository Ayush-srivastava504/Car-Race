# CF Car Race

CF Car Race is a browser-based 3D time-trial game built with Three.js,
Cannon-es, TypeScript, Vite, and Cloudflare Workers. Drive a low-poly car
around a procedurally generated closed circuit, complete three laps, and beat
your personal best.

The game is deliberately client-heavy: rendering, physics, input, timing, and
race rules run in the browser. Cloudflare serves the compiled static site and
provides an optional, stateless best-lap API backed by Workers KV.

> Current status: playable MVP. The car and track are generated from geometry
> in TypeScript. `public/models/` exists for future model assets, but the current
> build does not require external glTF files.

## Features

- Three-lap time trials with an automatic countdown (`3`, `2`, `1`, `GO!`).
- Eight sequential checkpoints prevent simply cutting across the circuit.
- Local best-lap persistence using `localStorage`.
- Third-person chase camera with speed-sensitive field of view.
- Cannon-es raycast vehicle physics with rear-wheel drive, suspension,
  steering, braking, and handbrake behavior.
- Procedural road ribbon, physical road segments, barriers, start/finish line,
  grass, fog, and instanced trees.
- Off-track grip and engine penalties, wrong-way warnings, and automatic
  recovery when the car is airborne, fallen, or stuck.
- Keyboard controls on desktop and pointer-based touch controls on phones and
  tablets.
- Fullscreen mode with wake lock where the browser supports those APIs.
- Optional top-50 global leaderboard using a Cloudflare Worker and KV.
- Mobile rendering adjustments: reduced pixel ratio and disabled shadows to
  protect frame rate on touch devices.
- Built-in race diagnostics for investigating physics and input issues.

## Play

### Desktop controls

| Action | Keys |
| --- | --- |
| Accelerate | `W` or `Arrow Up` |
| Reverse / brake | `S` or `Arrow Down` |
| Steer left | `A` or `Arrow Left` |
| Steer right | `D` or `Arrow Right` |
| Handbrake | `Space` |
| Reset and restart countdown | `R` |
| Toggle race debugger | `T` or `D` |

The reset icon is also available in the top-right corner. The fullscreen icon
appears only when the browser exposes a compatible fullscreen API.

### Touch controls

On touch-capable devices, the game shows on-screen buttons for left, right,
gas, brake, and handbrake. Hold a button to keep the action active. Touch and
keyboard input share the same internal input state, so a device can support
both input sources without one releasing the other accidentally.

### Race behavior

The timer starts after the countdown finishes. Passing checkpoints in order
advances the lap, and completing lap three ends the run. A new personal best is
stored locally and submitted to the optional leaderboard API. The race restarts
automatically after the finish message.

Leaving the paved ribbon displays `OFF TRACK` and reduces tire grip and engine
authority. Driving quickly against the computed centerline direction displays
`WRONG WAY`. If the vehicle loses ground contact or remains nearly stationary
while the player is trying to drive, it is returned to the start line after a
short recovery delay.

## Requirements

- Node.js 18 or newer is recommended for the Vite and Wrangler toolchain.
- A modern browser with WebGL support.
- npm, or another package manager that can install the dependencies from
  `package.json`.

The game itself has no account system and does not require a server for local
play. A browser with `localStorage` disabled will lose its best time between
loads.

## Local development

Install dependencies and start Vite:

```bash
npm install
npm run dev
```

Open the URL printed by Vite. The configured default is
`http://localhost:5173`.

### Production preview

Build the client and serve the generated `dist/` directory through Vite's
preview server:

```bash
npm run build
npm run preview
```

`npm run build` runs both TypeScript project checks and `vite build`. The
generated output is written to `dist/`.

### Running the Worker locally

`npm run dev` runs pure Vite. It does not run the Worker runtime, so requests
to `/api/leaderboard` are unavailable in that mode. The client intentionally
handles this gracefully: leaderboard requests fail silently and local best
times continue to work.

To run Wrangler's Worker development server instead:

```bash
npm run worker:dev
```

Wrangler uses `wrangler.toml`, including the configured preview KV namespace.
The exact local URL is printed by Wrangler. For a browser session to use the
API and static assets together, use the deployed environment or configure a
local proxy that routes the Vite client to the Worker; Vite itself does not
automatically emulate Worker bindings.

## Deploy to Cloudflare Workers

The project is configured as one Worker deployment with static assets. The
`assets` binding serves the contents of `dist/`, while the Worker handles
`/api/*` requests.

1. Authenticate Wrangler:

   ```bash
   npx wrangler login
   ```

2. Confirm the `name`, `main`, and asset settings in `wrangler.toml`.

3. Build and deploy:

   ```bash
   npm run deploy
   ```

   This is equivalent to:

   ```bash
   npm run build
   npx wrangler deploy
   ```

The deployed site does not need a Pages project. `wrangler.toml` uses the
Worker's static asset binding and SPA fallback for non-API requests.

### Configure leaderboard KV

The repository currently contains production and preview KV IDs in
`wrangler.toml`. If deploying to a different Cloudflare account, create new
namespaces and replace those values:

```bash
npx wrangler kv namespace create LEADERBOARD
npx wrangler kv namespace create LEADERBOARD --preview
```

Copy the returned IDs into the `id` and `preview_id` fields of the
`[[kv_namespaces]]` block. The binding name must remain `LEADERBOARD`, because
both `worker/worker.ts` and `wrangler.toml` depend on it.

If KV is not configured, the client still runs as an offline time trial. The
optional leaderboard calls catch network failures and do not block gameplay.

## Leaderboard API

The API is implemented in `worker/worker.ts` and uses one KV key,
`leaderboard:top`. Entries are sorted by ascending `timeMs` and trimmed to the
best 50 records.

### Read scores

```http
GET /api/leaderboard?limit=10
```

The `limit` is clamped to the top 50 entries. A successful response is an array:

```json
[
  {
    "name": "Player",
    "timeMs": 92345.25,
    "createdAt": 1727000000000
  }
]
```

### Submit a score

```http
POST /api/leaderboard
Content-Type: application/json

{"name":"Player","timeMs":92345.25}
```

Names are converted to strings and truncated to 24 characters. Times must be
finite, greater than zero, and no more than 30 minutes. A valid submission
returns:

```json
{"ok":true}
```

Invalid JSON or invalid times return a `400` response. Unknown `/api/*` paths
return `404`. CORS is open with `Access-Control-Allow-Origin: *`, and OPTIONS
requests are supported.

The current client submits only when a new local best is achieved. There is no
authentication, anti-cheat validation, duplicate-name handling, or ranked UI
in the current MVP, so the API should be treated as a casual scoreboard rather
than a trusted competition service.

## Architecture

```text
Browser
  main.ts
    Three.js scene and renderer
    Cannon-es world and fixed-step vehicle simulation
    race state, checkpoints, timing, camera, and recovery
  car.ts        raycast vehicle and visual car mesh
  track.ts      procedural geometry and collision bodies
  input.ts      keyboard and pointer/touch input
  hud.ts        DOM HUD updates and time formatting
  fullscreen.ts fullscreen and wake-lock integration
  leaderboard.ts optional /api/leaderboard client
  debugger.ts   toggleable physics/input diagnostics

Cloudflare Worker
  static assets from dist/ via the ASSETS binding
  /api/leaderboard via worker.ts and Workers KV
```

### Simulation details

- The track is generated from closed Catmull-Rom waypoints and sampled into a
  smooth centerline.
- The visible road is a Three.js ribbon. Matching overlapping static Cannon
  boxes provide the physical road surface.
- Barrier visuals are instanced for fewer draw calls. Dense static collision
  chains follow both road edges.
- Cannon's `RaycastVehicle` uses four wheels, front-wheel steering, and rear
  engine force. The chassis permits yaw but constrains pitch and roll to keep
  the vehicle stable on the generated surface.
- The render loop advances physics with a fixed `1 / 60` simulation step and
  caps frame delta to avoid large catch-up steps.
- When the document is hidden, elapsed race time is paused and the animation
  loop does not attempt to catch up after the tab becomes visible.

## Project structure

```text
.
├── index.html             HTML shell, HUD markup, touch controls, and CSS
├── package.json           npm scripts and dependencies
├── tsconfig.json          client TypeScript configuration
├── vite.config.ts         Vite root, asset directory, and build settings
├── wrangler.toml          Worker, static assets, and KV configuration
├── public/
│   └── models/            reserved for future car/track model assets
├── src/
│   ├── main.ts            scene setup, race state, loop, and camera
│   ├── car.ts             vehicle physics and car mesh
│   ├── track.ts           procedural track and collision geometry
│   ├── input.ts           keyboard and touch input abstraction
│   ├── hud.ts             speed, lap, timing, and status messages
│   ├── leaderboard.ts     optional Worker API client
│   ├── fullscreen.ts      fullscreen and wake lock behavior
│   ├── deviceInfo.ts      shared device capability detection
│   └── debugger.ts        runtime race diagnostics
└── worker/
    ├── worker.ts          static-asset fallback and leaderboard API
    └── tsconfig.json      Cloudflare Worker TypeScript configuration
```

## npm scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server on port 5173. |
| `npm run build` | Type-check the client and produce `dist/`. |
| `npm run preview` | Preview the built client locally with Vite. |
| `npm run worker:dev` | Start Wrangler's local Worker development server. |
| `npm run deploy` | Build the client and deploy the Worker with Wrangler. |

## Debugging

Press `T` or `D` during play to toggle the race debugger. It reports race
state, active inputs, speed, velocity, position, wheel-ground contact,
off-track status, sleeping state, and the stuck-recovery timer.

Useful browser diagnostics include the console warning emitted when all wheel
raycasts lose ground contact and the browser Performance panel for frame-time
and draw-call investigation.

## Performance and compatibility

The target is approximately 60 FPS on mid-range laptops and phones. The
mobile path caps device pixel ratio at 1.5 and disables shadows; desktop uses
up to a 2.0 pixel ratio and directional-light shadows. Barriers and trees use
instanced meshes to keep scenery inexpensive.

When adding art or effects:

- Keep models low-poly and textures small.
- Profile on a representative phone, not only a desktop GPU.
- Avoid adding per-frame allocations to the simulation loop.
- Keep the visual road and physical road geometry aligned.
- Test both keyboard and multi-pointer touch input after input changes.

Fullscreen and wake lock are progressive enhancements. Unsupported browsers
hide the fullscreen control and remain playable in the normal viewport.

## Known limitations and roadmap

These are not part of the current MVP:

- Real car and track glTF models loaded through `GLTFLoader`.
- Ghost replay of a best lap.
- A ranked leaderboard screen in the game UI.
- Multiplayer or peer-to-peer racing.
- Post-processing such as bloom or motion blur.
- Authenticated or anti-cheat-protected score submissions.

If leaderboard traffic grows beyond KV's write pattern, move score storage to
Cloudflare D1 or another database that supports proper ranked queries. Keep
the Worker request-scoped and out of the real-time simulation path unless the
game architecture changes intentionally.

## Cloudflare free-plan considerations

Cloudflare limits change over time. Check the current
[Workers limits documentation](https://developers.cloudflare.com/workers/platform/limits/)
before relying on a quota. This design keeps the expensive real-time work in
the browser; the Worker only performs small JSON and KV operations.

The relevant current design constraints are:

- KV stores one small JSON blob containing at most 50 entries.
- Every leaderboard read consumes a KV read.
- Every accepted score consumes a KV write.
- Static files are deployed from `dist/` through the asset binding.
- The API is not authoritative: clients can fabricate score submissions.

## Contributing

1. Install dependencies with `npm install`.
2. Make a focused change in `src/` or `worker/`.
3. Run `npm run build` before opening a change.
4. Test a complete three-lap run, reset behavior, off-track behavior, and the
   relevant desktop or touch controls.
5. For deployment changes, test both `npm run build` and `npm run worker:dev`.

Keep generated output such as `dist/` out of source changes unless the
deployment workflow explicitly requires it. No license file is currently
declared in this repository.
