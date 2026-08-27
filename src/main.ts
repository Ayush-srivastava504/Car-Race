import * as THREE from "three";
import * as CANNON from "cannon-es";
import { InputState } from "./input";
import { buildTrack } from "./track";
import { Car } from "./car";
import { Hud } from "./hud";
import { submitScore } from "./leaderboard";

const TOTAL_LAPS = 3;
const BEST_TIME_KEY = "cf-car-race-best-ms";

// --- Mobile detection: drives perf + camera tuning below ---
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 820;
const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
const mobileMode = isMobile || isCoarsePointer;

// --- Renderer / scene / camera ---
const app = document.getElementById("app")!;
const renderer = new THREE.WebGLRenderer({ antialias: !mobileMode, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobileMode ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = mobileMode ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fd0ec);
scene.fog = new THREE.Fog(0x8fd0ec, 100, mobileMode ? 240 : 320);

// Wider FOV on phones (typically held closer, narrower screen) reads less
// claustrophobic and shows more of the track ahead for reaction time.
const camera = new THREE.PerspectiveCamera(
  mobileMode ? 74 : 65,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);

// Simple skybox via a large sphere with gradient-ish material
const skyGeo = new THREE.SphereGeometry(400, 16, 16);
const skyMat = new THREE.MeshBasicMaterial({ color: 0x8fd0ec, side: THREE.BackSide });
scene.add(new THREE.Mesh(skyGeo, skyMat));

// Lighting: one directional "sun" + ambient
const sun = new THREE.DirectionalLight(0xfff2d9, 1.4);
sun.position.set(80, 120, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(mobileMode ? 1024 : 2048, mobileMode ? 1024 : 2048);
sun.shadow.camera.left = -150;
sun.shadow.camera.right = 150;
sun.shadow.camera.top = 150;
sun.shadow.camera.bottom = -150;
sun.shadow.camera.far = 400;
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

// --- Race state ---
let nextCheckpoint = 0;
let lap = 0;
let raceStartTime = performance.now();
let lastLapTime: number | null = null;
let bestTimeMs: number | null = readBestTime();
let finished = false;

function readBestTime(): number | null {
  const raw = localStorage.getItem(BEST_TIME_KEY);
  return raw ? parseFloat(raw) : null;
}

function saveBestTime(ms: number) {
  bestTimeMs = ms;
  localStorage.setItem(BEST_TIME_KEY, ms.toString());
}

function resetRace() {
  car.reset(track.startPosition, track.startRotationY);
  nextCheckpoint = 0;
  lap = 0;
  finished = false;
  raceStartTime = performance.now();
}

function checkCheckpoints() {
  if (finished) return;
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
      const now = performance.now();
      lastLapTime = now - raceStartTime;
      raceStartTime = now;

      if (lap >= TOTAL_LAPS) {
        finished = true;
        const totalMs = lastLapTime; // last lap timer holds this final segment;
        // Overall run time tracked separately below via runStartTime.
        onRaceFinished();
      } else {
        hud.showMessage(`Lap ${lap} / ${TOTAL_LAPS}`, 1500);
      }
    }
  }
}

let runStartTime = performance.now();

function onRaceFinished() {
  const totalMs = performance.now() - runStartTime;
  if (bestTimeMs === null || totalMs < bestTimeMs) {
    saveBestTime(totalMs);
    hud.showMessage("New best time!", 3500);
    submitScore("Player", totalMs);
  } else {
    hud.showMessage("Finished!", 3500);
  }
  window.setTimeout(() => {
    resetRace();
    runCountdown();
  }, 3500);
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
}

// --- Resize handling ---
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Main loop ---
const clock = new THREE.Clock();
const FIXED_STEP = 1 / 60;

hud.hideLoading();

let raceReady = false;
runCountdown();

function runCountdown() {
  raceReady = false;
  const steps = ["3", "2", "1", "GO!"];
  let i = 0;
  const tick = () => {
    hud.showMessage(steps[i], 850);
    i++;
    if (i < steps.length) {
      window.setTimeout(tick, 850);
    } else {
      window.setTimeout(() => {
        raceReady = true;
        runStartTime = performance.now();
        raceStartTime = performance.now();
      }, 500);
    }
  };
  tick();
}

// Pause the physics/timer clock (not rendering) when the tab is hidden so a
// backgrounded mobile browser tab doesn't rack up a huge elapsed time or let
// physics explode from a giant catch-up delta.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) clock.getDelta(); // discard the huge gap
});

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  input.update(dt);
  car.update(input, raceReady ? dt : 0);
  world.step(FIXED_STEP, dt, 5);
  car.syncMeshes();

  if (input.reset) {
    resetRace();
    runCountdown();
  }

  if (raceReady) checkCheckpoints();
  updateCamera(dt);

  const elapsed = finished || !raceReady ? 0 : performance.now() - runStartTime;
  hud.update(lap, TOTAL_LAPS, elapsed, bestTimeMs, car.speedKmh());

  renderer.render(scene, camera);
}

animate();
