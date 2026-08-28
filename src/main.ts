import * as THREE from "three";
import * as CANNON from "cannon-es";
import { InputState, isTouchDevice } from "./input";
import { buildTrack } from "./track";
import { Car } from "./car";
import { Hud } from "./hud";
import { submitScore } from "./leaderboard";
import { setupFullscreen } from "./fullscreen";
import { RaceDebugger } from "./debugger";

const TOTAL_LAPS = 3;
const BEST_TIME_KEY = "cf-car-race-best-ms";

// --- Renderer / scene / camera ---
const app = document.getElementById("app")!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
// Cap pixel ratio harder on touch devices — GPUs on phones are the bottleneck,
// and a crisper-but-choppier canvas is a worse trade than a smooth 60fps.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isTouchDevice ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = !isTouchDevice; // shadows are the single biggest mobile GPU cost
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fd0ec);
scene.fog = new THREE.Fog(0x8fd0ec, 120, 320);

const BASE_FOV = 65;
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 1000);

// Simple skybox via a large sphere with gradient-ish material
const skyGeo = new THREE.SphereGeometry(400, 16, 16);
const skyMat = new THREE.MeshBasicMaterial({ color: 0x8fd0ec, side: THREE.BackSide });
scene.add(new THREE.Mesh(skyGeo, skyMat));

// Lighting: one directional "sun" + ambient
const sun = new THREE.DirectionalLight(0xfff2d9, 1.4);
sun.position.set(80, 120, 40);
if (!isTouchDevice) {
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -150;
  sun.shadow.camera.right = 150;
  sun.shadow.camera.top = 150;
  sun.shadow.camera.bottom = -150;
  sun.shadow.camera.far = 400;
}
scene.add(sun);
scene.add(new THREE.AmbientLight(0xbfd6ff, 0.55));

// --- Physics world ---
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
(world.solver as CANNON.GSSolver).iterations = 10;

// --- Track & car ---
const track = buildTrack(world);
scene.add(track.group);

const car = new Car(scene, world, track.startPosition, track.startRotationY);
const input = new InputState();
const hud = new Hud();
setupFullscreen();
const raceDebugger = new RaceDebugger();

// --- Touch controls ---
if (isTouchDevice) {
  document.body.classList.add("touch");
  const bind = (id: string, setter: (v: boolean) => void) => {
    const el = document.getElementById(id);
    if (el) input.bindHoldButton(el, setter);
  };
  bind("steer-left", (v) => input.setTouchLeft(v));
  bind("steer-right", (v) => input.setTouchRight(v));
  bind("btn-gas", (v) => input.setTouchForward(v));
  bind("btn-brake", (v) => input.setTouchBackward(v));
  bind("btn-handbrake", (v) => input.setTouchHandbrake(v));
}
const resetBtn = document.getElementById("reset-btn");
if (resetBtn) input.bindTapButton(resetBtn, () => requestReset());

// A stand-in "no input" state used during the start countdown / while
// finished, so the car doesn't lurch off before "GO!" fires.
const NEUTRAL_INPUT: InputState = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  handbrake: false,
  reset: false,
} as InputState;

// --- Race state ---
const COUNTDOWN_STEPS = ["3", "2", "1", "GO!"];
const COUNTDOWN_STEP_MS = 800;
let nextCheckpoint = 0;
let lap = 0;
let bestTimeMs: number | null = readBestTime();
let finished = false;
let countdownUntil = 0; // performance.now() timestamp when countdown finishes; 0 = not counting down
let countdownStepIdx = -1;
let runStartTime = performance.now();
let resetQueued = false;
let lastResetKey = false;
let stuckSince = 0;
let offTrack = false;
let airIncidentLogged = false;

function readBestTime(): number | null {
  const raw = localStorage.getItem(BEST_TIME_KEY);
  return raw ? parseFloat(raw) : null;
}

function saveBestTime(ms: number) {
  bestTimeMs = ms;
  localStorage.setItem(BEST_TIME_KEY, ms.toString());
}

function requestReset() {
  resetQueued = true;
}

