export const isTouchDevice =
  "ontouchstart" in window || navigator.maxTouchPoints > 0;

/**
 * Unified input state for keyboard AND touch. Touch buttons register
 * themselves via bindHoldButton() and simply set/clear the same boolean
 * flags keyboard does, so Car.update() never needs to know the source.
 */
export class InputState {
  forward = false;
  backward = false;
  left = false;
  right = false;
  handbrake = false;
  reset = false;

  private keys = new Set<string>();
  // Per-source flags so a touch button and a key can independently hold
  // the same action without one release cancelling the other.
  private touchForward = false;
  private touchBackward = false;
  private touchLeft = false;
  private touchRight = false;
  private touchHandbrake = false;

  constructor() {
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.recompute();
    });
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const k = e.key.toLowerCase();
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) {
      e.preventDefault();
    }
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    this.recompute();
  }

  private recompute() {
    this.reset = this.keys.has("r");
    this.forward = this.touchForward || this.keys.has("w") || this.keys.has("arrowup");
    this.backward = this.touchBackward || this.keys.has("s") || this.keys.has("arrowdown");
    this.left = this.touchLeft || this.keys.has("a") || this.keys.has("arrowleft");
    this.right = this.touchRight || this.keys.has("d") || this.keys.has("arrowright");
    this.handbrake = this.touchHandbrake || this.keys.has(" ");
  }

  /** Wire an on-screen button element to a "hold" action (gas/brake/steer/handbrake). */
  bindHoldButton(el: HTMLElement, setter: (v: boolean) => void) {
    const activePointers = new Set<number>();

    const start = (e: PointerEvent) => {
      e.preventDefault();
      activePointers.add(e.pointerId);
      el.setPointerCapture(e.pointerId);
      el.classList.add("active");
      setter(true);
      this.recompute();
    };
    const end = (e: PointerEvent) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size === 0) {
        el.classList.remove("active");
        setter(false);
        this.recompute();
      }
    };

    el.addEventListener("pointerdown", start, { passive: false });
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("lostpointercapture", end);
  }

  /** Wire a tap-only button (e.g. reset). */
  bindTapButton(el: HTMLElement, onTap: () => void) {
    el.addEventListener(
      "pointerdown",
      (e) => {
        e.preventDefault();
        el.classList.add("active");
        onTap();
      },
      { passive: false },
    );
    const clear = () => el.classList.remove("active");
    el.addEventListener("pointerup", clear);
    el.addEventListener("pointercancel", clear);
    el.addEventListener("lostpointercapture", clear);
  }

  setTouchForward(v: boolean) {
    this.touchForward = v;
  }
  setTouchBackward(v: boolean) {
    this.touchBackward = v;
  }
  setTouchLeft(v: boolean) {
    this.touchLeft = v;
  }
  setTouchRight(v: boolean) {
    this.touchRight = v;
  }
  setTouchHandbrake(v: boolean) {
    this.touchHandbrake = v;
  }
}
