/**
 * Stateless Worker for CF Car Race.
 *
 * Responsibilities (both fine on the Workers FREE plan):
 *  1. Serve the built static site (handled automatically by the `assets`
 *     binding configured in wrangler.toml — no code needed for that part).
 *  2. A tiny JSON API for a best-lap leaderboard, backed by Workers KV.
 *     Every request is independent and stateless — nothing is held in
 *     memory between requests, so this fits the free plan's model
 *     (request-scoped execution, no persistent process, generous CPU
 *     budget for JSON-sized work).
 *
 * KV free tier (subject to change — verify current limits in the
 * Cloudflare dashboard before relying on them):
 *   - 100,000 reads/day
 *   - 1,000 writes/day
 *   - 1 GB total stored data
 * These are generous for a casual leaderboard but will need D1 or a paid
 * plan if the game gets serious traffic (e.g. > ~1,000 lap submissions/day).
 */

export interface Env {
  LEADERBOARD: KVNamespace;
}

interface Entry {
  name: string;
  timeMs: number;
  createdAt: number;
}

const LIST_KEY = "leaderboard:top";
const MAX_ENTRIES = 50;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function getEntries(env: Env): Promise<Entry[]> {
  const raw = await env.LEADERBOARD.get(LIST_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Entry[];
  } catch {
    return [];
  }
}

async function saveEntries(env: Env, entries: Entry[]): Promise<void> {
  const trimmed = entries.sort((a, b) => a.timeMs - b.timeMs).slice(0, MAX_ENTRIES);
  await env.LEADERBOARD.put(LIST_KEY, JSON.stringify(trimmed));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (url.pathname === "/api/leaderboard" && request.method === "GET") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10) || 10, MAX_ENTRIES);
      const entries = await getEntries(env);
      return json(entries.slice(0, limit));
    }

    if (url.pathname === "/api/leaderboard" && request.method === "POST") {
      let body: { name?: string; timeMs?: number };
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }

      const name = (body.name || "Player").toString().slice(0, 24);
      const timeMs = Number(body.timeMs);
      if (!isFinite(timeMs) || timeMs <= 0 || timeMs > 30 * 60 * 1000) {
        return json({ error: "invalid timeMs" }, 400);
      }

      const entries = await getEntries(env);
      entries.push({ name, timeMs, createdAt: Date.now() });
      await saveEntries(env, entries);
      return json({ ok: true });
    }

    // Anything else under /api is unknown.
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "not found" }, 404);
    }

    // Non-API requests fall through to static asset serving, which is
    // handled by the `assets` binding declared in wrangler.toml — this
    // code path is only reached if that binding isn't configured.
    return new Response("Not found", { status: 404 });
  },
};