function recoverIfStuck(now: number) {
  const tryingToDrive = input.forward || input.backward;
  const barelyMoving = car.forwardSpeed() < 0.75;
  const airborne = car.wheelGrounded().every((grounded) => !grounded);
  const fallen = car.chassisBody.position.y < -0.5;
  const needsAirRecovery = airborne || fallen;
  if (needsAirRecovery && !airIncidentLogged) {
    const wheels = car.vehicle.wheelInfos;
    console.warn("[race] ground contact lost", {
      position: {
        x: car.chassisBody.position.x,
        y: car.chassisBody.position.y,
        z: car.chassisBody.position.z,
      },
      velocity: {
        x: car.chassisBody.velocity.x,
        y: car.chassisBody.velocity.y,
        z: car.chassisBody.velocity.z,
      },
      wheels: wheels.map((wheel) => ({
        grounded: wheel.raycastResult.hasHit,
        distance: wheel.raycastResult.distance,
      })),
    });
    airIncidentLogged = true;
  }
  if (!needsAirRecovery) airIncidentLogged = false;
  if (!isRacing() || (!needsAirRecovery && (!tryingToDrive || !barelyMoving))) {
    stuckSince = 0;
    return;
  }

  if (stuckSince === 0) stuckSince = now;
  const recoveryDelay = airborne || fallen ? 700 : 2500;
  if (now - stuckSince < recoveryDelay) return;

  // Always use the known-good start line. Recovering at the nearest point can
  // place the car back into the same broken section and cause endless bouncing.
  car.reset(track.startPosition, track.startRotationY);
  stuckSince = now;
}

const countdownEl = document.getElementById("countdown")!;

function startCountdown() {
  car.reset(track.startPosition, track.startRotationY);
  nextCheckpoint = 0;
  lap = 0;
  finished = false;
  countdownStepIdx = 0;
  countdownEl.style.display = "block";
  countdownEl.textContent = COUNTDOWN_STEPS[0];
  countdownUntil = performance.now() + COUNTDOWN_STEP_MS;
  runStartTime = performance.now();
  hud.showMessage("", 0);
}

function updateCountdown(now: number) {
  if (countdownUntil === 0) return;
  // Freeze the car in place while counting down so gravity settle + any
  // residual input doesn't creep it off the line before "GO!".
  car.chassisBody.velocity.set(0, 0, 0);
  car.chassisBody.angularVelocity.set(0, 0, 0);
  if (now >= countdownUntil) {
    countdownStepIdx++;
    if (countdownStepIdx >= COUNTDOWN_STEPS.length) {
      countdownEl.style.display = "none";
      countdownUntil = 0;
      runStartTime = performance.now();
      return;
    }
    countdownEl.textContent = COUNTDOWN_STEPS[countdownStepIdx];
    countdownUntil = now + COUNTDOWN_STEP_MS;
  }
}

function isRacing(): boolean {
  return countdownUntil === 0 && !finished;
}

function checkCheckpoints() {
  if (!isRacing()) return;
  const carPos = car.chassisBody.position;
  const cp = track.checkpoints[nextCheckpoint];
  const dx = carPos.x - cp.position.x;
  const dz = carPos.z - cp.position.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < cp.radius) {
    nextCheckpoint++;
    if (nextCheckpoint >= track.checkpoints.length) {
      nextCheckpoint = 0;
      lap++;

      if (lap >= TOTAL_LAPS) {
        finished = true;
        onRaceFinished();
      } else {
        hud.showMessage(`Lap ${lap} / ${TOTAL_LAPS}`, 1500);
      }
    }
  }
}

// --- Off-track grip + wrong-way detection (against the precomputed centerline) ---
const halfRoad = track.roadWidth / 2;
let wrongWayShownAt = 0;

