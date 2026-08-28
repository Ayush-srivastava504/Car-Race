import * as THREE from "three";
import * as CANNON from "cannon-es";
import { InputState } from "./input";

const MAX_STEER = 0.55;
const MIN_STEER_AT_TOPSPEED = 0.16; // steering narrows at speed so the car stays controllable
const STEER_RATE = 3.2; // rad/s the wheel angle can move toward its target (smooths keyboard AND touch input)
const MAX_FORCE = 1800;
const TOP_SPEED_MS = 52; // ~187 km/h — engine force tapers off as this is approached
const BRAKE_FORCE = 14;
const HANDBRAKE_FORCE = 42;
const ON_TRACK_FRICTION = 2.2;
const OFF_TRACK_FRICTION = 1.9; // grass has slightly less grip without making the car bog down
const OFF_TRACK_FORCE_MULT = 0.9; // small penalty for leaving the ribbon, but it remains drivable

const CAR_LENGTH = 3.6;
const CAR_WIDTH = 1.8;

/**
 * Builds the car's visual silhouette by extruding a hand-drawn side profile
 * (rear bumper -> trunk -> cabin -> hood -> front bumper) across the car's
 * width. This gives a proper low-poly wedge shape instead of a plain box,
 * without needing any external model file — still a placeholder in spirit,
 * but reads as a car from any angle. Swap for a glTF model later by
 * replacing buildBodyGeometry()'s call site in the constructor below.
 */
function buildBodyGeometry(): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  // (x = position along car length, 0 = rear axle area, CAR_LENGTH = nose;
  //  y = height above the chassis origin)
  shape.moveTo(0.0, 0.22);
  shape.lineTo(0.0, 0.5); // rear bumper
  shape.lineTo(0.3, 0.62); // trunk lid
  shape.lineTo(0.75, 0.98); // rear windshield base
  shape.lineTo(1.35, 1.08); // roof rear
  shape.lineTo(2.05, 1.08); // roof front
  shape.lineTo(2.55, 0.78); // windshield front / hood junction
  shape.lineTo(3.2, 0.55); // hood
  shape.lineTo(CAR_LENGTH, 0.42); // front bumper top
  shape.lineTo(CAR_LENGTH, 0.2); // front bumper bottom
  shape.lineTo(0.0, 0.2); // flat underbody back to start
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, { depth: CAR_WIDTH, bevelEnabled: false });
  // Shape space: x=length, y=height, extrude depth=width (along shape-local Z).
  // Rotate so length runs along the mesh's forward (+Z) axis and width along X,
  // matching the RaycastVehicle's forward/right axes set up below.
  geo.rotateY(-Math.PI / 2);
  geo.translate(CAR_WIDTH / 2, 0, -CAR_LENGTH / 2);
  geo.computeVertexNormals();
  return geo;
}

export class Car {
  mesh: THREE.Group;
  chassisBody: CANNON.Body;
  vehicle: CANNON.RaycastVehicle;
  wheelMeshes: THREE.Object3D[] = [];
  private currentSteer = 0;
  private offTrack = false;

