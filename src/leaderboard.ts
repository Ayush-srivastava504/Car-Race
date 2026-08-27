// Thin client for the optional stateless leaderboard API served by the
// Cloudflare Worker (src-worker/worker.ts). Fails silently if the API
// isn't deployed / reachable — the game works fully offline via localStorage.

const API_BASE = "/api";

export interface LeaderboardEntry {
  name: string;
  timeMs: number;
  createdAt: number;
}

export async function submitScore(name: string, timeMs: number): Promise<void> {
  try {
    await fetch(`${API_BASE}/leaderboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, timeMs }),
    });
  } catch {
    // Offline or API not deployed — ignore, local best time still works.
  }
}

export async function fetchLeaderboard(limit = 10): Promise<LeaderboardEntry[]> {
  try {
    const res = await fetch(`${API_BASE}/leaderboard?limit=${limit}`);
    if (!res.ok) return [];
    return (await res.json()) as LeaderboardEntry[];
  } catch {
    return [];
  }
}
