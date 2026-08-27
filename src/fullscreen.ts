/**
 * Fullscreen + screen-wake-lock helper.
 *
 * Why this exists (mobile UX):
 *  - Going fullscreen hides the browser chrome (URL bar / nav bar), which on
 *    phones reclaims ~10-15% of vertical space and removes accidental
 *    "pull down to refresh" / back-swipe gestures fighting the touch
 *    controls.
 *  - We also try to lock orientation to landscape once fullscreen, since
 *    that's how this game is meant to be played on a phone.
 *  - A Screen Wake Lock keeps the display from dimming/sleeping mid-race,
 *    since a game session is pure touch input with no scrolling/typing to
 *    reset the phone's idle timer.
 *
 * Cross-browser reality check:
 *  - Fullscreen API is vendor-prefixed on older Safari and Firefox.
 *  - iOS Safari only supports element.requestFullscreen() from iOS 16.4+.
 *    Older iOS Safari has no fullscreen API for regular web content at all
 *    (only <video>). We detect that and quietly disable the button rather
 *    than showing something that silently does nothing.
 *  - Wake Lock API is unsupported on iOS Safari entirely (as of this
 *    writing) and on some older Android WebViews - every call is wrapped so
 *    its absence never breaks anything else.
 */

type FSDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  mozFullScreenElement?: Element | null;
  mozCancelFullScreen?: () => Promise<void> | void;
  msFullscreenElement?: Element | null;
  msExitFullscreen?: () => Promise<void> | void;
};

type FSElem = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  mozRequestFullScreen?: () => Promise<void> | void;
  msRequestFullscreen?: () => Promise<void> | void;
};

function getFullscreenElement(): Element | null {
  const d = document as FSDoc;
  return (
    document.fullscreenElement ||
    d.webkitFullscreenElement ||
    d.mozFullScreenElement ||
    d.msFullscreenElement ||
    null
  );
}

function isFullscreenSupported(): boolean {
  const el = document.documentElement as FSElem;
  const d = document as FSDoc;
  return !!(
    el.requestFullscreen ||
    el.webkitRequestFullscreen ||
    el.mozRequestFullScreen ||
    el.msRequestFullscreen ||
    document.fullscreenEnabled ||
    (d as any).webkitFullscreenEnabled
  );
}

async function enterFullscreen() {
  const el = document.documentElement as FSElem;
  try {
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    else if (el.mozRequestFullScreen) await el.mozRequestFullScreen();
    else if (el.msRequestFullscreen) await el.msRequestFullscreen();
  } catch {
    // User gesture requirements / permission denials land here - safe to ignore.
  }

  // Best-effort landscape lock; unsupported on iOS Safari and desktop, and
  // some Android browsers refuse it outside a "standalone" installed app -
  // all of that is fine, the game already works in portrait too.
  const orientation = screen.orientation as ScreenOrientation & {
    lock?: (o: string) => Promise<void>;
  };
  orientation?.lock?.("landscape").catch(() => {});
}

async function exitFullscreen() {
  const d = document as FSDoc;
  try {
    if (document.exitFullscreen) await document.exitFullscreen();
    else if (d.webkitExitFullscreen) await d.webkitExitFullscreen();
    else if (d.mozCancelFullScreen) await d.mozCancelFullScreen();
    else if (d.msExitFullscreen) await d.msExitFullscreen();
  } catch {
    // ignore
  }
  const orientation = screen.orientation as ScreenOrientation & {
    unlock?: () => void;
  };
  orientation?.unlock?.();
}

/** Screen Wake Lock: keeps the display awake while playing. */
class WakeLockManager {
  private sentinel: any = null;

  async request() {
    const nav = navigator as Navigator & { wakeLock?: any };
    if (!nav.wakeLock) return;
    try {
      this.sentinel = await nav.wakeLock.request("screen");
      this.sentinel.addEventListener?.("release", () => {
        this.sentinel = null;
      });
    } catch {
      // Denied (e.g. low battery mode) - not critical, ignore.
    }
  }

  async release() {
    try {
      await this.sentinel?.release?.();
    } catch {
      // ignore
    }
    this.sentinel = null;
  }

  /** Re-acquire after the tab regains visibility (the OS auto-releases it on hide). */
  handleVisibilityChange() {
    if (document.visibilityState === "visible" && this.sentinel === null) {
      this.request();
    }
  }
}

const ICON_EXPAND = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H4a1 1 0 0 0-1 1v4"/><path d="M16 3h4a1 1 0 0 1 1 1v4"/><path d="M21 16v4a1 1 0 0 1-1 1h-4"/><path d="M3 16v4a1 1 0 0 0 1 1h4"/></svg>`;
const ICON_COLLAPSE = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v4a1 1 0 0 1-1 1H4"/><path d="M15 3v4a1 1 0 0 0 1 1h4"/><path d="M9 21v-4a1 1 0 0 0-1-1H4"/><path d="M15 21v-4a1 1 0 0 1 1-1h4"/></svg>`;

/**
 * Wires up the #btn-fullscreen button. Call once at startup.
 * Toggling fullscreen also toggles the wake lock, since "fullscreen" is the
 * clearest signal the player is actively racing rather than glancing at the
 * page.
 */
export function setupFullscreen() {
  const btn = document.getElementById("btn-fullscreen");
  if (!btn) return;

  if (!isFullscreenSupported()) {
    // Old iOS Safari etc: no working fullscreen API for web content. Rather
    // than show a button that does nothing, hide it - the viewport meta tag
    // + standalone home-screen install already covers that audience.
    btn.style.display = "none";
    return;
  }

  const wakeLock = new WakeLockManager();

  const syncIcon = () => {
    const active = !!getFullscreenElement();
    btn.innerHTML = active ? ICON_COLLAPSE : ICON_EXPAND;
    btn.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen");
    btn.classList.toggle("active", active);
  };

  const toggle = async (e: Event) => {
    e.preventDefault();
    if (getFullscreenElement()) {
      await exitFullscreen();
      await wakeLock.release();
    } else {
      await enterFullscreen();
      await wakeLock.request();
    }
  };

  btn.addEventListener("click", toggle);
  btn.addEventListener("touchend", toggle, { passive: false });

  ["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"].forEach(
    (evt) => document.addEventListener(evt, syncIcon)
  );

  document.addEventListener("visibilitychange", () => wakeLock.handleVisibilityChange());

  syncIcon();
}
