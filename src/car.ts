import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as CANNON from "cannon-es";
import { InputState } from "./input";

const MAX_STEER = 0.55;
const MIN_STEER = 0.22; // steering angle clamps down toward this at top speed for stability
const STEER_SPEED_FALLOFF = 26; // m/s at which steering has fully reduced to MIN_STEER
const MAX_FORCE = 1150;
const BRAKE_FORCE = 22;
const HANDBRAKE_FORCE = 46;
const STEER_LERP_RATE = 10; // wheel-turn smoothing, independent of input smoothing

// --- Boost / nitro ---
const BOOST_MAX = 100;
const BOOST_MULTIPLIER = 1.55; // engine force multiplier while boosting
const BOOST_DRAIN_PER_SEC = 42; // ~2.4s of full boost from a full tank
const BOOST_REGEN_PER_SEC = 11; // ~9s to refill from empty when not boosting
const BOOST_REGEN_DELAY = 0.6; // seconds after releasing boost before regen kicks in

const CAR_LENGTH = 3.6;
const CAR_WIDTH = 1.8;

// Uploaded glTF vehicle model (public/models/, served at web root by Vite).
const MODEL_URL = "/models/vehicle.gltf";
// The model's front/back orientation relative to the physics forward axis
// (+Z, where the front wheels are mounted). The RaycastVehicle's wheel
// axle was previously inverted (see wheelOptions.axleLocal below), which
// made the car actually accelerate toward -Z — i.e. backwards relative to
// its own front wheels — no matter how this offset was set. That's now
// fixed at the physics level, so this offset is 0 by default. If the raw
// model asset itself happens to face -Z, flip this back to Math.PI.
const MODEL_YAW_OFFSET = 0;
// Model's own wheels are baked into its single mesh (no separate wheel
// nodes), so they don't rotate/steer with the physics wheels. We still keep
// the physics RaycastVehicle's own wheel bodies for suspension/handling,
// but their visual meshes are invisible placeholders so we don't get a
// doubled-up wheel look next to the model's baked-in wheels.
const gltfLoader = new GLTFLoader();

export class Car {
  mesh: THREE.Group;
  chassisBody: CANNON.Body;
  vehicle: CANNON.RaycastVehicle;
  wheelMeshes: THREE.Object3D[] = [];

  constructor(scene: THREE.Scene, world: CANNON.World, startPos: THREE.Vector3, startRotY: number) {
    this.mesh = new THREE.Group();
    scene.add(this.mesh);

    // --- Visual body: load the uploaded glTF vehicle model ---
    const modelRoot = new THREE.Group();
    modelRoot.rotation.y = MODEL_YAW_OFFSET;
    this.mesh.add(modelRoot);

    gltfLoader.load(
      MODEL_URL,
      (gltf) => {
        const model = gltf.scene;
        model.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
          }
        });

        // Normalize the model into car-local space: centered on X/Z, scaled
        // so its length matches CAR_LENGTH, and dropped so its lowest point
        // (tires) sits near the wheel contact height used by the physics
        // rig below (chassis-local y ≈ -0.3, matching wheel radius 0.4 at
        // wheel mount height 0.1).
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        const center = new THREE.Vector3();
        box.getCenter(center);

        const longestHorizontal = Math.max(size.x, size.z);
        const scale = longestHorizontal > 0 ? CAR_LENGTH / longestHorizontal : 1;
        model.scale.setScalar(scale);

        // Recompute box after scaling to place it accurately.
        const scaledBox = new THREE.Box3().setFromObject(model);
        const scaledCenter = new THREE.Vector3();
        scaledBox.getCenter(scaledCenter);

        model.position.x -= scaledCenter.x;
        model.position.z -= scaledCenter.z;
        model.position.y -= scaledBox.min.y + 0.3; // lowest point -> y ≈ -0.3