function updateTrackAdherence() {
  const pos = car.chassisBody.position;
  let bestDistSq = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < track.centerline.length; i++) {
    const p = track.centerline[i];
    const dx = p.x - pos.x;
    const dz = p.z - pos.z;
    const d = dx * dx + dz * dz;
    if (d < bestDistSq) {
      bestDistSq = d;
      bestIdx = i;
    }
  }
  const dist = Math.sqrt(bestDistSq);
  // Allow the full car width to reach just beyond the ribbon before applying
  // the grass penalty, so brushing the edge does not feel like mud.
  offTrack = dist > halfRoad + 2.4;
  car.setOffTrack(offTrack);
  const offEl = document.getElementById("offtrack")!;
  offEl.style.display = offTrack ? "block" : "none";

  // Wrong-way: compare the car's velocity direction against the track's
  // direction of travel at the nearest centerline point.
  if (isRacing() && car.forwardSpeed() > 6) {
    const n = track.centerline.length;
    const next = track.centerline[(bestIdx + 1) % n];
    const cur = track.centerline[bestIdx];
    const trackDirX = next.x - cur.x;
    const trackDirZ = next.z - cur.z;
    const vel = car.chassisBody.velocity;
    const dot = trackDirX * vel.x + trackDirZ * vel.z;
    const now = performance.now();
    if (dot < 0 && now - wrongWayShownAt > 2000) {
      wrongWayShownAt = now;
      hud.showMessage("WRONG WAY", 1200);
    }
  }
}

function onRaceFinished() {
  const totalMs = performance.now() - runStartTime;
  if (bestTimeMs === null || totalMs < bestTimeMs) {
    saveBestTime(totalMs);
    hud.showMessage("New best time!", 3000);
    submitScore("Player", totalMs);
  } else {
    hud.showMessage("Finished!", 3000);
  }
  window.setTimeout(() => startCountdown(), 3000);
}

// --- Camera follow (third-person chase, smoothed) ---
const camOffset = new THREE.Vector3(0, 4.5, -8.5);
const camLookOffset = new THREE.Vector3(0, 1.2, 3);
const desiredCamPos = new THREE.Vector3();
const desiredLookAt = new THREE.Vector3();

function updateCamera(dt: number) {
  const carQuat = car.mesh.quaternion;
  const offset = camOffset.clone().applyQuaternion(carQuat);
  desiredCamPos.copy(car.mesh.position).add(offset);

  const lookOffset = camLookOffset.clone().applyQuaternion(carQuat);
  desiredLookAt.copy(car.mesh.position).add(lookOffset);

  const lerpFactor = 1 - Math.pow(0.001, dt); // frame-rate independent smoothing
  camera.position.lerp(desiredCamPos, lerpFactor);
  camera.lookAt(desiredLookAt);

  // Subtle FOV widening with speed reads as a sense of acceleration/speed.
  const speedFrac = Math.min(car.forwardSpeed() / 40, 1);
  const targetFov = BASE_FOV + speedFrac * 8;
  camera.fov += (targetFov - camera.fov) * Math.min(dt * 3, 1);
  camera.updateProjectionMatrix();
}

// --- Resize handling ---
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", onResize);
window.addEventListener("orientationchange", () => window.setTimeout(onResize, 200));

// Pause the clock while the tab/app is hidden so we don't try to catch up
// a huge dt (and don't silently keep racking up "elapsed" time) when the
// player switches apps on their phone mid-race.
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hiddenAt = performance.now();
  } else if (hiddenAt) {
    const pausedMs = performance.now() - hiddenAt;
    runStartTime += pausedMs;
    if (countdownUntil) countdownUntil += pausedMs;
    hiddenAt = 0;
  }
});

// --- Main loop ---
const clock = new THREE.Clock();
const FIXED_STEP = 1 / 60;

hud.hideLoading();
startCountdown();

function animate() {
  requestAnimationFrame(animate);
  if (document.hidden) return;
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();

  if ((input.reset && !lastResetKey) || resetQueued) {
    resetQueued = false;
    startCountdown();
  }
  lastResetKey = input.reset;

  updateCountdown(now);

  car.update(isRacing() ? input : NEUTRAL_INPUT, dt);
  world.step(FIXED_STEP, dt, 5);
  car.syncMeshes();
  recoverIfStuck(now);
  raceDebugger.update(car, input, isRacing(), offTrack, stuckSince === 0 ? 0 : now - stuckSince);

  updateTrackAdherence();
  checkCheckpoints();
  updateCamera(dt);

  const elapsed = finished ? 0 : now - runStartTime;
  hud.update(lap, TOTAL_LAPS, elapsed, bestTimeMs, car.speedKmh());

  renderer.render(scene, camera);
}

animate();
