function formatTime(ms: number): string {
  if (!isFinite(ms) || ms < 0) return "--:--.---";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msPart = Math.floor(ms % 1000);
  return `${m}:${s.toString().padStart(2, "0")}.${msPart.toString().padStart(3, "0")}`;
}

export class Hud {
  private lapEl = document.getElementById("lap")!;
  private timeEl = document.getElementById("time")!;
  private bestEl = document.getElementById("best")!;
  private speedEl = document.getElementById("speed")!;
  private msgEl = document.getElementById("msg")!;
  private loadingEl = document.getElementById("loading")!;
  private boostFillEl = document.getElementById("boost-fill")!;
  private boostWrapEl = document.getElementById("boost")!;

  hideLoading() {
    this.loadingEl.style.display = "none";
  }

  update(lap: number, totalLaps: number, elapsedMs: number, bestMs: number | null, speedKmh: number) {
    this.lapEl.textContent = `${Math.min(lap, totalLaps)} / ${totalLaps}`;
    this.timeEl.textContent = formatTime(elapsedMs);
    this.bestEl.textContent = bestMs !== null ? formatTime(bestMs) : "--:--.---";
    this.speedEl.innerHTML = `${Math.round(speedKmh)}<span>km/h</span>`;
  }

  updateBoost(energyPct: number, active: boolean) {
    this.boostFillEl.style.width = `${Math.max(0, Math.min(1, energyPct)) * 100}%`;
    this.boostWrapEl.classList.toggle("active", active);
    this.boostWrapEl.classList.toggle("low", energyPct < 0.2 && !active);
  }

  showMessage(text: string, durationMs = 2500) {
    this.msgEl.textContent = text;
    this.msgEl.style.display = "block";
    if (durationMs > 0) {
      window.setTimeout(() => {
        this.msgEl.style.display = "none";
      }, durationMs);
    }
  }
}

export { formatTime };
