/**
 * InputState now exposes ANALOG values so the same field drives both
 * keyboard (digital, but eased) and touch (truly analog: joystick drag
 * distance, pedal press). This is the biggest lever for mobile feel —
 * binary steering feels awful on a touchscreen.
 *
 *   steer:    -1 (full left) .. 1 (full right)
 *   throttle:  0 .. 1
 *   brake:     0 .. 1
 *   handbrake: boolean (still digital, that's fine for a handbrake)
 */
export class InputState {
  steer = 0;
  throttle = 0;
  brake = 0;
  handbrake = false;
  reset = false;

  // Raw digital key state, eased toward -1/0/1 each frame for a less twitchy
  // keyboard feel that roughly matches touch responsiveness.
  private keys = new Set<string>();
  private steerTarget = 0;

  constructor() {
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.steerTarget = 0;
      this.throttle = 0;
      this.brake = 0;
      this.handbrake = false;
    });

    this.setupTouchControls();
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const k = e.key.toLowerCase();
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) {
      e.preventDefault();
    }
    if (down) this.keys.add(k);
    else this.keys.delete(k);

    const fwd = this.keys.has("w") || this.keys.has("arrowup");
    const back = this.keys.has("s") || this.keys.has("arrowdown");
    const left = this.keys.has("a") || this.keys.has("arrowleft");
    const right = this.keys.has("d") || this.keys.has("arrowright");

    this.throttle = fwd ? 1 : 0;
    this.brake = back ? 1 : 0;
    this.steerTarget = (left ? -1 : 0) + (right ? 1 : 0);
    this.handbrake = this.keys.has(" ");
    this.reset = this.keys.has("r");
  }

  /** Call once per frame from the game loop to smooth keyboard steering. */
  update(dt: number) {
    if (!this.touchSteerActive) {
      const rate = 6; // higher = snappier
      const diff = this.steerTarget - this.steer;
      const step = Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
      this.steer += step;
    }
  }

  private touchSteerActive = false;

  private setupTouchControls() {
    const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    const wrap = document.getElementById("touch-controls");
    if (!wrap) return;
    if (!isTouch) {
      wrap.style.display = "none";
      return;
    }
    wrap.style.display = "flex";

    // --- Steering joystick (left side) ---
    const stickBase = document.getElementById("stick-base") as HTMLElement;
    const stickKnob = document.getElementById("stick-knob") as HTMLElement;
    let stickTouchId: number | null = null;
    let baseRect: DOMRect;
    const maxRadius = 46;

    const stickStart = (id: number, x: number, y: number) => {
      stickTouchId = id;
      baseRect = stickBase.getBoundingClientRect();
      stickMove(x, y);
    };
    const stickMove = (x: number, y: number) => {
      const cx = baseRect.left + baseRect.width / 2;
      const cy = baseRect.top + baseRect.height / 2;
      let dx = x - cx;
      let dy = y - cy;
      const dist = Math.min(Math.sqrt(dx * dx + dy * dy), maxRadius);
      const angle = Math.atan2(dy, dx);
      dx = Math.cos(angle) * dist;
      dy = Math.sin(angle) * dist;
      stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.touchSteerActive = true;
      this.steer = Math.max(-1, Math.min(1, dx / maxRadius));
    };
    const stickEnd = () => {
      stickTouchId = null;
      stickKnob.style.transform = `translate(0px, 0px)`;
      this.touchSteerActive = true;
      this.steer = 0;
    };

    stickBase.addEventListener("touchstart", (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      stickStart(t.identifier, t.clientX, t.clientY);
    }, { passive: false });
    stickBase.addEventListener("touchmove", (e) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === stickTouchId) stickMove(t.clientX, t.clientY);
      }
    }, { passive: false });
    stickBase.addEventListener("touchend", (e) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === stickTouchId) stickEnd();
      }
    }, { passive: false });
    stickBase.addEventListener("touchcancel", (e) => {
      e.preventDefault();
      stickEnd();
    }, { passive: false });

    // --- Pedals + handbrake (right side) ---
    const bindHold = (elId: string, onDown: () => void, onUp: () => void) => {
      const el = document.getElementById(elId);
      if (!el) return;
      const down = (e: Event) => {
        e.preventDefault();
        el.classList.add("pressed");
        onDown();
      };
      const up = (e: Event) => {
        e.preventDefault();
        el.classList.remove("pressed");
        onUp();
      };
      el.addEventListener("touchstart", down, { passive: false });
      el.addEventListener("touchend", up, { passive: false });
      el.addEventListener("touchcancel", up, { passive: false });
      // Also support mouse for desktop testing of the touch UI.
      el.addEventListener("mousedown", down);
      window.addEventListener("mouseup", up);
    };

    bindHold("btn-gas", () => (this.throttle = 1), () => (this.throttle = 0));
    bindHold("btn-brake", () => (this.brake = 1), () => (this.brake = 0));
    bindHold("btn-handbrake", () => (this.handbrake = true), () => (this.handbrake = false));

    const resetBtn = document.getElementById("btn-reset");
    resetBtn?.addEventListener("touchstart", (e) => {
      e.preventDefault();
      this.reset = true;
      window.setTimeout(() => (this.reset = false), 100);
    }, { passive: false });
  }
}
