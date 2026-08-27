import * as THREE from "three";
import * as CANNON from "cannon-es";
import { InputState } from "./input";
import { buildTrack } from "./track";
import { Car } from "./car";
import { Hud } from "./hud";
import { submitScore } from "./leaderboard";

const TOTAL_LAPS = 3;
const BEST_TIME_KEY = "cf-car-race-best-ms";

// --- Renderer / scene / camera ---
const app = document.getElementById("app")!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fd0ec);
scene.fog = new THREE.Fog(0x8fd0ec, 120, 320);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 1000);

// Simple skybox via a large sphere with gradient-ish material
const skyGeo = new THREE.SphereGeometry(400, 16, 16);
const skyMat = new THREE.MeshBasicMaterial({ color: 0x8fd0ec, side: THREE.BackSide });
scene.add(new THREE.Mesh(skyGeo, skyMat));

// Lighting: one directional "sun" + ambient
const sun = new THREE.DirectionalLight(0xfff2d9, 1.4);
sun.position.set(80, 120, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
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
  hud.showMessage("Go!", 1200);
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
    runStartTime = performance.now();
    resetRace();
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
hud.showMessage("Go!", 1500);

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  car.update(input);
  world.step(FIXED_STEP, dt, 5);
  car.syncMeshes();

  if (input.reset) {
    runStartTime = performance.now();
    resetRace();
  }

  checkCheckpoints();
  updateCamera(dt);

  const elapsed = finished ? 0 : performance.now() - runStartTime;
  hud.update(lap, TOTAL_LAPS, elapsed, bestTimeMs, car.speedKmh());

  renderer.render(scene, camera);
}

animate();
