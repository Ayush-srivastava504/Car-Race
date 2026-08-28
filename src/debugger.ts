import { Car } from "./car";
import { InputState } from "./input";

export class RaceDebugger {
  private readonly panel = document.getElementById("debug-panel");
  private visible = false;

  constructor() {
    document.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() === "t" || event.key.toLowerCase() === "d") {
        event.preventDefault();
        this.visible = !this.visible;
        if (this.panel) this.panel.style.display = this.visible ? "block" : "none";
      }
    });
  }

  update(car: Car, input: InputState, racing: boolean, offTrack: boolean, stuckMs: number) {
    if (!this.visible || !this.panel) return;

    const body = car.chassisBody;
    const velocity = body.velocity;
    const wheels = car.vehicle.wheelInfos;
    const groundedWheels = car.wheelGrounded();
    const grounded = groundedWheels.filter(Boolean).length;
    const activeInput = [
      input.forward && "W/GAS",
      input.backward && "S/BRAKE",
      input.left && "LEFT",
      input.right && "RIGHT",
      input.handbrake && "HANDBRAKE",
    ].filter(Boolean).join(", ") || "none";

    this.panel.textContent = [
      "RACE DEBUGGER (T / D)",
      `race: ${racing ? "yes" : "no"}`,
      `input: ${activeInput}`,
      `speed: ${car.speedKmh().toFixed(1)} km/h`,
      `velocity: ${velocity.x.toFixed(2)}, ${velocity.y.toFixed(2)}, ${velocity.z.toFixed(2)}`,
      `position: ${body.position.x.toFixed(1)}, ${body.position.y.toFixed(1)}, ${body.position.z.toFixed(1)}`,
      `wheels grounded: ${grounded}/4`,
      `FL:${groundedWheels[0] ? "grounded" : "AIR"} ${wheels[0].raycastResult.distance.toFixed(2)}m  FR:${groundedWheels[1] ? "grounded" : "AIR"} ${wheels[1].raycastResult.distance.toFixed(2)}m`,
      `RL:${groundedWheels[2] ? "grounded" : "AIR"} ${wheels[2].raycastResult.distance.toFixed(2)}m  RR:${groundedWheels[3] ? "grounded" : "AIR"} ${wheels[3].raycastResult.distance.toFixed(2)}m`,
      `off track: ${offTrack ? "yes" : "no"}`,
      `sleeping: ${body.sleepState !== 0 ? "yes" : "no"}`,
      `stuck timer: ${(stuckMs / 1000).toFixed(1)} / 2.5 s`,
      `stuck check: ${stuckMs > 0 ? "counting" : "inactive"}`,
    ].join("\n");
  }
}