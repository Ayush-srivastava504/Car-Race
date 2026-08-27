export class InputState {
  forward = false;
  backward = false;
  left = false;
  right = false;
  handbrake = false;
  reset = false;

  private keys = new Set<string>();

  constructor() {
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => this.keys.clear());
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const k = e.key.toLowerCase();
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) {
      e.preventDefault();
    }
    if (down) this.keys.add(k);
    else this.keys.delete(k);

    this.forward = this.keys.has("w") || this.keys.has("arrowup");
    this.backward = this.keys.has("s") || this.keys.has("arrowdown");
    this.left = this.keys.has("a") || this.keys.has("arrowleft");
    this.right = this.keys.has("d") || this.keys.has("arrowright");
    this.handbrake = this.keys.has(" ");
    this.reset = this.keys.has("r");
  }
}