        modelRoot.add(model);
      },
      undefined,
      (err) => {
        console.error("Failed to load vehicle model", err);
      }
    );

    // --- Physics chassis ---
    // Shape offset kept low (close to the wheel-mount plane at local y=0.1)
    // so the center of mass sits near the axle line instead of far above
    // it. Previously offset 0.5 up put the CoM well above the suspension,
    // which reads as heavy/pitchy — exaggerated nose-dive under braking and
    // squat under acceleration, and sluggish rotation overall.
    const chassisShape = new CANNON.Box(new CANNON.Vec3(0.9, 0.35, 1.8));
    this.chassisBody = new CANNON.Body({ mass: 150 });
    this.chassisBody.addShape(chassisShape, new CANNON.Vec3(0, 0.15, 0));
    this.chassisBody.position.set(startPos.x, startPos.y + 0.5, startPos.z);
    this.chassisBody.quaternion.setFromEuler(0, startRotY, 0);
    this.chassisBody.angularVelocity.set(0, 0, 0);
    this.chassisBody.linearDamping = 0.05;
    this.chassisBody.angularDamping = 0.4;

    this.vehicle = new CANNON.RaycastVehicle({
      chassisBody: this.chassisBody,
      indexRightAxis: 0,
      indexUpAxis: 1,
      indexForwardAxis: 2,
    });

    const wheelOptions = {
      radius: 0.4,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      suspensionStiffness: 35,
      suspensionRestLength: 0.35,
      // cannon-es caps each wheel's usable grip per step at
      // suspensionForce * timestep * frictionSlip (see updateFriction in
      // the library). At the old value of 2.2 that ceiling was ~13.5
      // impulse-units per rear wheel at rest, while full-throttle forward
      // was demanding ~19 — so forward power was constantly being clipped
      // back down to the grip limit (wheelspin/bogging). Reverse only ever
      // requests 60% of MAX_FORCE, which happened to land under that same
      // low ceiling, so it launched clean while forward didn't. Raised so
      // forward has real headroom (including with boost active).
      frictionSlip: 6.2,
      dampingRelaxation: 2.5,
      dampingCompression: 4.5,
      maxSuspensionForce: 100000,
      rollInfluence: 0.02,
      // cannon-es derives each wheel's forward direction as
      // groundNormal x axleLocal, so with indexRightAxis=0 / indexUpAxis=1
      // an axle of (1,0,0) resolves to forward = (0,0,-1) — i.e. positive
      // engine force pushed the chassis toward -Z, away from the front
      // wheels (mounted at +Z below). That's the "driving backwards" bug.
      // Flipping the axle to (-1,0,0) makes forward resolve to +Z, which
      // matches where the front wheels actually are.
      axleLocal: new CANNON.Vec3(-1, 0, 0),
      chassisConnectionPointLocal: new CANNON.Vec3(),
      maxSuspensionTravel: 0.25,
      customSlidingRotationalSpeed: -30,
      useCustomSlidingRotationalSpeed: true,
    };

    const axisWidth = 0.85;
    const wheelPositions = [
      new CANNON.Vec3(-axisWidth, 0.1, 1.35), // front left
      new CANNON.Vec3(axisWidth, 0.1, 1.35), // front right
      new CANNON.Vec3(-axisWidth, 0.1, -1.35), // rear left
      new CANNON.Vec3(axisWidth, 0.1, -1.35), // rear right
    ];
    wheelPositions.forEach((pos) => {
      const opts = { ...wheelOptions, chassisConnectionPointLocal: pos };
      this.vehicle.addWheel(opts);
    });
    this.vehicle.addToWorld(world);

    // --- Wheel transform trackers: the model's wheels are baked into its
    // single mesh and don't spin, so these stay invisible; they only exist
    // so syncMeshes() below has something to update without special-casing.
    for (let i = 0; i < 4; i++) {
      const w = new THREE.Object3D();
      w.visible = false;
      this.wheelMeshes.push(w);
    }
  }

  private currentSteer = 0;

  /** 0..BOOST_MAX energy remaining in the nitro tank. */
  boostEnergy = BOOST_MAX;
  /** True while boost is actively being applied this frame (for camera/HUD). */
  boostActive = false;
  private boostRegenCooldown = 0;

  update(input: InputState, dt: number) {
    const speed = this.forwardSpeed();

    // Analog throttle/brake: pressing brake while moving forward brakes,
    // pressing it while stopped/reversing lets you reverse.
    const movingForward = speed > 0.6;
    let engineForce = 0;
    let braking = 0;

    // --- Nitro boost: only while actively accelerating forward and fuel
    // remains. Drains while held, regenerates after a short delay once
    // released (or once the tank runs dry).
    this.boostActive = input.boost && input.throttle > 0 && this.boostEnergy > 0;
    if (this.boostActive) {
      this.boostEnergy = Math.max(0, this.boostEnergy - BOOST_DRAIN_PER_SEC * dt);
      this.boostRegenCooldown = BOOST_REGEN_DELAY;
    } else if (this.boostRegenCooldown > 0) {
      this.boostRegenCooldown = Math.max(0, this.boostRegenCooldown - dt);
    } else {
      this.boostEnergy = Math.min(BOOST_MAX, this.boostEnergy + BOOST_REGEN_PER_SEC * dt);
    }

    if (input.throttle > 0) {
      engineForce = input.throttle * MAX_FORCE * (this.boostActive ? BOOST_MULTIPLIER : 1);
    }
    if (input.brake > 0) {
      if (movingForward) {
        braking = input.brake * BRAKE_FORCE;
      } else {
        engineForce = -input.brake * MAX_FORCE * 0.6;
      }
    }
    const handbrake = input.handbrake ? HANDBRAKE_FORCE : 0;

    // Rear-wheel drive
    this.vehicle.applyEngineForce(engineForce, 2);
    this.vehicle.applyEngineForce(engineForce, 3);

    // Speed-sensitive steering: full lock at low speed for tight turns and
    // easy parking-lot maneuvering, progressively tighter at speed so the
    // car doesn't snap-spin — this matters even more on touch, where the
    // joystick can slam to full deflection instantly.
    const speedT = Math.min(speed / STEER_SPEED_FALLOFF, 1);
    const steerLimit = MAX_STEER - (MAX_STEER - MIN_STEER) * speedT;
    const targetSteer = Math.max(-1, Math.min(1, input.steer)) * steerLimit;

    // Smooth the actual wheel angle toward the target so touch-joystick
    // jitter and keyboard on/off toggling both feel analog at the wheel.
    const diff = targetSteer - this.currentSteer;
    const maxStep = STEER_LERP_RATE * dt;
    this.currentSteer += Math.sign(diff) * Math.min(Math.abs(diff), maxStep);

    this.vehicle.setSteeringValue(this.currentSteer, 0);
    this.vehicle.setSteeringValue(this.currentSteer, 1);

    for (let i = 0; i < 4; i++) {
      this.vehicle.setBrake(braking + (i >= 2 ? handbrake : 0), i);
    }
  }

  forwardSpeed(): number {
    const v = this.chassisBody.velocity;
    return Math.sqrt(v.x * v.x + v.z * v.z);
  }

  speedKmh(): number {
    return this.forwardSpeed() * 3.6;
  }

  syncMeshes() {
    // Use the physics engine's *interpolated* transform, not the raw one.
    // world.step() in main.ts is called in its 3-arg "interpolation" mode
    // (fixed dt + real elapsed time), which runs physics at a fixed 60Hz
    // internally but only fully advances chassisBody.position/quaternion
    // once per completed sub-step. Copying that raw value straight into the
    // mesh means the visual only updates in discrete ~16.7ms jumps, out of
    // phase with requestAnimationFrame — which reads as juddery/shaky
    // movement, especially on 90/120Hz phone displays where several render
    // frames land between physics steps. interpolatedPosition/Quaternion
    // are exactly what cannon-es computes each call to bridge that gap:
    // a blend between the previous and current physics state based on how
    // far into the next step we are, so the car moves smoothly every frame
    // regardless of the display's refresh rate.
    this.mesh.position.copy(this.chassisBody.interpolatedPosition as unknown as THREE.Vector3);
    this.mesh.quaternion.copy(this.chassisBody.interpolatedQuaternion as unknown as THREE.Quaternion);

    for (let i = 0; i < this.vehicle.wheelInfos.length; i++) {
      this.vehicle.updateWheelTransform(i);
      const t = this.vehicle.wheelInfos[i].worldTransform;
      const mesh = this.wheelMeshes[i];
      mesh.position.copy(t.position as unknown as THREE.Vector3);
      mesh.quaternion.copy(t.quaternion as unknown as THREE.Quaternion);
    }
  }

  reset(pos: THREE.Vector3, rotY: number) {
    this.chassisBody.position.set(pos.x, pos.y + 0.6, pos.z);
    this.chassisBody.velocity.set(0, 0, 0);
    this.chassisBody.angularVelocity.set(0, 0, 0);
    this.chassisBody.quaternion.setFromEuler(0, rotY, 0);
  }
}
