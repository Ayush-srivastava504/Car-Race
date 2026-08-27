import * as THREE from "three";
import * as CANNON from "cannon-es";

export interface Checkpoint {
  position: THREE.Vector3;
  forward: THREE.Vector3; // direction of travel at this checkpoint
  radius: number;
}

export interface TrackData {
  group: THREE.Group;
  checkpoints: Checkpoint[];
  startPosition: THREE.Vector3;
  startRotationY: number;
  groundBody: CANNON.Body;
  barrierBodies: CANNON.Body[];
}

// Generate a closed-loop set of waypoints (a simple stadium/oval-ish circuit
// with a couple of bends so it isn't a boring circle).
function buildWaypoints(): THREE.Vector3[] {
  const pts: [number, number][] = [
    [0, -40],
    [30, -50],
    [60, -40],
    [75, -10],
    [70, 20],
    [45, 35],
    [20, 25],
    [0, 35],
    [-30, 40],
    [-60, 20],
    [-70, -10],
    [-55, -40],
    [-25, -50],
  ];
  return pts.map(([x, z]) => new THREE.Vector3(x, 0, z));
}

function catmullRomLoop(points: THREE.Vector3[], divisions: number): THREE.Vector3[] {
  const curve = new THREE.CatmullRomCurve3(points, true, "catmullrom", 0.5);
  return curve.getPoints(points.length * divisions);
}

export function buildTrack(world: CANNON.World): TrackData {
  const group = new THREE.Group();
  const roadWidth = 12;

  const rawPoints = buildWaypoints();
  const smoothPoints = catmullRomLoop(rawPoints, 20);

  // --- Ground plane (grass) ---
  const groundGeo = new THREE.PlaneGeometry(400, 400);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x2f6d3a, roughness: 1 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  const groundBody = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane() });
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);

  // --- Road ribbon mesh ---
  const left: THREE.Vector3[] = [];
  const right: THREE.Vector3[] = [];
  const up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < smoothPoints.length; i++) {
    const cur = smoothPoints[i];
    const next = smoothPoints[(i + 1) % smoothPoints.length];
    const dir = next.clone().sub(cur).normalize();
    const side = new THREE.Vector3().crossVectors(up, dir).normalize();
    left.push(cur.clone().add(side.clone().multiplyScalar(roadWidth / 2)));
    right.push(cur.clone().add(side.clone().multiplyScalar(-roadWidth / 2)));
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const n = smoothPoints.length;
  for (let i = 0; i < n; i++) {
    positions.push(left[i].x, 0.01, left[i].z);
    positions.push(right[i].x, 0.01, right[i].z);
    uvs.push(0, i);
    uvs.push(1, i);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = ((i + 1) % n) * 2;
    const d = ((i + 1) % n) * 2 + 1;
    indices.push(a, c, b, b, c, d);
  }
  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  roadGeo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  roadGeo.setIndex(indices);
  roadGeo.computeVertexNormals();
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.9 });
  const road = new THREE.Mesh(roadGeo, roadMat);
  road.receiveShadow = true;
  group.add(road);

  // Physical road surface (thin static box track wouldn't match the curve well,
  // so we rely on the ground plane for driving physics and only use the visual
  // ribbon to indicate the track; off-track detection is done via UV distance
  // check in the game loop against smoothPoints).

  // --- Barriers (instanced boxes along both edges) ---
  const barrierGeo = new THREE.BoxGeometry(1.2, 0.9, 2.2);
  const barrierMat = new THREE.MeshStandardMaterial({ color: 0xd94040, roughness: 0.6 });
  const barrierStep = 3; // place a barrier every N loop samples
  const barrierPositions: { pos: THREE.Vector3; rotY: number }[] = [];

  for (let i = 0; i < n; i += barrierStep) {
    const cur = smoothPoints[i];
    const next = smoothPoints[(i + 1) % n];
    const dir = next.clone().sub(cur).normalize();
    const rotY = Math.atan2(dir.x, dir.z);
    const side = new THREE.Vector3().crossVectors(up, dir).normalize();
    barrierPositions.push({ pos: left[i].clone().add(side.clone().multiplyScalar(0.6)), rotY });
    barrierPositions.push({ pos: right[i].clone().add(side.clone().multiplyScalar(-0.6)), rotY });
  }

  const instanced = new THREE.InstancedMesh(barrierGeo, barrierMat, barrierPositions.length);
  instanced.castShadow = true;
  const dummy = new THREE.Object3D();
  const barrierBodies: CANNON.Body[] = [];
  barrierPositions.forEach((b, idx) => {
    dummy.position.copy(b.pos);
    dummy.position.y = 0.45;
    dummy.rotation.set(0, b.rotY, 0);
    dummy.updateMatrix();
    instanced.setMatrixAt(idx, dummy.matrix);

    const body = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Box(new CANNON.Vec3(0.6, 0.45, 1.1)),
      position: new CANNON.Vec3(b.pos.x, 0.45, b.pos.z),
    });
    body.quaternion.setFromEuler(0, b.rotY, 0);
    world.addBody(body);
    barrierBodies.push(body);
  });
  group.add(instanced);

  // --- Decorative trees (instanced cones+cylinders kept simple as cones) ---
  const treeGeo = new THREE.ConeGeometry(1.6, 4, 6);
  const treeMat = new THREE.MeshStandardMaterial({ color: 0x1f5c2e, roughness: 1 });
  const treeCount = 60;
  const treeMesh = new THREE.InstancedMesh(treeGeo, treeMat, treeCount);
  treeMesh.castShadow = true;
  for (let i = 0; i < treeCount; i++) {
    const angle = (i / treeCount) * Math.PI * 2;
    const r = 130 + Math.random() * 60;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r * 0.8;
    dummy.position.set(x, 2, z);
    dummy.rotation.set(0, Math.random() * Math.PI, 0);
    dummy.scale.setScalar(0.7 + Math.random() * 0.8);
    dummy.updateMatrix();
    treeMesh.setMatrixAt(i, dummy.matrix);
  }
  group.add(treeMesh);

  // --- Checkpoints (evenly spaced around the loop) ---
  const checkpointCount = 8;
  const checkpoints: Checkpoint[] = [];
  for (let i = 0; i < checkpointCount; i++) {
    const idx = Math.floor((i / checkpointCount) * n);
    const cur = smoothPoints[idx];
    const next = smoothPoints[(idx + 1) % n];
    const dir = next.clone().sub(cur).normalize();
    checkpoints.push({ position: cur.clone(), forward: dir, radius: roadWidth * 0.8 });
  }

  const start = smoothPoints[0];
  const startNext = smoothPoints[1];
  const startDir = startNext.clone().sub(start).normalize();
  const startRotationY = Math.atan2(startDir.x, startDir.z);

  // Start/finish line marker
  const lineGeo = new THREE.PlaneGeometry(roadWidth, 1.5);
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const line = new THREE.Mesh(lineGeo, lineMat);
  line.rotation.x = -Math.PI / 2;
  line.position.copy(start).setY(0.02);
  line.rotation.z = -startRotationY;
  group.add(line);

  return {
    group,
    checkpoints,
    startPosition: start.clone().setY(0.6),
    startRotationY,
    groundBody,
    barrierBodies,
  };
}
