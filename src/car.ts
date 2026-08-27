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

const CAR_LENGTH = 3.6;
const CAR_WIDTH = 1.8;

// Uploaded glTF vehicle model (public/models/, served at web root by Vite).
const MODEL_URL = "/models/vehicle.gltf";
// The model's front/back orientation relative to the physics forward axis
// (+Z) is not known ahead of render — flip to Math.PI if the car appears to
// drive backwards (nose trailing rather than leading).
const MODEL_YAW_OFFSET = Math.PI;
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
    const chassisShape = new CANNON.Box(new CANNON.Vec3(0.9, 0.35, 1.8));
    this.chassisBody = new CANNON.Body({ mass: 150 });
    this.chassisBody.addShape(chassisShape, new CANNON.Vec3(0, 0.5, 0));
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
      frictionSlip: 2.2,
      dampingRelaxation: 2.5,
      dampingCompression: 4.5,
      maxSuspensionForce: 100000,
      rollInfluence: 0.02,
      axleLocal: new CANNON.Vec3(1, 0, 0),
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

  update(input: InputState, dt: number) {
    const speed = this.forwardSpeed();

    // Analog throttle/brake: pressing brake while moving forward brakes,
    // pressing it while stopped/reversing lets you reverse.
    const movingForward = speed > 0.6;
    let engineForce = 0;
    let braking = 0;
    if (input.throttle > 0) {
      engineForce = input.throttle * MAX_FORCE;
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
    this.mesh.position.copy(this.chassisBody.position as unknown as THREE.Vector3);
    this.mesh.quaternion.copy(this.chassisBody.quaternion as unknown as THREE.Quaternion);

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