  constructor(scene: THREE.Scene, world: CANNON.World, startPos: THREE.Vector3, startRotY: number) {
    this.mesh = new THREE.Group();

    // --- Body: extruded low-poly silhouette ---
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe23d3d, roughness: 0.45, metalness: 0.25 });
    const body = new THREE.Mesh(buildBodyGeometry(), bodyMat);
    body.castShadow = true;
    body.receiveShadow = true;
    this.mesh.add(body);

    // --- Windshield / rear window: dark glass slab set into the cabin gap ---
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x1a2430,
      roughness: 0.15,
      metalness: 0.6,
    });
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.42, 0.72), glassMat);
    windshield.position.set(0, 0.86, 0.65);
    windshield.rotation.x = -0.5;
    windshield.castShadow = true;
    this.mesh.add(windshield);

    const rearWindow = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.3, 0.5), glassMat);
    rearWindow.position.set(0, 0.9, -0.55);
    rearWindow.rotation.x = 0.55;
    this.mesh.add(rearWindow);

    // --- Headlights / taillights ---
    const headlightMat = new THREE.MeshStandardMaterial({
      color: 0xfff6d8,
      emissive: 0xfff2b0,
      emissiveIntensity: 1.1,
      roughness: 0.3,
    });
    const taillightMat = new THREE.MeshStandardMaterial({
      color: 0x4a0d0d,
      emissive: 0xaa1111,
      emissiveIntensity: 0.9,
      roughness: 0.4,
    });
    const lightGeo = new THREE.BoxGeometry(0.28, 0.14, 0.08);
    for (const side of [-1, 1]) {
      const head = new THREE.Mesh(lightGeo, headlightMat);
      head.position.set(side * 0.62, 0.4, CAR_LENGTH / 2 - 0.05);
      this.mesh.add(head);

      const tail = new THREE.Mesh(lightGeo, taillightMat);
      tail.position.set(side * 0.62, 0.46, -CAR_LENGTH / 2 + 0.05);
      this.mesh.add(tail);
    }

    // --- Front splitter / rear spoiler for a bit of race-car character ---
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x161619, roughness: 0.5, metalness: 0.4 });
    const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.06, 0.35), trimMat);
    splitter.position.set(0, 0.18, CAR_LENGTH / 2 - 0.1);
    splitter.castShadow = true;
    this.mesh.add(splitter);

    const spoilerStandGeo = new THREE.BoxGeometry(0.08, 0.28, 0.08);
    const spoilerWingGeo = new THREE.BoxGeometry(1.5, 0.06, 0.34);
    for (const side of [-0.6, 0.6]) {
      const stand = new THREE.Mesh(spoilerStandGeo, trimMat);
      stand.position.set(side, 1.0, -CAR_LENGTH / 2 + 0.25);
      this.mesh.add(stand);
    }
    const wing = new THREE.Mesh(spoilerWingGeo, trimMat);
    wing.position.set(0, 1.16, -CAR_LENGTH / 2 + 0.25);
    wing.castShadow = true;
    this.mesh.add(wing);

    // --- Side skirt stripe for a bit of livery without needing a texture ---
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
    for (const side of [-1, 1]) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.12, CAR_LENGTH - 0.6), stripeMat);
      stripe.position.set(side * (CAR_WIDTH / 2 + 0.01), 0.42, 0);
      this.mesh.add(stripe);
    }

    scene.add(this.mesh);

    // --- Physics chassis ---
    const chassisShape = new CANNON.Box(new CANNON.Vec3(0.9, 0.35, 1.8));
    this.chassisBody = new CANNON.Body({ mass: 150, allowSleep: false });
    this.chassisBody.addShape(chassisShape, new CANNON.Vec3(0, 0.5, 0));
    // startPos.y is already the intended chassis height. Keeping the body
    // here lets the wheel raycasts reach the ground plane at y=0.
    this.chassisBody.position.set(startPos.x, startPos.y, startPos.z);
    this.chassisBody.quaternion.setFromEuler(0, startRotY, 0);
    this.chassisBody.angularVelocity.set(0, 0, 0);
    this.chassisBody.linearDamping = 0.05;
    this.chassisBody.angularDamping = 0.4;
    // Keep the race car upright. Allow yaw for steering, but prevent pitch
    // and roll from turning all wheel raycasts away from the ground.
    this.chassisBody.angularFactor.set(0, 1, 0);

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

    // --- Wheel visuals: tire + a smaller rim/hub cap for a bit of detail ---
    const wheelGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.3, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.85 });

    const rimGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.32, 8);
    rimGeo.rotateZ(Math.PI / 2);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.35, metalness: 0.7 });

    for (let i = 0; i < 4; i++) {
      const w = new THREE.Group();
      const tire = new THREE.Mesh(wheelGeo, wheelMat);
      tire.castShadow = true;
      const rim = new THREE.Mesh(rimGeo, rimMat);
      w.add(tire, rim);
      this.wheelMeshes.push(w);
      scene.add(w);
    }
  }

  update(input: InputState, dt: number) {
    const speed = this.forwardSpeed();

    // Engine force tapers off as the car nears top speed, so acceleration
    // feels progressive instead of pinned flat-out until drag catches up.
    const speedFrac = Math.min(speed / TOP_SPEED_MS, 1);
    const taper = 1 - speedFrac * speedFrac * 0.85;
    const forceMult = this.offTrack ? OFF_TRACK_FORCE_MULT : 1;
    // Cannon's positive engine force drives along local -Z for this vehicle
    // setup, while the car's visual nose and track direction use local +Z.
    const engineForce = input.forward
      ? -MAX_FORCE * taper * forceMult
      : input.backward
        ? MAX_FORCE * 0.55 * forceMult
        : 0;
    const braking = input.backward && speed > 1 ? BRAKE_FORCE : 0;
    const handbrake = input.handbrake ? HANDBRAKE_FORCE : 0;

    // Rear-wheel drive
    this.vehicle.applyEngineForce(engineForce, 2);
    this.vehicle.applyEngineForce(engineForce, 3);

    // Steering angle narrows at speed (real cars do this too) and eases
    // toward its target rather than snapping, which makes both keyboard
    // taps and on-screen touch buttons feel smooth instead of twitchy.
    const steerLimit = MAX_STEER - (MAX_STEER - MIN_STEER_AT_TOPSPEED) * speedFrac;
    const targetSteer = (input.left ? steerLimit : 0) - (input.right ? steerLimit : 0);
    const maxDelta = STEER_RATE * dt;
    const diff = targetSteer - this.currentSteer;
    this.currentSteer += Math.sign(diff) * Math.min(Math.abs(diff), maxDelta);
    if (Math.abs(this.currentSteer) < 0.001) this.currentSteer = 0;

    this.vehicle.setSteeringValue(this.currentSteer, 0);
    this.vehicle.setSteeringValue(this.currentSteer, 1);

    for (let i = 0; i < 4; i++) {
      this.vehicle.setBrake(braking + (i >= 2 ? handbrake : 0), i);
    }
  }

  /** Called once per frame by the game loop with whether the car is currently
   *  off the paved ribbon; lowers rear grip and engine authority on grass. */
  setOffTrack(off: boolean) {
    if (off === this.offTrack) return;
    this.offTrack = off;
    const friction = off ? OFF_TRACK_FRICTION : ON_TRACK_FRICTION;
    for (const wheel of this.vehicle.wheelInfos) {
      wheel.frictionSlip = friction;
    }
  }

  forwardSpeed(): number {
    const v = this.chassisBody.velocity;
    return Math.sqrt(v.x * v.x + v.z * v.z);
  }

  speedKmh(): number {
    return this.forwardSpeed() * 3.6;
  }

  wheelGrounded(): boolean[] {
    return this.vehicle.wheelInfos.map((wheel) => wheel.raycastResult.hasHit);
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
    this.chassisBody.position.set(pos.x, pos.y, pos.z);
    this.chassisBody.velocity.set(0, 0, 0);
    this.chassisBody.angularVelocity.set(0, 0, 0);
    this.chassisBody.quaternion.setFromEuler(0, rotY, 0);
    this.chassisBody.force.set(0, 0, 0);
    this.chassisBody.torque.set(0, 0, 0);
    this.chassisBody.angularFactor.set(0, 1, 0);
    this.chassisBody.wakeUp();
    this.currentSteer = 0;
  }
}
