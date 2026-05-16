import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BUILDINGS, type BuildingDef } from './buildings';
import {
  SPACING, GRID, getHalf, setGridSize, gridToWorld, worldToGrid,
  canPlaceAt, markOccupied, clearOccupied, applyGhostMaterial,
  type Rotation, type PlacedBuilding, placedBuildings, addPlaced,
  rotate, setTileTypesRef,
} from './placement';
import {
  saveWorld as dbSaveWorld, loadWorld as dbLoadWorld,
  getWorldList, createWorld, deleteWorld, renameWorld, migrateFromLocalStorage,
  type SaveData, type WorldMeta,
} from './storage';
import { spawnNPC, despawnNPC, despawnAllNPCs, updateNPCs, npcs, buildNavGrid, SUB, invalidateNavCache, createLabel } from './npc';
import { playPlace, playDelete, playPaint, playUndo, playRedo } from './sound';

// ─── Renderer ────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
document.getElementById('app')!.appendChild(renderer.domElement);

// ─── Scene ───────────────────────────────────
const scene = new THREE.Scene();
const fogColor = new THREE.Color('#F2EFE9');
scene.background = fogColor;
scene.fog = new THREE.Fog(fogColor, 40, 80);

// ─── Camera ──────────────────────────────────
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.5, 120);
camera.position.set(14, 12, 14);
camera.lookAt(0, 0, 0);

// ─── Controls ────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
controls.update();

// ─── Lighting ────────────────────────────────
const ambient = new THREE.AmbientLight('#f0ebe0', 1.6);
const hemi = new THREE.HemisphereLight('#fff8f0', '#d8d0c4', 1.0);
scene.add(ambient);
scene.add(hemi);

const sun = new THREE.DirectionalLight('#fffdf5', 2.7);
sun.position.set(25, 35, 15);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.radius = 2.5;
sun.shadow.bias = -0.00015;
sun.shadow.normalBias = 0.02;
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 120;
sun.shadow.camera.left = -40;
sun.shadow.camera.right = 40;
sun.shadow.camera.top = 40;
sun.shadow.camera.bottom = -40;
scene.add(sun);

const moon = new THREE.DirectionalLight('#8899cc', 0);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
moon.shadow.radius = 4;
moon.shadow.bias = -0.0002;
moon.shadow.camera.near = 0.5;
moon.shadow.camera.far = 120;
moon.shadow.camera.left = -40;
moon.shadow.camera.right = 40;
moon.shadow.camera.top = 40;
moon.shadow.camera.bottom = -40;
scene.add(moon);

// Track street lamp point lights + house windows for night toggle
const streetLights: THREE.PointLight[] = [];
const houseWindows: THREE.Mesh[] = [];

// ─── World State ──────────────────────────────
let currentWorldId: string | null = null;
let currentWorldName = '我的第一个世界';

// ─── Time System ──────────────────────────────
let timeOfDay = 0.35; // Start ~8:24 AM
const DAY_LENGTH = 1200; // 20 real minutes = 1 game day
let timeSpeed = 1; // 1 = normal, 0 = paused

// ─── Sky Sphere ────────────────────────────────
const skyGeo = new THREE.SphereGeometry(55, 32, 32);
const skyMat = new THREE.ShaderMaterial({
  uniforms: {
    uTimeOfDay: { value: timeOfDay },
  },
  vertexShader: /* glsl */ `
    varying vec3 vWorldPos;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPos = worldPos.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec3 vWorldPos;
    uniform float uTimeOfDay;

    float hash(vec3 p) {
      float h = dot(p, vec3(127.1, 311.7, 74.7));
      return fract(sin(h) * 43758.5453);
    }

    void main() {
      vec3 dir = normalize(vWorldPos - cameraPosition);
      float y = clamp(dir.y, -1.0, 1.0);

      float sunAngle = (uTimeOfDay - 0.25) * 6.2831853;
      vec3 sunDir = normalize(vec3(cos(sunAngle) * 0.7, sin(sunAngle), cos(sunAngle) * 0.7));
      float sunElevation = sunDir.y;

      // Day sky (blue)
      vec3 dayHorizon = vec3(0.70, 0.80, 0.92);
      vec3 dayZenith  = vec3(0.30, 0.50, 0.80);
      float dayMix = smoothstep(-0.15, 0.45, y);
      vec3 daySky = mix(dayHorizon, dayZenith, dayMix);

      // Sunset sky (orange/pink near horizon)
      vec3 setHorizon = vec3(0.95, 0.55, 0.28);
      vec3 setZenith  = vec3(0.28, 0.22, 0.52);
      float setMix = smoothstep(-0.15, 0.45, y);
      vec3 setSky = mix(setHorizon, setZenith, setMix);

      // Night sky
      vec3 nightHorizon = vec3(0.04, 0.04, 0.09);
      vec3 nightZenith  = vec3(0.02, 0.02, 0.05);
      float nightMix = smoothstep(-0.1, 0.5, y);
      vec3 nightSky = mix(nightHorizon, nightZenith, nightMix);

      // Day weight: full day when sun is well above horizon
      float dayWeight = smoothstep(0.08, 0.25, sunElevation);
      // Sunset weight: only near horizon (sunrise + sunset)
      float sunsetWeight = smoothstep(-0.03, 0.08, sunElevation) * (1.0 - smoothstep(0.20, 0.35, sunElevation));

      // Start with night, layer sunset on top, then day on top
      vec3 sky = nightSky;
      sky = mix(sky, setSky, sunsetWeight);
      sky = mix(sky, daySky, dayWeight);

      // Sun glow
      float sunDot = dot(dir, sunDir);
      float glow = smoothstep(0.94, 1.0, sunDot) * smoothstep(-0.05, 0.2, sunElevation);
      sky += vec3(1.0, 0.85, 0.4) * glow * 2.0;

      // Stars
      float starVis = 1.0 - smoothstep(-0.15, 0.05, sunElevation);
      float star = step(0.997, hash(floor(dir * 400.0)));
      sky += star * starVis * 0.65 * vec3(0.9, 0.85, 1.0);

      gl_FragColor = vec4(sky, 1.0);
    }
  `,
  fog: false,
  side: THREE.BackSide,
  depthWrite: false,
});
const sky = new THREE.Mesh(skyGeo, skyMat);
sky.renderOrder = 1;
sky.material.depthTest = true;
scene.add(sky);

// ─── Day/Night Update ──────────────────────────
function updateDayNight(dt: number) {
  if (timeSpeed > 0) {
    timeOfDay = (timeOfDay + dt / DAY_LENGTH * timeSpeed) % 1.0;
  }

  const sunAngle = (timeOfDay - 0.25) * Math.PI * 2;
  const sunY = Math.sin(sunAngle);
  const sunX = Math.cos(sunAngle) * 0.7;
  const sunZ = Math.cos(sunAngle) * 0.7;
  const sunDist = 40;

  sun.position.set(sunX * sunDist, sunY * sunDist, sunZ * sunDist);

  // Sun intensity ramps when above horizon
  const sunIntensity = THREE.MathUtils.smoothstep(sunY, -0.05, 0.15) * 2.7;
  sun.intensity = sunIntensity;

  // Sun color warms near horizon
  const warmth = 1.0 - THREE.MathUtils.smoothstep(sunY, 0.0, 0.35);
  sun.color.set('#fffdf5').lerp(new THREE.Color('#ff8844'), warmth * 0.55);

  // Ambient — brighter during day
  ambient.intensity = 0.25 + THREE.MathUtils.smoothstep(sunY, -0.1, 0.3) * 1.35;
  ambient.color.set('#f0ebe0').lerp(new THREE.Color('#1a1a3a'), 1.0 - THREE.MathUtils.smoothstep(sunY, -0.15, 0.1));

  // Hemisphere follows sun
  hemi.intensity = 0.15 + THREE.MathUtils.smoothstep(sunY, -0.1, 0.3) * 0.85;
  hemi.color.set('#fff8f0').lerp(new THREE.Color('#2a2a4a'), 1.0 - THREE.MathUtils.smoothstep(sunY, -0.15, 0.1));
  hemi.groundColor.set('#d8d0c4').lerp(new THREE.Color('#0a0a15'), 1.0 - THREE.MathUtils.smoothstep(sunY, -0.15, 0.1));

  // Fog follows horizon
  const horizonColor = new THREE.Color('#F2EFE9').lerp(new THREE.Color('#0a0a15'), 1.0 - THREE.MathUtils.smoothstep(sunY, -0.15, 0.1));
  fogColor.copy(horizonColor);
  scene.background = fogColor;
  (scene.fog as THREE.Fog).color = fogColor;

  // Moon light (opposite to sun, active at night)
  moon.position.set(-sunX * 35, -sunY * 35, -sunZ * 35);
  moon.intensity = (1.0 - THREE.MathUtils.smoothstep(sunY, -0.2, 0.08)) * 3;

  // Street lamps: on ~17:00 (sunY < 0.26)
  const lampOn = sunY < 0.26 ? 5 : 0;
  streetLights.forEach(l => {
    l.intensity = lampOn;
    l.parent?.traverse(c => {
      if (c instanceof THREE.Mesh) {
        (c.material as THREE.MeshStandardMaterial).emissiveIntensity = lampOn > 0 ? 2 : 0.15;
      }
    });
  });

  // House windows: glow 17:00-24:00, off after midnight
  const houseLightOn = timeOfDay >= 0.708 ? 1.5 : 0.15;
  houseWindows.forEach(w => {
    (w.material as THREE.MeshStandardMaterial).emissiveIntensity = houseLightOn;
  });

  // Update sky shader
  skyMat.uniforms.uTimeOfDay.value = timeOfDay;
}

// ─── Firefly System ────────────────────────────
interface Firefly {
  sprite: THREE.Sprite;
  target: THREE.Vector3;
  phase: number;
  timer: number;
}

const fireflies: Firefly[] = [];
const FIREFLY_COUNT = 20;
let firefliesSpawned = false;

const fireflyTex = (() => {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,180,1)');
  g.addColorStop(0.15, 'rgba(255,240,140,0.8)');
  g.addColorStop(0.4, 'rgba(200,255,100,0.25)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
})();

function ensureFirefliesSpawned() {
  if (firefliesSpawned) return;
  for (let i = 0; i < FIREFLY_COUNT; i++) {
    const mat = new THREE.SpriteMaterial({
      map: fireflyTex,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      opacity: 0,
    });
    const sprite = new THREE.Sprite(mat);
    const [wx, wz] = gridToWorld(
      Math.floor(Math.random() * GRID),
      Math.floor(Math.random() * GRID),
    );
    sprite.position.set(
      wx + (Math.random() - 0.5) * SPACING,
      0.4 + Math.random() * 2.8,
      wz + (Math.random() - 0.5) * SPACING,
    );
    sprite.scale.set(0.35, 0.35, 1);
    scene.add(sprite);
    fireflies.push({
      sprite,
      target: sprite.position.clone(),
      phase: Math.random() * Math.PI * 2,
      timer: 1 + Math.random() * 3,
    });
  }
  firefliesSpawned = true;
}

function despawnFireflies() {
  fireflies.forEach(f => {
    scene.remove(f.sprite);
    (f.sprite.material as THREE.SpriteMaterial).dispose();
  });
  fireflies.length = 0;
  firefliesSpawned = false;
}

function fireflyFade(): number {
  // Fade in: 20:30 (0.854) → 21:30 (0.896)
  const fadeIn = THREE.MathUtils.smoothstep(timeOfDay, 0.854, 0.896);
  // Fade out: 4:30 (0.188) → 5:30 (0.229)
  const fadeOut = 1.0 - THREE.MathUtils.smoothstep(timeOfDay, 0.188, 0.229);

  // Inside the night window (21:00-5:00): use the appropriate edge
  if (timeOfDay > 0.875) return fadeIn;
  if (timeOfDay < 0.208) return fadeOut;

  // Outside window but near transitions: show fade tails
  if (timeOfDay > 0.84) return fadeIn;  // fading in before 21:00
  if (timeOfDay < 0.24) return fadeOut; // fading out after 5:00

  return 0;
}

function updateFireflies(dt: number) {
  const fade = fireflyFade();

  if (fade < 0.01) {
    if (firefliesSpawned) despawnFireflies();
    return;
  }

  ensureFirefliesSpawned();

  fireflies.forEach(f => {
    f.timer -= dt;
    if (f.timer <= 0) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 0.8 + Math.random() * 3.5;
      f.target.x = THREE.MathUtils.clamp(
        f.sprite.position.x + Math.cos(angle) * dist, -getHalf() - 0.5, getHalf() + 0.5,
      );
      f.target.z = THREE.MathUtils.clamp(
        f.sprite.position.z + Math.sin(angle) * dist, -getHalf() - 0.5, getHalf() + 0.5,
      );
      f.target.y = THREE.MathUtils.clamp(0.3 + Math.random() * 3.0, 0.2, 3.5);
      f.timer = 2 + Math.random() * 5;
    }

    f.sprite.position.lerp(f.target, dt * 0.55);
    f.phase += dt * (2.5 + Math.random() * 3);
    (f.sprite.material as THREE.SpriteMaterial).opacity =
      fade * (0.25 + Math.sin(f.phase) * 0.45);
  });
}

// ─── Ground Types ──────────────────────────────
const GROUND_TYPES = [
  { id: 'grass_dark',  name: '深色草地', color: '#c5d8b0' },
  { id: 'grass_light', name: '浅色草地', color: '#dce4cf' },
  { id: 'dirt',        name: '土地',     color: '#c0b090' },
  { id: 'road',        name: '道路',     color: '#d8d4ca' },
  { id: 'sand',        name: '沙滩',     color: '#e8dcc8' },
  { id: 'water',       name: '水',       color: '#5898c8' },
] as const;

// ─── Procedural Ground Textures ────────────────
function seededRand(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

function createGrassTex(light: boolean): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = seededRand(light ? 42 : 137);

  // Base fill
  ctx.fillStyle = light ? '#f6faf0' : '#f2f7eb';
  ctx.fillRect(0, 0, size, size);

  // Fine grass blades — many tiny short strokes
  for (let i = 0; i < 600; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const len = 2 + rand() * 4;
    const angle = rand() * Math.PI * 2;
    const shade = 195 + Math.floor(rand() * 45);
    ctx.strokeStyle = `rgb(${shade},${shade + 6},${shade - 8})`;
    ctx.lineWidth = 0.5 + rand() * 0.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    ctx.stroke();
  }

  // Darker specks
  for (let i = 0; i < 250; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const shade = 175 + Math.floor(rand() * 45);
    ctx.fillStyle = `rgba(${shade},${shade + 3},${shade - 10},0.55)`;
    ctx.fillRect(x, y, 1.2, 1.2);
  }

  return makeTex(canvas);
}

function createDirtTex(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = seededRand(256);

  ctx.fillStyle = '#f5f0e8';
  ctx.fillRect(0, 0, size, size);

  // Larger irregular patches
  for (let i = 0; i < 80; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 2 + rand() * 6;
    const shade = 210 + Math.floor(rand() * 40);
    ctx.fillStyle = `rgba(${shade},${shade - 4},${shade - 15},0.4)`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  // Fine grain
  for (let i = 0; i < 400; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const shade = 215 + Math.floor(rand() * 35);
    ctx.fillStyle = `rgba(${shade},${shade - 3},${shade - 12},0.5)`;
    ctx.fillRect(x, y, 1.5, 1.5);
  }

  // Occasional pebbles
  for (let i = 0; i < 30; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const shade = 195 + Math.floor(rand() * 40);
    ctx.fillStyle = `rgba(${shade},${shade - 2},${shade - 10},0.6)`;
    ctx.beginPath(); ctx.arc(x, y, 0.8 + rand() * 2, 0, Math.PI * 2); ctx.fill();
  }

  return makeTex(canvas);
}

function createRoadTex(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = seededRand(999);

  ctx.fillStyle = '#f4f2ee';
  ctx.fillRect(0, 0, size, size);

  // Cross-hatch wear streaks (horizontal + vertical)
  for (let i = 0; i < 40; i++) {
    const y = rand() * size;
    const shade = 225 + Math.floor(rand() * 25);
    ctx.strokeStyle = `rgba(${shade},${shade},${shade - 2},0.35)`;
    ctx.lineWidth = 1 + rand() * 2;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
  }
  for (let i = 0; i < 40; i++) {
    const x = rand() * size;
    const shade = 225 + Math.floor(rand() * 25);
    ctx.strokeStyle = `rgba(${shade},${shade},${shade - 2},0.35)`;
    ctx.lineWidth = 1 + rand() * 2;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size); ctx.stroke();
  }

  // Fine asphalt grain
  for (let i = 0; i < 500; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const shade = 220 + Math.floor(rand() * 30);
    ctx.fillStyle = `rgba(${shade},${shade},${shade - 2},0.55)`;
    ctx.fillRect(x, y, 1, 1);
  }

  // Tiny pebbles/cracks
  for (let i = 0; i < 15; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const shade = 200 + Math.floor(rand() * 30);
    ctx.fillStyle = `rgba(${shade},${shade},${shade - 1},0.5)`;
    ctx.beginPath(); ctx.arc(x, y, 0.5 + rand() * 1.5, 0, Math.PI * 2); ctx.fill();
  }

  return makeTex(canvas);
}

function createSandTex(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = seededRand(753);

  ctx.fillStyle = '#faf6ec';
  ctx.fillRect(0, 0, size, size);

  // Sand grain — dense fine dots
  for (let i = 0; i < 800; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const shade = 225 + Math.floor(rand() * 30);
    ctx.fillStyle = `rgba(${shade},${shade - 5},${shade - 18},0.6)`;
    ctx.fillRect(x, y, 1.2, 1.2);
  }

  // Slightly larger specks (tiny shells / pebbles)
  for (let i = 0; i < 60; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const shade = 235 + Math.floor(rand() * 20);
    ctx.fillStyle = `rgba(${shade},${shade - 2},${shade - 12},0.45)`;
    ctx.beginPath(); ctx.arc(x, y, 0.5 + rand() * 1.5, 0, Math.PI * 2); ctx.fill();
  }

  return makeTex(canvas);
}

function createWaterTex(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = seededRand(321);

  ctx.fillStyle = '#88bbdd';
  ctx.fillRect(0, 0, size, size);

  // Lighter ripple streaks
  for (let i = 0; i < 200; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const shade = 160 + Math.floor(rand() * 50);
    ctx.fillStyle = `rgba(${shade},${shade + 15},${shade + 35},0.3)`;
    ctx.fillRect(x, y, 2 + rand() * 3, 1 + rand() * 1.5);
  }

  // Specular highlights
  for (let i = 0; i < 40; i++) {
    const x = rand() * size;
    const y = rand() * size;
    ctx.fillStyle = `rgba(255,255,255,${0.08 + rand() * 0.12})`;
    ctx.beginPath(); ctx.arc(x, y, 0.5 + rand() * 2, 0, Math.PI * 2); ctx.fill();
  }

  return makeTex(canvas);
}

function makeTex(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

const groundTexMap: Record<string, THREE.CanvasTexture> = {
  grass_dark: createGrassTex(false),
  grass_light: createGrassTex(true),
  dirt: createDirtTex(),
  road: createRoadTex(),
  sand: createSandTex(),
  water: createWaterTex(),
};

function makeGroundMat(color: string, typeId: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, map: groundTexMap[typeId] });
}

// ─── Grid Ground (InstancedMesh) ──────────────
const sharedTileGeo = new THREE.BoxGeometry(SPACING * 0.95, 0.18, SPACING * 0.95);
const groundGroup = new THREE.Group();
scene.add(groundGroup);
const tileTypes: string[][] = []; // ground type id per cell — source of truth

// Initialize tileTypes with defaults
for (let tx = 0; tx < GRID; tx++) {
  tileTypes[tx] = [];
  for (let tz = 0; tz < GRID; tz++) {
    tileTypes[tx][tz] = (tx + tz) % 3 === 0 ? 'grass_dark' : 'grass_light';
  }
}
setTileTypesRef(tileTypes);

// ─── Water Wave Overlay ─────────────────────────
const waterWaveGroup = new THREE.Group();
scene.add(waterWaveGroup);
const waterTileMeshes: { mesh: THREE.Mesh; baseY: number; wx: number; wz: number }[] = [];
const tileSize = SPACING * 0.92;
const waterPlaneGeo = new THREE.PlaneGeometry(tileSize, tileSize);
waterPlaneGeo.rotateX(-Math.PI / 2);
const waterPlaneMat = new THREE.MeshPhongMaterial({
  color: '#4499cc',
  specular: '#88ccff',
  shininess: 60,
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
  side: THREE.DoubleSide,
});

function rebuildWaterWaves() {
  waterTileMeshes.forEach(t => { t.mesh.geometry.dispose(); waterWaveGroup.remove(t.mesh); });
  waterTileMeshes.length = 0;

  for (let tx = 0; tx < GRID; tx++) {
    for (let tz = 0; tz < GRID; tz++) {
      if (tileTypes[tx][tz] !== 'water') continue;
      const [wx, wz] = gridToWorld(tx, tz);
      const geo = waterPlaneGeo.clone();
      const mesh = new THREE.Mesh(geo, waterPlaneMat);
      mesh.position.set(wx, 0.13, wz);
      mesh.renderOrder = 1;
      waterWaveGroup.add(mesh);
      waterTileMeshes.push({ mesh, baseY: 0.13, wx, wz });
    }
  }
  console.log('Water waves rebuilt:', waterTileMeshes.length, 'tiles');
}

function rebuildGroundMeshes() {
  // Dispose old meshes (geometry is shared, only dispose materials)
  for (let i = groundGroup.children.length - 1; i >= 0; i--) {
    const child = groundGroup.children[i];
    if (child instanceof THREE.InstancedMesh) {
      (child.material as THREE.Material).dispose();
    }
    groundGroup.remove(child);
  }

  // Count tiles per type
  const counts: Record<string, number> = {};
  for (const gt of GROUND_TYPES) counts[gt.id] = 0;
  for (let tx = 0; tx < GRID; tx++)
    for (let tz = 0; tz < GRID; tz++)
      counts[tileTypes[tx][tz]]++;

  const dummy = new THREE.Object3D();
  for (const gt of GROUND_TYPES) {
    const count = counts[gt.id];
    if (count === 0) continue;
    const mat = gt.id === 'water'
      ? new THREE.MeshStandardMaterial({ color: gt.color, roughness: 0.3, metalness: 0.1, map: groundTexMap[gt.id], transparent: true, opacity: 0.55, depthWrite: false })
      : makeGroundMat(gt.color, gt.id);
    const im = new THREE.InstancedMesh(sharedTileGeo, mat, count);
    im.receiveShadow = true;
    im.castShadow = gt.id !== 'water';
    let i = 0;
    for (let tx = 0; tx < GRID; tx++) {
      for (let tz = 0; tz < GRID; tz++) {
        if (tileTypes[tx][tz] !== gt.id) continue;
        const [wx, wz] = gridToWorld(tx, tz);
        dummy.position.set(wx, 0, wz);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
        i++;
      }
    }
    im.instanceMatrix.needsUpdate = true;
    groundGroup.add(im);
  }
  rebuildWaterWaves();
}

rebuildGroundMeshes();

function rebuildGroundTiles() {
  const oldW = tileTypes.length;
  const oldD = oldW > 0 ? tileTypes[0].length : 0;
  const newW = GRID;
  // Allocate new array
  const fresh: string[][] = [];
  for (let tx = 0; tx < newW; tx++) {
    fresh[tx] = [];
    for (let tz = 0; tz < newW; tz++) {
      fresh[tx][tz] = (tx + tz) % 3 === 0 ? 'grass_dark' : 'grass_light';
    }
  }
  // Copy overlapping region
  for (let tx = 0; tx < Math.min(oldW, newW); tx++) {
    for (let tz = 0; tz < Math.min(oldD, newW); tz++) {
      if (tileTypes[tx] && tileTypes[tx][tz]) fresh[tx][tz] = tileTypes[tx][tz];
    }
  }
  tileTypes.length = 0;
  for (let tx = 0; tx < newW; tx++) tileTypes[tx] = fresh[tx];
  rebuildGroundMeshes();
}

// ─── World Templates ──────────────────────────
type TemplateId = 'empty' | 'seaside' | 'island';

interface WorldTemplate {
  id: TemplateId;
  name: string;
  description: string;
  generate(size: number): string[][];
}

const worldTemplates: WorldTemplate[] = [
  {
    id: 'empty',
    name: '空白平地',
    description: '全部草地，自由建造',
    generate(size) {
      const tiles: string[][] = [];
      for (let tx = 0; tx < size; tx++) {
        tiles[tx] = [];
        for (let tz = 0; tz < size; tz++) {
          tiles[tx][tz] = (tx + tz) % 3 === 0 ? 'grass_dark' : 'grass_light';
        }
      }
      return tiles;
    },
  },
  {
    id: 'seaside',
    name: '海滨',
    description: '一侧临海，有沙滩',
    generate(size) {
      const tiles: string[][] = [];
      const shoreEdge = Math.floor(size * 0.65);
      const sandWidth = Math.max(1, Math.floor(size * 0.15));
      for (let tx = 0; tx < size; tx++) {
        tiles[tx] = [];
        for (let tz = 0; tz < size; tz++) {
          if (tx >= shoreEdge && tz >= shoreEdge) {
            tiles[tx][tz] = 'water';
          } else if (tx >= shoreEdge - sandWidth || tz >= shoreEdge - sandWidth) {
            tiles[tx][tz] = 'sand';
          } else {
            tiles[tx][tz] = (tx + tz) % 3 === 0 ? 'grass_dark' : 'grass_light';
          }
        }
      }
      return tiles;
    },
  },
  {
    id: 'island',
    name: '小岛',
    description: '四面环水，沙滩环绕',
    generate(size) {
      const tiles: string[][] = [];
      const waterMargin = Math.max(1, Math.floor(size * 0.2));
      const sandMargin = waterMargin + Math.max(1, Math.floor(size * 0.1));
      for (let tx = 0; tx < size; tx++) {
        tiles[tx] = [];
        for (let tz = 0; tz < size; tz++) {
          const distToEdge = Math.min(tx, tz, size - 1 - tx, size - 1 - tz);
          if (distToEdge < waterMargin) {
            tiles[tx][tz] = 'water';
          } else if (distToEdge < sandMargin) {
            tiles[tx][tz] = 'sand';
          } else {
            tiles[tx][tz] = (tx + tz) % 3 === 0 ? 'grass_dark' : 'grass_light';
          }
        }
      }
      return tiles;
    },
  },
];

function applyTemplate(templateId: TemplateId) {
  const tpl = worldTemplates.find(t => t.id === templateId) ?? worldTemplates[0];
  const newTiles = tpl.generate(GRID);
  for (let tx = 0; tx < GRID; tx++) {
    tileTypes[tx] = newTiles[tx];
  }
  rebuildGroundMeshes();
  invalidateNavCache();
}

// ─── Post-Processing (Bokeh DOF) ─────────────
const renderPass = new RenderPass(scene, camera);
const composer = new EffectComposer(renderer);
composer.addPass(renderPass);

const focusDist = camera.position.distanceTo(new THREE.Vector3(0, 0, 0));
const bokehPass = new BokehPass(scene, camera, {
  focus: focusDist,
  aperture: 0.0006,
  maxblur: 0.014,
});
composer.addPass(bokehPass);

// ─── Raycaster (ground plane only) ───────────
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function getGridHit(event: MouseEvent): [number, number] | null {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const hit = new THREE.Vector3();
  const ok = raycaster.ray.intersectPlane(groundPlane, hit);
  if (!ok) return null;
  const [gx, gz] = worldToGrid(hit.x, hit.z);
  if (gx < 0 || gx >= GRID || gz < 0 || gz >= GRID) return null;
  return [gx, gz];
}

// ─── Ghost Preview ───────────────────────────
let ghost: THREE.Group | null = null;
let selectedDef: BuildingDef | null = null;
let selectedRotation: Rotation = 0;
let lastPlacedDefId: string | null = null;
let selectedGroundType: string | null = null;

function paintTile(gx: number, gz: number, typeId: string) {
  const oldType = tileTypes[gx][gz];
  if (oldType === typeId) return;
  recordAction({ type: 'paint', gx, gz, oldType, newType: typeId });
  tileTypes[gx][gz] = typeId;
  rebuildGroundMeshes();
  invalidateNavCache();
  saveWorld();
  playPaint();
}

const ghostOk = new THREE.MeshStandardMaterial({
  color: '#44aa44', roughness: 0.5, metalness: 0,
  transparent: true, opacity: 0.45, depthWrite: false,
});
const ghostBad = new THREE.MeshStandardMaterial({
  color: '#cc4444', roughness: 0.5, metalness: 0,
  transparent: true, opacity: 0.45, depthWrite: false,
});

function updateGhost(gx: number, gz: number) {
  if (!ghost || !selectedDef) return;
  const { gridW, gridD } = rotate(selectedDef, selectedRotation);
  const ok = canPlaceAt(gx, gz, gridW, gridD);
  applyGhostMaterial(ghost, ok ? ghostOk : ghostBad);

  // Place ghost centered on footprint
  const cx = (gx + (gridW - 1) / 2) * SPACING - getHalf();
  const cz = (gz + (gridD - 1) / 2) * SPACING - getHalf();
  ghost.position.set(cx, 0, cz);
  ghost.visible = true;

  // Rotation
  ghost.rotation.y = THREE.MathUtils.degToRad(selectedRotation);
}

function clearGhost() {
  if (ghost) {
    scene.remove(ghost);
    ghost.traverse(c => {
      if (c instanceof THREE.Mesh) c.geometry.dispose();
    });
    ghost = null;
  }
  selectedDef = null;
  selectedRotation = 0;
}

// ─── Undo / Redo ────────────────────────────
interface HistoryAction {
  type: 'place' | 'delete' | 'paint';
  gx: number;
  gz: number;
  defId?: string;
  rotation?: number;
  oldType?: string;
  newType?: string;
  // For restoring deleted buildings + their NPCs
  npcSaveData?: { name: string; skinColor: string; clothColor: string; homeW: number; homeD: number; defId?: string } | null;
}

const undoStack: HistoryAction[] = [];
const redoStack: HistoryAction[] = [];
const MAX_HISTORY = 50;
let undoRedoing = false; // guard to prevent recursive recording

function recordAction(action: HistoryAction) {
  if (undoRedoing) return;
  undoStack.push(action);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
}

function performUndo() {
  if (undoStack.length === 0) return;
  playUndo();
  undoRedoing = true;
  const action = undoStack.pop()!;
  redoStack.push(action);

  if (action.type === 'place') {
    // Undo place = remove the building
    const pb = placedBuildings.find(b =>
      b.gx === action.gx && b.gz === action.gz && b.def.id === action.defId,
    );
    if (pb) removePlacedBuilding(pb, true);
  } else if (action.type === 'delete') {
    // Undo delete = recreate the building
    const def = BUILDINGS.find(b => b.id === action.defId);
    if (!def) { undoRedoing = false; return; }
    const inst = def.factory(def.defaultOpts);
    mergeGroupMeshes(inst);
    const rot = action.rotation ?? 0;
    const { gridW, gridD } = rotate(def, rot as Rotation);
    const cx = (action.gx + (gridW - 1) / 2) * SPACING - getHalf();
    const cz = (action.gz + (gridD - 1) / 2) * SPACING - getHalf();
    inst.position.set(cx, 0, cz);
    inst.rotation.y = THREE.MathUtils.degToRad(rot);
    scene.add(inst);
    markOccupied(action.gx, action.gz, gridW, gridD);
    const placed: PlacedBuilding = {
      id: Date.now() + Math.random(),
      def, gx: action.gx, gz: action.gz,
      rotation: rot as Rotation,
      group: inst,
    };
    addPlaced(placed);
    if (def.id === 'fence') connectFences(action.gx, action.gz, inst);
    if (def.id === 'street_lamp') {
      inst.traverse(c => {
        if (c instanceof THREE.PointLight && c.userData.isStreetLight) streetLights.push(c);
      });
    }
    inst.traverse(c => {
      if (c instanceof THREE.Mesh && c.userData.isHouseWindow) houseWindows.push(c);
    });
    if (def.category === 'house' && action.npcSaveData) {
      const nd = action.npcSaveData;
      spawnNPC(action.gx, action.gz, nd.homeW, nd.homeD, scene, timeOfDay, action.defId,
        nd.name, nd.skinColor, nd.clothColor, rot as Rotation,
      );
    }
    invalidateNavCache();
    saveWorld();
  } else if (action.type === 'paint') {
    // Undo paint = restore old type
    tileTypes[action.gx][action.gz] = action.oldType!;
    rebuildGroundMeshes();
    invalidateNavCache();
    saveWorld();
  }

  undoRedoing = false;
}

function performRedo() {
  if (redoStack.length === 0) return;
  playRedo();
  undoRedoing = true;
  const action = redoStack.pop()!;
  undoStack.push(action);

  if (action.type === 'place') {
    // Redo place = recreate the building
    const def = BUILDINGS.find(b => b.id === action.defId);
    if (!def) { undoRedoing = false; return; }
    const inst = def.factory(def.defaultOpts);
    mergeGroupMeshes(inst);
    const rot = action.rotation ?? 0;
    const { gridW, gridD } = rotate(def, rot as Rotation);
    const cx = (action.gx + (gridW - 1) / 2) * SPACING - getHalf();
    const cz = (action.gz + (gridD - 1) / 2) * SPACING - getHalf();
    inst.position.set(cx, 0, cz);
    inst.rotation.y = THREE.MathUtils.degToRad(rot);
    scene.add(inst);
    markOccupied(action.gx, action.gz, gridW, gridD);
    const placed: PlacedBuilding = {
      id: Date.now() + Math.random(),
      def, gx: action.gx, gz: action.gz,
      rotation: rot as Rotation,
      group: inst,
    };
    addPlaced(placed);
    if (def.id === 'fence') connectFences(action.gx, action.gz, inst);
    if (def.id === 'street_lamp') {
      inst.traverse(c => {
        if (c instanceof THREE.PointLight && c.userData.isStreetLight) streetLights.push(c);
      });
    }
    inst.traverse(c => {
      if (c instanceof THREE.Mesh && c.userData.isHouseWindow) houseWindows.push(c);
    });
    if (def.category === 'house' && action.npcSaveData) {
      const nd = action.npcSaveData;
      spawnNPC(action.gx, action.gz, nd.homeW, nd.homeD, scene, timeOfDay, action.defId,
        nd.name, nd.skinColor, nd.clothColor, rot as Rotation,
      );
    }
    invalidateNavCache();
    saveWorld();
  } else if (action.type === 'delete') {
    // Redo delete = remove the building
    const pb = placedBuildings.find(b =>
      b.gx === action.gx && b.gz === action.gz && b.def.id === action.defId,
    );
    if (pb) removePlacedBuilding(pb, true);
  } else if (action.type === 'paint') {
    tileTypes[action.gx][action.gz] = action.newType!;
    rebuildGroundMeshes();
    invalidateNavCache();
    saveWorld();
  }

  undoRedoing = false;
}

// ─── Geometry Merge ──────────────────────────
function mergeGroupMeshes(group: THREE.Group) {
  group.updateWorldMatrix(true, true);
  const buckets = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
  const removals: THREE.Mesh[] = [];
  const invGroupWorld = group.matrixWorld.clone().invert();

  group.traverse(child => {
    if (!(child instanceof THREE.Mesh) || child.userData.noMerge) return;
    const geo = child.geometry.clone();
    const localMatrix = invGroupWorld.clone().multiply(child.matrixWorld);
    geo.applyMatrix4(localMatrix);
    const key = child.material.uuid;
    if (!buckets.has(key)) buckets.set(key, { material: child.material, geometries: [] });
    buckets.get(key)!.geometries.push(geo);
    removals.push(child);
  });

  removals.forEach(m => { if (m.parent) m.parent.remove(m); });

  buckets.forEach(({ material, geometries }) => {
    const merged = mergeGeometries(geometries, false);
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  });
}

// ─── Place Building ──────────────────────────
function placeBuilding(gx: number, gz: number) {
  if (!selectedDef) return;
  const { gridW, gridD } = rotate(selectedDef, selectedRotation);
  if (!canPlaceAt(gx, gz, gridW, gridD)) return;

  const inst = selectedDef.factory(selectedDef.defaultOpts);
  mergeGroupMeshes(inst);
  const cx = (gx + (gridW - 1) / 2) * SPACING - getHalf();
  const cz = (gz + (gridD - 1) / 2) * SPACING - getHalf();
  inst.position.set(cx, 0, cz);
  inst.rotation.y = THREE.MathUtils.degToRad(selectedRotation);
  scene.add(inst);

  const placed: PlacedBuilding = {
    id: Date.now(),
    def: selectedDef,
    gx, gz,
    rotation: selectedRotation,
    group: inst,
  };
  addPlaced(placed);
  lastPlacedDefId = selectedDef.id;

  // Fence auto-connect
  if (selectedDef.id === 'fence') connectFences(gx, gz, inst);

  // Collect street lamp lights + house windows
  if (selectedDef.id === 'street_lamp') {
    inst.traverse(c => {
      if (c instanceof THREE.PointLight && c.userData.isStreetLight) streetLights.push(c);
    });
  }
  inst.traverse(c => {
    if (c instanceof THREE.Mesh && c.userData.isHouseWindow) houseWindows.push(c);
  });

  // Spawn NPC for house buildings
  let npcSaveData = null;
  if (selectedDef.category === 'house') {
    const { gridW, gridD } = rotate(selectedDef, selectedRotation);
    const npc = spawnNPC(gx, gz, gridW, gridD, scene, timeOfDay, selectedDef.id, undefined, undefined, undefined, selectedRotation);
    npcSaveData = { name: npc.name, skinColor: npc.skinColor, clothColor: npc.clothColor, homeW: gridW, homeD: gridD, defId: selectedDef.id };
    // Sync plaque text with NPC name for buildings that have plaques
    updatePlaqueText(inst, npc.name);
  }

  recordAction({ type: 'place', gx, gz, defId: selectedDef.id, rotation: selectedRotation, npcSaveData });

  invalidateNavCache();
  saveWorld();
  if (!undoRedoing) playPlace();
}

// ─── Fence Connection ────────────────────────
const railMat = new THREE.MeshStandardMaterial({ color: '#e0d8cc', roughness: 0.9, metalness: 0 });
const railGeoX = new THREE.BoxGeometry(SPACING, 0.06, 0.06);
const railGeoZ = new THREE.BoxGeometry(0.06, 0.06, SPACING);

function connectFencePair(
  group: THREE.Group, gx: number, gz: number,
  neighbor: PlacedBuilding, dx: number, dz: number,
  axis: 'x' | 'z',
) {
  const geo = (axis === 'x' ? railGeoX : railGeoZ).clone();
  [0.85, 0.35].forEach(y => {
    const rail = new THREE.Mesh(geo, railMat);
    rail.position.set(dx * SPACING / 2, y, dz * SPACING / 2);
    rail.castShadow = true; rail.receiveShadow = true;
    group.add(rail);
  });
  const oppGeo = (axis === 'x' ? railGeoX : railGeoZ).clone();
  [0.85, 0.35].forEach(y => {
    const rail = new THREE.Mesh(oppGeo, railMat);
    rail.position.set(-dx * SPACING / 2, y, -dz * SPACING / 2);
    rail.castShadow = true; rail.receiveShadow = true;
    neighbor.group.add(rail);
  });
}

function connectFences(gx: number, gz: number, group: THREE.Group) {
  const dirs: [number, number, 'x' | 'z'][] = [[1, 0, 'x'], [-1, 0, 'x'], [0, 1, 'z'], [0, -1, 'z']];
  dirs.forEach(([dx, dz, axis]) => {
    const neighbor = placedBuildings.find(
      b => b.def.id === 'fence' && b.gx === gx + dx && b.gz === gz + dz,
    );
    if (neighbor) connectFencePair(group, gx, gz, neighbor, dx, dz, axis);
  });
}

// ─── Mouse / Keyboard ────────────────────────
let pointerDown: { x: number; y: number; button: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  pointerDown = { x: e.clientX, y: e.clientY, button: e.button };
});

let lastMouse = { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 };
window.addEventListener('mousemove', (e) => {
  lastMouse = { clientX: e.clientX, clientY: e.clientY };
  if (!ghost || !selectedDef) return;
  const hit = getGridHit(e);
  if (hit) updateGhost(hit[0], hit[1]);
  else ghost.visible = false;
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  if (e.target !== renderer.domElement) return;
  // Ignore drags
  if (pointerDown && (Math.abs(e.clientX - pointerDown.x) > 4 || Math.abs(e.clientY - pointerDown.y) > 4)) {
    pointerDown = null;
    return;
  }
  pointerDown = null;
  const hit = getGridHit(e);
  if (!hit) return;
  const [gx, gz] = hit;

  // Ground painting mode
  if (selectedGroundType && !ghost) {
    paintTile(gx, gz, selectedGroundType);
    return;
  }

  // Building placement mode
  if (ghost && selectedDef) {
    const { gridW, gridD } = rotate(selectedDef, selectedRotation);
    if (canPlaceAt(gx, gz, gridW, gridD)) {
      placeBuilding(gx, gz);
      clearGhost();
      updateCatalogButtons();
    }
  }
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key === 'r' || e.key === 'R') {
    if (selectedDef && ghost) {
      selectedRotation = ((selectedRotation + 90) % 360) as Rotation;
      const fakeEvent = { clientX: lastMouse.clientX, clientY: lastMouse.clientY } as MouseEvent;
      const hit = getGridHit(fakeEvent);
      if (hit) updateGhost(hit[0], hit[1]);
    }
  }
  if (e.key === 'Escape') {
    clearGhost();
    updateCatalogButtons();
    selectedGroundType = null;
    groundSwatches.forEach(s => { s.style.borderColor = 'transparent'; s.style.transform = 'scale(1)'; });
  }
  if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    performUndo();
  }
  if (e.ctrlKey && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault();
    performRedo();
  }
  if (e.key === 'h' || e.key === 'H') {
    toggleHUD();
  }
  if (e.key === 'p' || e.key === 'P') {
    showTutorial();
  }
  if (e.key === 'n' || e.key === 'N') {
    toggleNavDebug();
  }
  if (e.key === 'e' || e.key === 'E') {
    if (!ghost && lastPlacedDefId) {
      const def = BUILDINGS.find(b => b.id === lastPlacedDefId);
      if (def) {
        // Switch to matching category tab if needed
        if (def.category !== activeCategory) {
          activeCategory = def.category;
          const ci = categories.findIndex(c => c.key === def.category);
          catLabels.forEach((s, j) => {
            s.style.color = j === ci ? '#555' : '#bbb';
            s.style.fontWeight = j === ci ? '600' : '400';
          });
          renderCatalog();
        }
        selectedDef = def;
        selectedRotation = 0;
        ghost = def.factory(def.defaultOpts);
        ghost.traverse(c => { if (c instanceof THREE.Mesh) (c.material as THREE.Material).dispose(); });
        applyGhostMaterial(ghost, ghostOk);
        ghost.visible = false;
        scene.add(ghost);
        updateCatalogButtons();
        // Update ghost position with current mouse
        const fakeEvent = { clientX: lastMouse.clientX, clientY: lastMouse.clientY } as MouseEvent;
        const hit = getGridHit(fakeEvent);
        if (hit) updateGhost(hit[0], hit[1]);
      }
    }
  }
});

// ─── Save / Load ──────────────────────────────
function buildSaveData(): SaveData {
  return {
    version: 1,
    timeOfDay,
    buildings: placedBuildings.map(b => ({
      defId: b.def.id,
      gx: b.gx,
      gz: b.gz,
      rotation: b.rotation,
      ...(b.customName ? { customName: b.customName } : {}),
    })),
    tiles: tileTypes,
    npcs: npcs.map(n => ({
      id: n.id,
      name: n.name,
      homeGx: n.homeGx,
      homeGz: n.homeGz,
      homeW: n.homeW,
      homeD: n.homeD,
      homeDefId: n.homeDefId,
      skinColor: n.skinColor,
      clothColor: n.clothColor,
    })),
  };
}

let savePending = false;
function saveWorld(): Promise<void> {
  if (!currentWorldId) return Promise.resolve();
  if (savePending) return Promise.resolve();
  savePending = true;
  const data = buildSaveData();

  // Capture thumbnail (debounced, falls back to last captured)
  const thumbnail = captureWorldThumbnail();
  if (thumbnail) {
    data.thumbnail = thumbnail;
  } else if (lastThumbnailDataUrl) {
    data.thumbnail = lastThumbnailDataUrl;
  }

  return dbSaveWorld(currentWorldId, currentWorldName, data).then(() => {
    savePending = false;
  }).catch((err) => {
    savePending = false;
    console.warn('World save failed:', err);
  });
}

function restoreWorld(data: SaveData) {
  if (data.timeOfDay !== undefined) timeOfDay = data.timeOfDay;
  // Restore ground tiles
  if (data.tiles) {
    for (let tx = 0; tx < GRID; tx++) {
      for (let tz = 0; tz < GRID; tz++) {
        const typeId = data.tiles[tx]?.[tz] ?? tileTypes[tx][tz];
        tileTypes[tx][tz] = typeId;
      }
    }
  }
  rebuildGroundMeshes();
  // Restore buildings
  if (data.buildings) {
    data.buildings.forEach(({ defId, gx, gz, rotation, customName }) => {
      const def = BUILDINGS.find(b => b.id === defId);
      if (!def) return;
      const inst = def.factory(def.defaultOpts);
      mergeGroupMeshes(inst);
      const { gridW, gridD } = rotate(def, rotation as Rotation);
      const cx = (gx + (gridW - 1) / 2) * SPACING - getHalf();
      const cz = (gz + (gridD - 1) / 2) * SPACING - getHalf();
      inst.position.set(cx, 0, cz);
      inst.rotation.y = THREE.MathUtils.degToRad(rotation);
      scene.add(inst);
      addPlaced({ id: Date.now() + Math.random(), def, gx, gz, rotation: rotation as Rotation, group: inst, customName });
      if (def.id === 'fence') connectFences(gx, gz, inst);
      if (def.id === 'street_lamp') {
        inst.traverse(c => {
          if (c instanceof THREE.PointLight && c.userData.isStreetLight) streetLights.push(c);
        });
      }
      inst.traverse(c => {
        if (c instanceof THREE.Mesh && c.userData.isHouseWindow) houseWindows.push(c);
      });
    });
  }
  // Restore NPCs
  if (data.npcs) {
    data.npcs.forEach(n => {
      spawnNPC(n.homeGx, n.homeGz, n.homeW ?? 1, n.homeD ?? 1, scene, data.timeOfDay, n.homeDefId ?? 'small_wooden_house', n.name, n.skinColor, n.clothColor);
    });
    // Sync plaque text: customName > NPC name
    npcs.forEach(n => {
      const pb = placedBuildings.find(b =>
        b.gx === n.homeGx && b.gz === n.homeGz && b.def.id === n.homeDefId
      );
      if (pb) updatePlaqueText(pb.group, pb.customName ?? n.name);
    });
  }
  // Sync plaques for buildings with customName (workshop/bakery have no NPC)
  placedBuildings.forEach(pb => {
    if (pb.customName) updatePlaqueText(pb.group, pb.customName);
  });
}

function switchToWorld(id: string, name: string, data: SaveData) {
  // Set grid size from saved data (default 12 for backwards compat)
  setGridSize(data.gridSize ?? 12);
  rebuildGroundTiles();
  // Clear current world
  clearGhost();
  updateCatalogButtons();
  selectedGroundType = null;
  groundSwatches.forEach(s => { s.style.borderColor = 'transparent'; s.style.transform = 'scale(1)'; });
  undoRedoing = true; // suppress recordAction + sound during bulk clear
  while (placedBuildings.length > 0) removePlacedBuilding(placedBuildings[0], true);
  undoRedoing = false;
  streetLights.length = 0;
  houseWindows.length = 0;
  despawnFireflies();
  despawnAllNPCs();
  // Reset tiles to default
  for (let tx = 0; tx < GRID; tx++) {
    for (let tz = 0; tz < GRID; tz++) {
      tileTypes[tx][tz] = (tx + tz) % 3 === 0 ? 'grass_dark' : 'grass_light';
    }
  }
  // Load new world
  currentWorldId = id;
  currentWorldName = name;
  restoreWorld(data);
  // Reset thumbnail state for the new world
  lastThumbnailDataUrl = data.thumbnail ?? null;
  lastThumbnailTime = 0;
  invalidateNavCache();
  updateWorldLabel();
}

// Auto-save on exit + every 60 seconds
window.addEventListener('beforeunload', () => {
  if (!currentWorldId) return;
  const data = buildSaveData();
  if (lastThumbnailDataUrl) data.thumbnail = lastThumbnailDataUrl;
  // Sync save on exit (use localStorage as fallback for reliability)
  dbSaveWorld(currentWorldId, currentWorldName, data).catch(() => {
    localStorage.setItem('voxel_exit_save', JSON.stringify({ id: currentWorldId, name: currentWorldName, data }));
  });
});
setInterval(saveWorld, 60_000);

// ─── Plaque Text Update ───────────────────────
function updatePlaqueText(group: THREE.Group, text: string) {
  group.traverse(child => {
    if (!(child instanceof THREE.Mesh) || !child.userData.isPlaque) return;
    const mat = child.material as THREE.MeshBasicMaterial;
    if (!mat.map) return;
    const src = mat.map.image as HTMLCanvasElement;
    const font = (child.userData.plaqueFont as string) || 'bold 48px "Segoe UI Emoji", "Segoe UI", system-ui, sans-serif';
    const canvas = document.createElement('canvas');
    canvas.width = src.width;
    canvas.height = src.height;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#5a4030';
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    mat.map.dispose();
    mat.map = new THREE.CanvasTexture(canvas);
    mat.map.minFilter = THREE.LinearFilter;
    mat.needsUpdate = true;
  });
}

// ─── Right-Click Deletion ─────────────────────
function removePlacedBuilding(pb: PlacedBuilding, skipSave = false) {
  // Capture NPC data for undo before removing
  let npcSaveData = null;
  if (!undoRedoing && pb.def.category === 'house') {
    const bound = npcs.find(n => n.homeGx === pb.gx && n.homeGz === pb.gz);
    if (bound) {
      npcSaveData = { name: bound.name, skinColor: bound.skinColor, clothColor: bound.clothColor, homeW: bound.homeW, homeD: bound.homeD, defId: bound.homeDefId };
    }
  }
  if (!undoRedoing) {
    recordAction({ type: 'delete', gx: pb.gx, gz: pb.gz, defId: pb.def.id, rotation: pb.rotation, npcSaveData });
  }

  const { gridW, gridD } = rotate(pb.def, pb.rotation);
  clearOccupied(pb.gx, pb.gz, gridW, gridD);
  scene.remove(pb.group);
  pb.group.traverse(c => {
    if (c instanceof THREE.Mesh) {
      c.geometry.dispose();
      if (c.material !== railMat) {
        const mat = c.material as THREE.Material;
        if ('map' in mat && mat.map) mat.map.dispose();
        mat.dispose();
      }
    }
    if (c instanceof THREE.PointLight && c.userData.isStreetLight) {
      const idx = streetLights.indexOf(c);
      if (idx !== -1) streetLights.splice(idx, 1);
    }
    if (c instanceof THREE.Sprite) {
      (c.material as THREE.SpriteMaterial).map?.dispose();
      (c.material as THREE.SpriteMaterial).dispose();
    }
  });
  const idx = placedBuildings.indexOf(pb);
  if (idx !== -1) placedBuildings.splice(idx, 1);

  // Remove bound NPC if this was a house
  if (pb.def.category === 'house') {
    const bound = npcs.filter(n => n.homeGx === pb.gx && n.homeGz === pb.gz);
    bound.forEach(n => {
      n.group.removeFromParent();
      despawnNPC(n);
    });
  }

  invalidateNavCache();
  if (!skipSave) saveWorld();
  if (!undoRedoing) playDelete();
}

function showDeleteConfirm(pb: PlacedBuilding, cx: number, cy: number) {
  // Remove any existing confirm dialog + cleanup its window listener
  document.querySelectorAll('.delete-confirm').forEach(el => {
    const closerFn = (el as any).__closer as ((ev: MouseEvent) => void) | undefined;
    if (closerFn) window.removeEventListener('click', closerFn);
    el.remove();
  });

  // Check if this is a house with a bound NPC (for rename option)
  const boundNpc = pb.def.category === 'house'
    ? npcs.find(n => {
        // Exact home match
        if (n.homeGx === pb.gx && n.homeGz === pb.gz) return true;
        // Fallback: footprint overlap (handles multi-cell houses / rotation)
        const w = pb.rotation === 90 || pb.rotation === 270 ? pb.def.gridD : pb.def.gridW;
        const d = pb.rotation === 90 || pb.rotation === 270 ? pb.def.gridW : pb.def.gridD;
        return n.homeGx >= pb.gx && n.homeGx < pb.gx + w && n.homeGz >= pb.gz && n.homeGz < pb.gz + d;
      })
    : null;

  // Check if this building has a plaque (for building rename option)
  let hasPlaque = false;
  pb.group.traverse(c => { if (c instanceof THREE.Mesh && c.userData.isPlaque) hasPlaque = true; });

  const dlg = document.createElement('div');
  dlg.className = 'delete-confirm';
  dlg.style.cssText = `
    position:fixed; z-index:100; left:${cx}px; top:${cy}px;
    transform:translate(-50%, -120%);
    background:rgba(255,255,255,0.97);
    border-radius:8px; padding:10px 14px;
    box-shadow:0 2px 12px rgba(0,0,0,0.12);
    font-family:${FONT}; font-size:12px; color:#555;
    display:flex; flex-direction:column; gap:6px;
    pointer-events:auto;
  `;

  const renderMain = () => {
    const npcLabel = boundNpc ? `改居民名` : '';
    const buildingLabel = hasPlaque ? '改建筑名' : '';
    dlg.innerHTML = `
      <span>${boundNpc ? `<b>${escapeHtml(boundNpc.name)}</b> · ` : ''}${escapeHtml(pb.def.name)}</span>
      <div style="display:flex;gap:6px;justify-content:flex-end;">
        <button class="del-cancel" style="
          padding:3px 10px; border:1px solid #ddd; border-radius:4px;
          background:#fff; color:#888; cursor:pointer; font-size:11px;
        ">取消</button>
        ${boundNpc ? `<button class="rename-btn" style="
          padding:3px 10px; border:1px solid #c8d0e0; border-radius:4px;
          background:#fff; color:#6688aa; cursor:pointer; font-size:11px;
        ">${npcLabel}</button>` : ''}
        ${hasPlaque ? `<button class="rename-building-btn" style="
          padding:3px 10px; border:1px solid #c8d0c0; border-radius:4px;
          background:#fff; color:#8a8870; cursor:pointer; font-size:11px;
        ">${buildingLabel}</button>` : ''}
        <button class="del-ok" style="
          padding:3px 10px; border:none; border-radius:4px;
          background:#e07070; color:#fff; cursor:pointer; font-size:11px;
        ">删除</button>
      </div>
    `;

    dlg.querySelector('.del-cancel')!.addEventListener('click', closeDlg);
    dlg.querySelector('.del-ok')!.addEventListener('click', () => {
      closeDlg();
      removePlacedBuilding(pb);
      const fences = placedBuildings.filter(b => b.def.id === 'fence');
      fences.forEach(b => {
        const rails: THREE.Object3D[] = [];
        b.group.traverse(c => { if (c instanceof THREE.Mesh && !c.userData.isFencePost) rails.push(c); });
        rails.forEach(r => { b.group.remove(r); });
      });
      const done = new Set<string>();
      const dirs: [number, number, 'x' | 'z'][] = [[1, 0, 'x'], [-1, 0, 'x'], [0, 1, 'z'], [0, -1, 'z']];
      fences.forEach(b => {
        dirs.forEach(([dx, dz, axis]) => {
          const nb = fences.find(f => f.gx === b.gx + dx && f.gz === b.gz + dz);
          if (!nb) return;
          const key = `${Math.min(b.gx, nb.gx)},${Math.min(b.gz, nb.gz)}-${Math.max(b.gx, nb.gx)},${Math.max(b.gz, nb.gz)}`;
          if (done.has(key)) return;
          done.add(key);
          connectFencePair(b.group, b.gx, b.gz, nb, dx, dz, axis);
        });
      });
    });

    if (boundNpc) {
      dlg.querySelector('.rename-btn')!.addEventListener('click', () => {
        ignoreClose = true;
        renderRename();
      });
    }

    if (hasPlaque) {
      dlg.querySelector('.rename-building-btn')!.addEventListener('click', () => {
        ignoreClose = true;
        renderRenameBuilding();
      });
    }
  };

  const renderRename = () => {
    dlg.innerHTML = `
      <span style="font-size:11px;color:#888;">为 <b>${pb.def.name}</b> 的居民改名</span>
      <input class="rename-input" value="${escapeHtml(boundNpc!.name)}" style="
        padding:4px 8px; border:1px solid #d0d4d8; border-radius:4px;
        font-size:12px; font-family:${FONT}; outline:none; width:140px;
      " maxlength="8">
      <div style="display:flex;gap:6px;justify-content:flex-end;">
        <button class="rename-cancel" style="
          padding:3px 10px; border:1px solid #ddd; border-radius:4px;
          background:#fff; color:#888; cursor:pointer; font-size:11px;
        ">取消</button>
        <button class="rename-ok" style="
          padding:3px 10px; border:none; border-radius:4px;
          background:#88a8c0; color:#fff; cursor:pointer; font-size:11px;
        ">确认</button>
      </div>
    `;

    const input = dlg.querySelector('.rename-input') as HTMLInputElement;
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmRename();
      if (e.key === 'Escape') renderMain();
    });

    dlg.querySelector('.rename-cancel')!.addEventListener('click', () => {
      ignoreClose = true;
      renderMain();
    });
    dlg.querySelector('.rename-ok')!.addEventListener('click', () => {
      ignoreClose = true;
      confirmRename();
    });

    function confirmRename() {
      const newName = input.value.trim() || boundNpc!.name;
      if (newName !== boundNpc!.name) {
        boundNpc!.name = newName;
        // Replace label sprite
        boundNpc!.group.remove(boundNpc!.label);
        (boundNpc!.label.material as THREE.SpriteMaterial).map?.dispose();
        (boundNpc!.label.material as THREE.SpriteMaterial).dispose();
        boundNpc!.label = createLabel(newName);
        boundNpc!.group.add(boundNpc!.label);
        // Update plaque only if building has no custom name
        const homePb = placedBuildings.find(b =>
          b.gx === boundNpc!.homeGx && b.gz === boundNpc!.homeGz &&
          b.def.id === boundNpc!.homeDefId
        );
        if (homePb && !homePb.customName) updatePlaqueText(homePb.group, newName);
        saveWorld();
      }
      renderMain();
    }
  };

  const renderRenameBuilding = () => {
    dlg.innerHTML = `
      <span style="font-size:11px;color:#888;">修改 <b>${escapeHtml(pb.def.name)}</b> 的铭牌文字</span>
      <input class="rename-building-input" value="${escapeHtml(pb.customName ?? boundNpc?.name ?? pb.def.name)}" style="
        padding:4px 8px; border:1px solid #d0d4d8; border-radius:4px;
        font-size:12px; font-family:${FONT}; outline:none; width:160px;
      " maxlength="12">
      <div style="display:flex;gap:6px;justify-content:flex-end;">
        <button class="rename-b-cancel" style="
          padding:3px 10px; border:1px solid #ddd; border-radius:4px;
          background:#fff; color:#888; cursor:pointer; font-size:11px;
        ">取消</button>
        ${pb.customName ? `<button class="rename-b-clear" style="
          padding:3px 10px; border:1px solid #e0d0c0; border-radius:4px;
          background:#fff; color:#c0a080; cursor:pointer; font-size:11px;
        ">清除</button>` : ''}
        <button class="rename-b-ok" style="
          padding:3px 10px; border:none; border-radius:4px;
          background:#b0b880; color:#fff; cursor:pointer; font-size:11px;
        ">确认</button>
      </div>
    `;

    const input = dlg.querySelector('.rename-building-input') as HTMLInputElement;
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmRenameBuilding();
      if (e.key === 'Escape') renderMain();
    });

    dlg.querySelector('.rename-b-cancel')!.addEventListener('click', () => {
      ignoreClose = true;
      renderMain();
    });
    dlg.querySelector('.rename-b-ok')!.addEventListener('click', () => {
      ignoreClose = true;
      confirmRenameBuilding();
    });

    if (pb.customName) {
      dlg.querySelector('.rename-b-clear')!.addEventListener('click', () => {
        ignoreClose = true;
        pb.customName = undefined;
        // Revert to NPC name or building default
        updatePlaqueText(pb.group, boundNpc?.name ?? pb.def.name);
        saveWorld();
        renderMain();
      });
    }

    function confirmRenameBuilding() {
      const newName = input.value.trim();
      if (!newName) {
        // Empty → clear custom name
        pb.customName = undefined;
        updatePlaqueText(pb.group, boundNpc?.name ?? pb.def.name);
      } else {
        pb.customName = newName;
        updatePlaqueText(pb.group, newName);
      }
      saveWorld();
      renderMain();
    }
  };

  let ignoreClose = false;
  const closeDlg = () => { dlg.remove(); window.removeEventListener('click', closer); };
  const closer = (ev: MouseEvent) => {
    if (ignoreClose) { ignoreClose = false; return; }
    if (!dlg.contains(ev.target as Node)) closeDlg();
  };

  document.body.appendChild(dlg);
  renderMain();

  (dlg as any).__closer = closer;
  setTimeout(() => window.addEventListener('click', closer), 0);
}

window.addEventListener('contextmenu', (e) => {
  // Only trigger on click (not drag) for right mouse button
  const isDrag = pointerDown && pointerDown.button === 2 &&
    (Math.abs(e.clientX - pointerDown.x) > 4 || Math.abs(e.clientY - pointerDown.y) > 4);
  if (isDrag || !pointerDown || pointerDown.button !== 2) return;

  e.preventDefault();
  pointerDown = null;

  // Raycast against placed building meshes
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  const meshMap = new Map<THREE.Mesh, PlacedBuilding>();
  placedBuildings.forEach(pb => {
    pb.group.traverse(c => { if (c instanceof THREE.Mesh) meshMap.set(c, pb); });
  });

  const intersects = raycaster.intersectObjects([...meshMap.keys()]);
  if (intersects.length === 0) return;

  const target = meshMap.get(intersects[0].object as THREE.Mesh);
  if (!target) return;

  showDeleteConfirm(target, e.clientX, e.clientY);
});

// ─── Thumbnail Renderer ──────────────────────
const thumbSize = 52;
const thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
thumbRenderer.setSize(thumbSize, thumbSize);
thumbRenderer.setPixelRatio(1);
thumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;
thumbRenderer.toneMappingExposure = 0.85;
thumbRenderer.shadowMap.enabled = true;
thumbRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
const thumbScene = new THREE.Scene();
thumbScene.background = new THREE.Color('#F2EFE9');
thumbScene.add(new THREE.AmbientLight('#f0ebe0', 1.6));
thumbScene.add(new THREE.HemisphereLight('#fff8f0', '#d8d0c4', 1.0));
const thumbSun = new THREE.DirectionalLight('#fffdf5', 2.7);
thumbSun.position.set(6, 8, 4);
thumbSun.castShadow = true;
thumbSun.shadow.mapSize.set(512, 512);
thumbSun.shadow.radius = 2.5;
thumbSun.shadow.bias = -0.00015;
thumbSun.shadow.normalBias = 0.02;
thumbSun.shadow.camera.near = 0.5;
thumbSun.shadow.camera.far = 40;
thumbSun.shadow.camera.left = -6;
thumbSun.shadow.camera.right = 6;
thumbSun.shadow.camera.top = 6;
thumbSun.shadow.camera.bottom = -6;
thumbScene.add(thumbSun);
const thumbCamera = new THREE.PerspectiveCamera(38, 1, 0.1, 40);
thumbCamera.lookAt(0, 0.9, 0);

// Match main pipeline: EffectComposer + RenderPass (no DOF — irrelevant for thumbnails)
const catalogComposer = new EffectComposer(thumbRenderer);
catalogComposer.addPass(new RenderPass(thumbScene, thumbCamera));

const thumbCache = new Map<string, string>();

function getThumbnail(b: BuildingDef): string {
  if (thumbCache.has(b.id)) return thumbCache.get(b.id)!;
  // Adjust camera distance by building size
  const maxGrid = Math.max(b.gridW, b.gridD);
  const d = maxGrid <= 1 ? 5.8 : (maxGrid <= 2 ? 8.5 : 11.0);
  thumbCamera.position.set(d * 0.5, d * 0.65, d * 0.5);
  thumbCamera.lookAt(0, 0.9, 0);
  // Render building to canvas
  const inst = b.factory(b.defaultOpts);
  inst.position.set(0, 0, 0);
  thumbScene.add(inst);
  catalogComposer.render();
  const dataUrl = thumbRenderer.domElement.toDataURL('image/png');
  thumbScene.remove(inst);
  inst.traverse(c => { if (c instanceof THREE.Mesh) { c.geometry.dispose(); (c.material as THREE.Material).dispose(); } });
  thumbCache.set(b.id, dataUrl);
  return dataUrl;
}

// Pre-warm thumbnail cache
BUILDINGS.forEach(b => getThumbnail(b));

// ─── World Preview Thumbnail Renderer ───────────
const WORLD_THUMB_SIZE = 200;
const worldThumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
worldThumbRenderer.setSize(WORLD_THUMB_SIZE, WORLD_THUMB_SIZE);
worldThumbRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
worldThumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;
worldThumbRenderer.toneMappingExposure = 0.85;
worldThumbRenderer.shadowMap.enabled = true;
worldThumbRenderer.shadowMap.type = THREE.PCFSoftShadowMap;

const worldThumbCamera = new THREE.PerspectiveCamera(55, 1, 0.5, 80);
worldThumbCamera.position.set(14, 16, 14);
worldThumbCamera.lookAt(0, 0, 0);

// Match the main render pipeline (minus Bokeh DOF — irrelevant for a thumbnail)
const thumbComposer = new EffectComposer(worldThumbRenderer);
thumbComposer.addPass(new RenderPass(scene, worldThumbCamera));

let lastThumbnailTime = 0;
const THUMBNAIL_DEBOUNCE_MS = 2000;
let lastThumbnailDataUrl: string | null = null;

function captureWorldThumbnail(): string | null {
  try {
    const now = Date.now();
    if (now - lastThumbnailTime < THUMBNAIL_DEBOUNCE_MS) return null;
    lastThumbnailTime = now;

    const navWasVisible = navDebugPlane.visible;
    if (navWasVisible) navDebugPlane.visible = false;

    thumbComposer.render();
    const dataUrl = worldThumbRenderer.domElement.toDataURL('image/png');

    if (navWasVisible) navDebugPlane.visible = true;

    lastThumbnailDataUrl = dataUrl;
    return dataUrl;
  } catch {
    return null;
  }
}

// ─── UI: Minimal Flat Catalog ─────────────────
const FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';

// Wrapper — thin strip at bottom
const bar = document.createElement('div');
bar.id = 'catalog-bar';
bar.style.cssText = `
  position:absolute; bottom:14px; left:50%; transform:translateX(-50%); z-index:20;
  display:flex; align-items:center; gap:14px;
  padding:6px 18px;
  background:rgba(248,246,240,0.94);
  border-radius:10px;
  box-shadow:0 1px 4px rgba(0,0,0,0.04);
  pointer-events:auto;
  font-family:${FONT};
`;
document.body.appendChild(bar);

// Category labels integrated inline
const categories = [
  { key: 'house', label: '房屋' },
  { key: 'facility', label: '设施' },
  { key: 'decoration', label: '装饰' },
] as const;

let activeCategory: string = 'house';
const catLabels: HTMLElement[] = [];

categories.forEach((cat, i) => {
  const span = document.createElement('span');
  span.textContent = cat.label;
  span.style.cssText = `
    font-size:11px; cursor:pointer; user-select:none;
    color:${cat.key === activeCategory ? '#555' : '#999'};
    font-weight:${cat.key === activeCategory ? '600' : '400'};
    transition: color 0.2s; white-space:nowrap;
  `;
  span.addEventListener('click', () => {
    activeCategory = cat.key;
    catLabels.forEach((s, j) => {
      s.style.color = j === i ? '#555' : '#999';
      s.style.fontWeight = j === i ? '600' : '400';
    });
    renderCatalog();
  });
  bar.appendChild(span);
  catLabels.push(span);

  // Separator dot
  if (i < categories.length - 1) {
    const dot = document.createElement('span');
    dot.textContent = '·';
    dot.style.cssText = 'color:#bbb;font-size:10px;';
    bar.appendChild(dot);
  }
});

// Divider
const div = document.createElement('div');
div.style.cssText = 'width:1px;height:16px;background:#e8e4db;border-radius:1px;';
bar.appendChild(div);

// Thumbnail row
const thumbRow = document.createElement('div');
thumbRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
bar.appendChild(thumbRow);

function updateCatalogButtons() {
  thumbRow.querySelectorAll('button').forEach(btn => {
    const bid = (btn as HTMLElement).dataset.bid;
    const isSel = selectedDef?.id === bid;
    btn.style.opacity = isSel ? '1' : '0.55';
    btn.style.filter = isSel ? 'none' : 'grayscale(0.3)';
  });
}

function renderCatalog() {
  thumbRow.innerHTML = '';
  BUILDINGS.filter(b => b.category === activeCategory).forEach(b => {
    const dataUrl = getThumbnail(b);
    const btn = document.createElement('button');
    btn.dataset.bid = b.id;
    const isSel = selectedDef?.id === b.id;
    btn.style.cssText = `
      display:flex; flex-direction:column; align-items:center; gap:1px;
      padding:0; border:none; background:none; cursor:pointer;
      opacity:${isSel ? '1' : '0.55'};
      filter:${isSel ? 'none' : 'grayscale(0.3)'};
      transition: opacity 0.2s, filter 0.2s; flex-shrink:0;
      font-family:${FONT}; outline:none;
    `;
    btn.innerHTML = `
      <img src="${dataUrl}" width="${thumbSize}" height="${thumbSize}"
           style="border-radius:4px;display:block;" alt="${b.name}">
      <span style="font-size:9px;color:#666;line-height:1.2;">${b.name}</span>
    `;
    btn.addEventListener('click', () => {
      clearGhost();
      selectedGroundType = null;
      groundSwatches.forEach(s => { s.style.borderColor = 'transparent'; s.style.transform = 'scale(1)'; });
      selectedDef = b;
      selectedRotation = 0;
      ghost = b.factory(b.defaultOpts);
      ghost.traverse(c => { if (c instanceof THREE.Mesh) (c.material as THREE.Material).dispose(); });
      applyGhostMaterial(ghost, ghostOk);
      ghost.visible = false;
      scene.add(ghost);
      updateCatalogButtons();
    });
    btn.addEventListener('mouseenter', () => {
      if (selectedDef?.id !== b.id) { btn.style.opacity = '0.8'; btn.style.filter = 'grayscale(0.1)'; }
    });
    btn.addEventListener('mouseleave', () => {
      if (selectedDef?.id !== b.id) { btn.style.opacity = '0.55'; btn.style.filter = 'grayscale(0.3)'; }
    });
    thumbRow.appendChild(btn);
  });
}

renderCatalog();

// Ground type selector
const groundRow = document.createElement('div');
groundRow.className = 'ground-swatch-row';
groundRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
const groundDivider = document.createElement('div');
groundDivider.style.cssText = 'width:1px;height:16px;background:#e8e4db;border-radius:1px;';
bar.appendChild(groundDivider);
bar.appendChild(groundRow);

const groundSwatches: HTMLElement[] = [];
GROUND_TYPES.forEach(gt => {
  const swatch = document.createElement('button');
  swatch.title = gt.name;
  swatch.style.cssText = `
    width:18px; height:18px; border-radius:50%; border:2px solid transparent;
    background:${gt.color}; cursor:pointer; padding:0; flex-shrink:0;
    transition: border-color 0.2s, transform 0.15s; outline:none;
  `;
  swatch.addEventListener('click', () => {
    clearGhost();
    updateCatalogButtons();
    if (selectedGroundType === gt.id) {
      // Deselect
      selectedGroundType = null;
      groundSwatches.forEach(s => { s.style.borderColor = 'transparent'; s.style.transform = 'scale(1)'; });
    } else {
      selectedGroundType = gt.id;
      groundSwatches.forEach((s, i) => {
        s.style.borderColor = GROUND_TYPES[i].id === gt.id ? '#888' : 'transparent';
        s.style.transform = GROUND_TYPES[i].id === gt.id ? 'scale(1.15)' : 'scale(1)';
      });
    }
  });
  groundRow.appendChild(swatch);
  groundSwatches.push(swatch);
});

// Clear-all button (double-confirm)
const clearDivider = document.createElement('div');
clearDivider.style.cssText = 'width:1px;height:16px;background:#e8e4db;border-radius:1px;';
groundRow.appendChild(clearDivider);

let clearTimer: ReturnType<typeof setTimeout> | null = null;
const clearBtn = document.createElement('button');
clearBtn.textContent = '清空';
clearBtn.style.cssText = `
  padding:2px 8px; border:1px solid #e0dcd4; border-radius:4px;
  background:#fff; color:#999; cursor:pointer; font-size:10px;
  font-family:${FONT}; white-space:nowrap; transition: all 0.2s;
`;
clearBtn.addEventListener('click', () => {
  if (clearTimer) {
    // Second click — do clear
    clearTimeout(clearTimer);
    clearTimer = null;
    clearBtn.textContent = '清空';
    clearBtn.style.color = '#999';
    clearBtn.style.borderColor = '#e0dcd4';
    // Remove all placed buildings (skip per-item saves)
    clearGhost();
    updateCatalogButtons();
    selectedGroundType = null;
    groundSwatches.forEach(s => { s.style.borderColor = 'transparent'; s.style.transform = 'scale(1)'; });
    undoRedoing = true; // suppress recordAction + sound during bulk clear
    while (placedBuildings.length > 0) {
      removePlacedBuilding(placedBuildings[0], true);
    }
    undoRedoing = false;
    streetLights.length = 0;
    houseWindows.length = 0;
    despawnFireflies();
    despawnAllNPCs();
    // Reset all tiles to default checker pattern
    for (let tx = 0; tx < GRID; tx++) {
      for (let tz = 0; tz < GRID; tz++) {
        tileTypes[tx][tz] = (tx + tz) % 3 === 0 ? 'grass_dark' : 'grass_light';
      }
    }
    rebuildGroundMeshes();
    invalidateNavCache();
    saveWorld();
  } else {
    // First click — ask confirm
    clearBtn.textContent = '确认清空？';
    clearBtn.style.color = '#e07070';
    clearBtn.style.borderColor = '#e07070';
    clearTimer = setTimeout(() => {
      clearBtn.textContent = '清空';
      clearBtn.style.color = '#999';
      clearBtn.style.borderColor = '#e0dcd4';
      clearTimer = null;
    }, 3000);
  }
});
groundRow.appendChild(clearBtn);

// ─── Hint ─────────────────────────────────────
const hint = document.createElement('div');
hint.style.cssText = `
  position:absolute; bottom:120px; left:50%; transform:translateX(-50%);
  color:#bbb; padding:4px 12px;
  border-radius:10px; font-size:10px; font-family:${FONT};
  pointer-events:none; letter-spacing:0.3px;
`;
hint.textContent = '选择建筑 → 预览 → R旋转 → 放置 → E重选上次 → 右键删除 → Esc取消 → H隐藏UI → N寻路视图 → P帮助';
document.body.appendChild(hint);

// ─── World Label (top-left) ──────────────────
const worldLabel = document.createElement('div');
worldLabel.style.cssText = `
  position:absolute; top:14px; left:14px; z-index:20;
  padding:5px 10px;
  background:rgba(248,246,240,0.92);
  border-radius:6px;
  box-shadow:0 1px 4px rgba(0,0,0,0.05);
  font-family:${FONT}; font-size:11px; color:#666;
  cursor:pointer; user-select:none;
  pointer-events:auto;
`;
worldLabel.id = 'world-label';
worldLabel.title = '点击管理世界';
worldLabel.addEventListener('click', toggleWorldModal);
document.body.appendChild(worldLabel);

function updateWorldLabel() {
  worldLabel.textContent = `🌍 ${currentWorldName}`;
}

// ─── Custom Inline Dialogs ─────────────────────

function showRenameDialog(title: string, initialValue: string): Promise<string | null> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed; top:0; left:0; right:0; bottom:0; z-index:300;
      display:flex; align-items:center; justify-content:center;
      background:rgba(0,0,0,0.15);
      font-family:${FONT};
    `;
    overlay.innerHTML = `
      <div class="rd-inner" style="
        background:rgba(255,255,255,0.97);
        border-radius:12px; padding:18px 22px;
        box-shadow:0 4px 24px rgba(0,0,0,0.1);
        min-width:260px; display:flex; flex-direction:column; gap:12px;
        pointer-events:auto;
      ">
        <div style="font-size:13px;font-weight:600;color:#444;">${escapeHtml(title)}</div>
        <input class="rd-input" value="${escapeHtml(initialValue)}" maxlength="20" style="
          padding:6px 10px; border:1px solid #d8d4cc; border-radius:6px;
          font-size:13px; font-family:${FONT}; outline:none; color:#555;
          background:#fafaf8;
        ">
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="rd-cancel" style="
            padding:5px 14px; border:1px solid #e0dcd4; border-radius:6px;
            background:#fff; color:#888; cursor:pointer; font-size:12px;
            font-family:${FONT};
          ">取消</button>
          <button class="rd-ok" style="
            padding:5px 14px; border:none; border-radius:6px;
            background:#b0c8a0; color:#fff; cursor:pointer; font-size:12px;
            font-family:${FONT};
          ">确认</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('.rd-input') as HTMLInputElement;
    input.focus();
    input.select();

    const close = (val: string | null) => {
      overlay.remove();
      resolve(val);
    };

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    overlay.querySelector('.rd-cancel')!.addEventListener('click', () => close(null));
    overlay.querySelector('.rd-ok')!.addEventListener('click', () => close(input.value.trim()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value.trim());
      if (e.key === 'Escape') close(null);
    });
  });
}

function showDeleteConfirmDialog(worldName: string): Promise<boolean> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed; top:0; left:0; right:0; bottom:0; z-index:300;
      display:flex; align-items:center; justify-content:center;
      background:rgba(0,0,0,0.15);
      font-family:${FONT};
    `;
    overlay.innerHTML = `
      <div style="
        background:rgba(255,255,255,0.97);
        border-radius:12px; padding:18px 22px;
        box-shadow:0 4px 24px rgba(0,0,0,0.1);
        min-width:280px; display:flex; flex-direction:column; gap:12px;
        pointer-events:auto;
      ">
        <div style="font-size:13px;font-weight:600;color:#444;">删除世界</div>
        <div style="font-size:12px;color:#777;line-height:1.6;">
          确定删除世界 <b style="color:#555;">"${escapeHtml(worldName)}"</b>？<br>此操作不可撤销。
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="dd-cancel" style="
            padding:5px 14px; border:1px solid #e0dcd4; border-radius:6px;
            background:#fff; color:#888; cursor:pointer; font-size:12px;
            font-family:${FONT};
          ">取消</button>
          <button class="dd-ok" style="
            padding:5px 14px; border:none; border-radius:6px;
            background:#e07070; color:#fff; cursor:pointer; font-size:12px;
            font-family:${FONT};
          ">删除</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = (val: boolean) => {
      overlay.remove();
      resolve(val);
    };

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    overlay.querySelector('.dd-cancel')!.addEventListener('click', () => close(false));
    overlay.querySelector('.dd-ok')!.addEventListener('click', () => close(true));
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter') close(true);
    });
    (overlay.querySelector('.dd-cancel') as HTMLElement).focus();
  });
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ─── World Manager Modal ──────────────────────
let worldList: WorldMeta[] = [];

const worldModal = document.createElement('div');
worldModal.style.cssText = `
  position:fixed; top:0; left:0; right:0; bottom:0; z-index:200;
  display:none; align-items:center; justify-content:center;
  background:rgba(0,0,0,0.2);
  font-family:${FONT};
`;
document.body.appendChild(worldModal);

function toggleWorldModal() {
  if (!worldReady) return;
  if (worldModal.style.display === 'flex') {
    worldModal.style.display = 'none';
  } else {
    renderWorldModal();
    worldModal.style.display = 'flex';
  }
}

async function renderWorldModal() {
  worldList = await getWorldList();
  worldModal.innerHTML = `
    <div style="
      background:rgba(255,255,255,0.97);
      border-radius:16px; padding:28px 32px;
      box-shadow:0 4px 32px rgba(0,0,0,0.1);
      width:65vw; min-width:640px; max-width:960px; max-height:80vh;
      display:flex; flex-direction:column; gap:18px;
      pointer-events:auto;
    ">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:20px; font-weight:600; color:#444;">世界管理</span>
        <button id="wm-close" style="
          border:none; background:none; color:#bbb; cursor:pointer;
          font-size:22px; padding:0 6px; line-height:1;
        ">✕</button>
      </div>
      <div id="wm-list" style="display:flex; flex-wrap:wrap; gap:14px; flex:1; overflow-y:auto; min-height:0; align-content:flex-start;">
        ${worldList.map(w => `
          <div style="
            display:flex; flex-direction:column; gap:0;
            width:200px; border-radius:10px; overflow:hidden;
            background:${w.id === currentWorldId ? '#f5f3ea' : '#fafaf8'};
            border:1px solid ${w.id === currentWorldId ? '#ddd8cc' : '#eee'};
            box-shadow:0 1px 3px rgba(0,0,0,0.04);
            transition: box-shadow 0.2s;
            flex-shrink:0;
          " onmouseenter="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.08)'" onmouseleave="this.style.boxShadow='0 1px 3px rgba(0,0,0,0.04)'">
            <div style="
              width:200px; height:130px; flex-shrink:0;
              background:#f0eee8;
            ">
              ${w.thumbnail
                ? `<img src="${escapeHtml(w.thumbnail)}" style="width:200px;height:130px;object-fit:cover;display:block;" alt="">`
                : `<div style="width:200px;height:130px;display:flex;align-items:center;justify-content:center;color:#ddd;font-size:14px;text-align:center;">无预览</div>`
              }
            </div>
            <div style="padding:10px 12px 4px;">
              <div style="font-size:14px; font-weight:600; color:#555; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                ${escapeHtml(w.name)}
                ${w.id === currentWorldId ? '<span style="font-size:11px;color:#aaa;font-weight:400;margin-left:4px;">当前</span>' : ''}
              </div>
              <div style="font-size:10px; color:#bbb; margin-top:2px;">
                ${new Date(w.updatedAt).toLocaleString('zh-CN')}
              </div>
            </div>
            <div style="display:flex; gap:0; padding:8px 8px 10px;">
              <button class="wm-switch" data-id="${w.id}" style="
                flex:1; padding:5px 0; border:none; border-radius:6px;
                background:${w.id === currentWorldId ? '#e8e4d8' : '#f0ede4'};
                color:${w.id === currentWorldId ? '#aaa' : '#888'}; cursor:${w.id === currentWorldId ? 'default' : 'pointer'};
                font-size:12px; font-family:${FONT}; margin-right:5px;
                ${w.id === currentWorldId ? 'pointer-events:none;' : ''}
              ">切换</button>
              <button class="wm-rename" data-id="${w.id}" data-name="${escapeHtml(w.name)}" style="
                flex:1; padding:5px 0; border:none; border-radius:6px;
                background:#f0ede4; color:#b0a080; cursor:pointer; font-size:12px;
                font-family:${FONT}; margin-right:5px;
              ">改名</button>
              <button class="wm-delete" data-id="${w.id}" style="
                flex:1; padding:5px 0; border:none; border-radius:6px;
                background:#f0ede4; color:#d8b0b0; cursor:pointer; font-size:12px;
                font-family:${FONT};
              ">删除</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div style="display:flex; gap:10px; align-items:center;">
        <input id="wm-new-name" type="text" placeholder="新世界名称" value=""
          style="flex:1; padding:8px 12px; border:1px solid #e0dcd4; border-radius:6px;
            font-size:14px; font-family:${FONT}; outline:none;">
        <select id="wm-grid-size" style="
          padding:8px 12px; border:1px solid #e0dcd4; border-radius:6px;
          font-size:14px; font-family:${FONT}; background:#fff; color:#666;
        ">
          <option value="12">12×12</option>
          <option value="16">16×16</option>
          <option value="24">24×24</option>
        </select>
        <select id="wm-template" style="
          padding:8px 12px; border:1px solid #e0dcd4; border-radius:6px;
          font-size:14px; font-family:${FONT}; background:#fff; color:#666;
        ">
          ${worldTemplates.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
        </select>
        <button id="wm-create" style="
          padding:8px 20px; border:none; border-radius:6px;
          background:#b0c8a0; color:#fff; cursor:pointer; font-size:14px;
          font-family:${FONT};
        ">创建</button>
      </div>
      <div style="display:flex; gap:10px; border-top:1px solid #eee; padding-top:14px;">
        <button id="wm-export" style="
          flex:1; padding:8px; border:1px solid #d8d4c8; border-radius:6px;
          background:#fff; color:#888; cursor:pointer; font-size:13px;
          font-family:${FONT};
        ">导出 JSON</button>
        <button id="wm-import" style="
          flex:1; padding:8px; border:1px solid #d8d4c8; border-radius:6px;
          background:#fff; color:#888; cursor:pointer; font-size:13px;
          font-family:${FONT};
        ">导入 JSON</button>
      </div>
      <input type="file" id="wm-file-input" accept=".json" style="display:none;">
    </div>
  `;

  // Close button
  worldModal.querySelector('#wm-close')!.addEventListener('click', () => {
    worldModal.style.display = 'none';
  });
  worldModal.addEventListener('click', (e) => {
    if (e.target === worldModal) worldModal.style.display = 'none';
  });

  // Rename world
  worldModal.querySelectorAll('.wm-rename').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.id!;
      const oldName = (btn as HTMLElement).dataset.name!;
      const newName = await showRenameDialog('修改世界名称', oldName);
      if (!newName || newName === oldName) return;
      await renameWorld(id, newName);
      if (id === currentWorldId) {
        currentWorldName = newName;
        updateWorldLabel();
      }
      renderWorldModal();
    });
  });

  // Switch world
  worldModal.querySelectorAll('.wm-switch').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.id!;
      await saveWorld();
      const record = await dbLoadWorld(id);
      if (record) {
        switchToWorld(record.id, record.name, record.data);
        renderWorldModal();
      }
    });
  });

  // Delete world
  worldModal.querySelectorAll('.wm-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.id!;
      const meta = worldList.find(w => w.id === id);
      if (!meta) return;
      if (!await showDeleteConfirmDialog(meta.name)) return;
      if (id === currentWorldId) {
        // Delete current — switch to another world or create default
        const others = worldList.filter(w => w.id !== id);
        let switched = false;
        if (others.length > 0) {
          const record = await dbLoadWorld(others[0].id);
          if (record) { switchToWorld(record.id, record.name, record.data); switched = true; }
        }
        if (!switched) {
          // Create a fresh default world
          const newMeta = await createWorld('默认世界');
          const record = await dbLoadWorld(newMeta.id);
          if (record) { switchToWorld(record.id, record.name, record.data); switched = true; }
        }
        if (!switched) {
          alert('无法切换到其他世界，删除已取消');
          return;
        }
      }
      await deleteWorld(id);
      renderWorldModal();
    });
  });

  // Create world
  worldModal.querySelector('#wm-create')!.addEventListener('click', async () => {
    const input = worldModal.querySelector('#wm-new-name') as HTMLInputElement;
    const name = input.value.trim() || '未命名世界';
    const sizeSelect = worldModal.querySelector('#wm-grid-size') as HTMLSelectElement;
    const gridSize = parseInt(sizeSelect.value) || 12;
    const tplSelect = worldModal.querySelector('#wm-template') as HTMLSelectElement;
    const templateId = tplSelect.value as TemplateId;
    await saveWorld();
    const meta = await createWorld(name, gridSize);
    const record = await dbLoadWorld(meta.id);
    if (record) {
      switchToWorld(record.id, record.name, record.data);
      applyTemplate(templateId);
      renderWorldModal();
      saveWorld();
    }
  });

  // Export JSON
  worldModal.querySelector('#wm-export')!.addEventListener('click', () => {
    const data = buildSaveData();
    const exportData = {
      version: 1,
      meta: {
        name: currentWorldName,
        exportedAt: new Date().toISOString(),
        gridSize: GRID,
      },
      worldTime: { timeOfDay },
      buildings: data.buildings,
      tiles: data.tiles,
      npcs: data.npcs,
      ...(data.thumbnail ? { thumbnail: data.thumbnail } : {}),
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `world_${currentWorldName}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Import JSON
  worldModal.querySelector('#wm-import')!.addEventListener('click', () => {
    worldModal.querySelector<HTMLInputElement>('#wm-file-input')!.click();
  });
  worldModal.querySelector('#wm-file-input')!.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const name = json.meta?.name ?? file.name.replace('.json', '');
      const gridSize = json.meta?.gridSize ?? json.gridSize ?? 12;
      const data: SaveData = {
        version: json.version ?? 1,
        gridSize,
        timeOfDay: json.worldTime?.timeOfDay ?? 0.35,
        buildings: json.buildings ?? [],
        tiles: json.tiles ?? [],
        npcs: json.npcs ?? [],
        thumbnail: json.thumbnail,
      };
      const meta = await createWorld(name, gridSize);
      await dbSaveWorld(meta.id, name, data);
      await saveWorld();
      switchToWorld(meta.id, name, data);
      renderWorldModal();
    } catch (err) {
      alert('导入失败：JSON 格式错误');
    }
    // Reset file input
    (e.target as HTMLInputElement).value = '';
  });
}

// ─── Debug Panel: Time Control ─────────────────
const debugPanel = document.createElement('div');
debugPanel.style.cssText = `
  position:absolute; top:14px; right:14px; z-index:20;
  display:flex; align-items:center; gap:8px;
  padding:6px 12px;
  background:rgba(248,246,240,0.92);
  border-radius:8px;
  box-shadow:0 1px 4px rgba(0,0,0,0.05);
  font-family:${FONT}; font-size:11px; color:#777;
  pointer-events:auto;
`;
document.body.appendChild(debugPanel);

// Time label
const timeLabel = document.createElement('span');
timeLabel.style.cssText = 'min-width:32px;text-align:center;font-weight:600;color:#555;';
debugPanel.appendChild(timeLabel);

// Slider
const timeSlider = document.createElement('input');
timeSlider.type = 'range';
timeSlider.min = '0'; timeSlider.max = '1'; timeSlider.step = '0.001';
timeSlider.value = String(timeOfDay);
timeSlider.style.cssText = 'width:100px;accent-color:#888;cursor:pointer;';
let sliderDragging = false;
timeSlider.addEventListener('pointerdown', () => { sliderDragging = true; });
timeSlider.addEventListener('pointerup', () => { sliderDragging = false; });
timeSlider.addEventListener('input', () => {
  timeOfDay = parseFloat(timeSlider.value);
  skyMat.uniforms.uTimeOfDay.value = timeOfDay;
});
debugPanel.appendChild(timeSlider);

// Speed buttons
const speeds = [
  { label: '⏸', val: 0 },
  { label: '1×', val: 1 },
  { label: '5×', val: 5 },
  { label: '20×', val: 20 },
];
const speedBtns: HTMLElement[] = [];
speeds.forEach(s => {
  const btn = document.createElement('button');
  btn.textContent = s.label;
  const active = timeSpeed === s.val;
  btn.style.cssText = `
    padding:1px 6px; border:1px solid ${active ? '#aaa' : '#e0dcd4'}; border-radius:4px;
    background:${active ? '#eee' : '#fff'}; color:${active ? '#555' : '#bbb'};
    cursor:pointer; font-size:10px; font-family:${FONT};
  `;
  btn.addEventListener('click', () => {
    timeSpeed = s.val;
    speedBtns.forEach((b, i) => {
      const act = speeds[i].val === timeSpeed;
      b.style.borderColor = act ? '#aaa' : '#e0dcd4';
      b.style.background = act ? '#eee' : '#fff';
      b.style.color = act ? '#555' : '#bbb';
    });
  });
  debugPanel.appendChild(btn);
  speedBtns.push(btn);
});

// Update slider + label each frame from time
function updateDebugPanel() {
  timeLabel.textContent = formatGameTime(timeOfDay);
  if (!sliderDragging) {
    timeSlider.value = String(timeOfDay);
  }
  // Hint text: darker during day, lighter at night for readability
  const dayBright = Math.max(0, Math.min(1, (timeOfDay - 0.25) / 0.15)) * Math.max(0, Math.min(1, (0.75 - timeOfDay) / 0.15));
  const r = Math.round(187 - 85 * dayBright); // 187→102
  const gb = Math.round(187 - 85 * dayBright);
  hint.style.color = `rgb(${r},${gb},${gb})`;
}

// ─── HUD Toggle ───────────────────────────────
const hudElements: HTMLElement[] = [bar, hint, debugPanel, worldLabel];
let hudVisible = true;

function toggleHUD() {
  hudVisible = !hudVisible;
  hudElements.forEach(el => { el.style.display = hudVisible ? '' : 'none'; });
}

// ─── Nav Debug Overlay ─────────────────────────
const NAV = GRID * SUB; // 60
let navDebugVisible = false;
const navDebugCanvas = document.createElement('canvas');
navDebugCanvas.width = NAV; navDebugCanvas.height = NAV;
const navDebugCtx = navDebugCanvas.getContext('2d')!;
const navDebugTex = new THREE.CanvasTexture(navDebugCanvas);
navDebugTex.magFilter = THREE.NearestFilter;
navDebugTex.minFilter = THREE.NearestFilter;
const navDebugPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(GRID * SPACING, GRID * SPACING),
  new THREE.MeshBasicMaterial({ map: navDebugTex, transparent: true, opacity: 0.7, depthTest: true, depthWrite: false }),
);
navDebugPlane.rotation.x = -Math.PI / 2;
navDebugPlane.position.y = 0.07;
navDebugPlane.visible = false;
navDebugPlane.renderOrder = 999;
scene.add(navDebugPlane);

const navDebugSavedMats = new Map<THREE.Material, { transparent: boolean; opacity: number; depthWrite: boolean }>();

function updateNavDebugOverlay() {
  const grid = buildNavGrid();
  const imgData = navDebugCtx.createImageData(NAV, NAV);
  for (let sz = 0; sz < NAV; sz++) {
    for (let sx = 0; sx < NAV; sx++) {
      const idx = (sz * NAV + sx) * 4;
      if (grid[sx][sz]) {
        imgData.data[idx] = 200; imgData.data[idx + 1] = 60; imgData.data[idx + 2] = 60; imgData.data[idx + 3] = 200;
      } else {
        imgData.data[idx] = 60; imgData.data[idx + 1] = 180; imgData.data[idx + 2] = 80; imgData.data[idx + 3] = 180;
      }
    }
  }
  navDebugCtx.putImageData(imgData, 0, 0);
  navDebugTex.needsUpdate = true;
}

function toggleNavDebug() {
  navDebugVisible = !navDebugVisible;
  if (navDebugVisible) {
    updateNavDebugOverlay();
    navDebugPlane.visible = true;
    // Make all scene geometry semi-transparent so the nav grid is visible
    scene.traverse(child => {
      if (child === navDebugPlane || child === sky) return;
      if (child instanceof THREE.Mesh) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(mat => {
          if (navDebugSavedMats.has(mat)) return;
          navDebugSavedMats.set(mat, {
            transparent: mat.transparent,
            opacity: mat.opacity,
            depthWrite: mat.depthWrite,
          });
          mat.transparent = true;
          mat.opacity = 0.1;
          mat.depthWrite = false;
          mat.needsUpdate = true;
        });
      }
    });
  } else {
    navDebugPlane.visible = false;
    // Restore original material settings
    navDebugSavedMats.forEach((orig, mat) => {
      mat.transparent = orig.transparent;
      mat.opacity = orig.opacity;
      mat.depthWrite = orig.depthWrite;
      mat.needsUpdate = true;
    });
    navDebugSavedMats.clear();
  }
}

// ─── Time Helpers ──────────────────────────────
function formatGameTime(t: number): string {
  const hours = Math.floor(t * 24);
  const mins = Math.floor((t * 24 - hours) * 60);
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

// ─── Init: Load world from IndexedDB ───────────
let worldReady = false;
async function initWorld() {
  try {
    // Try migrating old localStorage save first
    await migrateFromLocalStorage();

    const list = await getWorldList();
    if (list.length === 0) {
      // Create default world
      await createWorld('我的第一个世界');
      const newList = await getWorldList();
      if (newList.length > 0) {
        const record = await dbLoadWorld(newList[0].id);
        if (record) {
          currentWorldId = record.id;
          currentWorldName = record.name;
          restoreWorld(record.data);
        }
      }
    } else {
      // Load most recently updated world
      const record = await dbLoadWorld(list[0].id);
      if (record) {
        currentWorldId = record.id;
        currentWorldName = record.name;
        restoreWorld(record.data);
      }
    }
    updateWorldLabel();
  } catch (err) {
    console.error('Failed to initialize world:', err);
    // Fallback: create fresh world
    try {
      await createWorld('默认世界');
      const list = await getWorldList();
      if (list.length > 0) {
        const record = await dbLoadWorld(list[0].id);
        if (record) {
          currentWorldId = record.id;
          currentWorldName = record.name;
          restoreWorld(record.data);
        }
      }
      updateWorldLabel();
    } catch (e2) {
      console.error('Fatal: cannot initialize storage:', e2);
    }
  }
  worldReady = true;
  lastThumbnailTime = 0; // ensure first save captures thumbnail for default world
  // Show tutorial on first visit
  if (!localStorage.getItem('voxel_tutorial_seen')) {
    setTimeout(showTutorial, 500);
  }
}

// ─── Tutorial Overlay ─────────────────────────
function showTutorial() {
  const steps = [
    {
      title: '欢迎来到体素小世界！',
      desc: '你是这个世界的创世神。<br>自由建造，没有任务，没有目标。',
      target: null as string | null,
    },
    {
      title: '视角操作',
      desc: '<b>左键拖拽</b>旋转视角 · <b>滚轮</b>缩放 · <b>右键拖拽</b>平移<br>试试调整到你喜欢的角度~',
      target: null,
    },
    {
      title: '建筑目录',
      desc: '底部栏中间是<b>建筑模板目录</b>。<br>切换分类标签选择房屋/设施/装饰。<br>按 <b>E 键</b>可快速重选上次建筑。',
      target: '#catalog-bar',
    },
    {
      title: '放置建筑',
      desc: '选中建筑后，在网格上<b>点击</b>放置。<br>按 <b>R 键</b>旋转朝向，<b>右键</b>拆除。<br>放置房屋后会<b>自动生成居民 NPC</b>~',
      target: null,
    },
    {
      title: '地面涂色',
      desc: '点击右下角 <b>色块圆圈</b>切换到涂色模式，<br>再点击地面即可更改地块类型。<br>试试沙滩和水的组合吧~',
      target: '.ground-swatch-row',
    },
    {
      title: '世界管理',
      desc: '点击左上角 <b>世界名称</b>打开管理面板。<br>可创建多世界、导出/导入 JSON、<br>选择世界尺寸和初始模板。',
      target: '#world-label',
    },
    {
      title: '开始创造吧！',
      desc: '按 <b>N 键</b>查看 NPC 寻路网格。<br>按 <b>H 键</b>隐藏界面方便截图。<br>按 <b>P 键</b>可随时重新打开本教程。<br>祝你在小世界中玩得开心 🎨',
      target: null,
    },
  ];

  let stepIdx = 0;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:500;pointer-events:none;';

  const tooltip = document.createElement('div');
  tooltip.style.cssText = `
    position:fixed; z-index:501; pointer-events:auto;
    background:rgba(255,255,255,0.96); border-radius:12px;
    padding:16px 20px; box-shadow:0 4px 24px rgba(0,0,0,0.15);
    font-family:${FONT}; max-width:280px;
    transition: opacity 0.3s, transform 0.3s;
  `;
  overlay.appendChild(tooltip);

  const prevBtn = document.createElement('button');
  prevBtn.textContent = '← 上一步';
  Object.assign(prevBtn.style, {
    padding:'5px 12px', border:'1px solid #e0dcd4', borderRadius:'6px',
    background:'#fff', color:'#888', cursor:'pointer', fontSize:'12px',
    fontFamily: FONT, display:'none',
  });
  prevBtn.addEventListener('click', () => { if (stepIdx > 0) showStep(--stepIdx); });

  const nextBtn = document.createElement('button');
  nextBtn.textContent = '下一步 →';
  Object.assign(nextBtn.style, {
    padding:'5px 14px', border:'none', borderRadius:'6px',
    background:'#b0c8a0', color:'#fff', cursor:'pointer', fontSize:'12px',
    fontFamily: FONT,
  });

  const skipBtn = document.createElement('button');
  skipBtn.textContent = '跳过引导';
  Object.assign(skipBtn.style, {
    padding:'5px 12px', border:'1px solid #e0dcd4', borderRadius:'6px',
    background:'#fff', color:'#bbb', cursor:'pointer', fontSize:'11px',
    fontFamily: FONT,
  });

  const doneBtn = document.createElement('button');
  doneBtn.textContent = '开始建造！';
  Object.assign(doneBtn.style, {
    padding:'6px 18px', border:'none', borderRadius:'8px',
    background:'#88c0a0', color:'#fff', cursor:'pointer', fontSize:'14px',
    fontFamily: FONT, display:'none',
  });

  function finish() {
    localStorage.setItem('voxel_tutorial_seen', '1');
    overlay.remove();
  }

  skipBtn.addEventListener('click', finish);
  nextBtn.addEventListener('click', () => {
    if (stepIdx < steps.length - 1) showStep(++stepIdx);
  });
  doneBtn.addEventListener('click', finish);

  function showStep(idx: number) {
    stepIdx = idx;
    const s = steps[idx];
    const isLast = idx === steps.length - 1;
    const isFirst = idx === 0;

    prevBtn.style.display = isFirst ? 'none' : '';
    nextBtn.style.display = isLast ? 'none' : '';
    doneBtn.style.display = isLast ? '' : 'none';
    skipBtn.style.display = isLast ? 'none' : '';

    tooltip.innerHTML = `
      <div style="font-size:14px;font-weight:600;color:#555;margin-bottom:8px;">
        ${idx + 1}/${steps.length} · ${s.title}
      </div>
      <div style="font-size:12px;color:#777;line-height:1.8;">
        ${s.desc}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:12px;">
      </div>
    `;
    const btnRow = tooltip.querySelector('div:last-child')!;
    btnRow.appendChild(skipBtn);
    btnRow.appendChild(prevBtn);
    btnRow.appendChild(nextBtn);
    btnRow.appendChild(doneBtn);

    // Position tooltip near target element or centered
    if (s.target) {
      const el = document.querySelector(s.target);
      if (el) {
        const r = el.getBoundingClientRect();
        const tw = 280;
        let left = r.left + r.width / 2 - tw / 2;
        // Prefer below the target; go above if not enough room below
        const showBelow = r.bottom + 220 < window.innerHeight;
        let top = showBelow ? r.bottom + 10 : r.top - 10;
        // Clamp horizontally
        if (left < 10) left = 10;
        if (left + tw > window.innerWidth - 10) left = window.innerWidth - tw - 10;
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
        tooltip.style.transform = showBelow ? 'none' : 'translateY(-100%)';
      } else {
        positionCenter();
      }
    } else {
      positionCenter();
    }

    // Draw highlight overlay on a canvas behind the tooltip
    drawHighlight(s.target);
  }

  function positionCenter() {
    tooltip.style.left = '50%';
    tooltip.style.top = '45%';
    tooltip.style.transform = 'translate(-50%, -50%)';
  }

  // Canvas overlay for dimming + spotlight cutout
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:499;pointer-events:none;';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  overlay.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  function drawHighlight(targetSelector: string | null) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Dim background
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (targetSelector) {
      const el = document.querySelector(targetSelector);
      if (el) {
        const r = el.getBoundingClientRect();
        // Cutout a rounded rectangle spotlight
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        const x = r.left - 6, y = r.top - 6, w = r.width + 12, h = r.height + 12, rad = 8;
        ctx.beginPath();
        ctx.moveTo(x + rad, y);
        ctx.lineTo(x + w - rad, y);
        ctx.arcTo(x + w, y, x + w, y + rad, rad);
        ctx.lineTo(x + w, y + h - rad);
        ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
        ctx.lineTo(x + rad, y + h);
        ctx.arcTo(x, y + h, x, y + h - rad, rad);
        ctx.lineTo(x, y + rad);
        ctx.arcTo(x, y, x + rad, y, rad);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        // Glow border
        ctx.strokeStyle = 'rgba(176,200,160,0.7)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  // Redraw highlight on resize
  window.addEventListener('resize', () => drawHighlight(steps[stepIdx].target));

  document.body.appendChild(overlay);
  showStep(0);
}

initWorld();

// ─── Animation ───────────────────────────────
// ─── FPS Display ──────────────────────────────
const fpsEl = document.createElement('div');
fpsEl.style.cssText = 'position:fixed;bottom:8px;right:12px;z-index:100;font-family:"Segoe UI",system-ui,sans-serif;font-size:11px;color:#999;pointer-events:none;';
document.body.appendChild(fpsEl);

const clock = new THREE.Clock();
let fpsFrames = 0, fpsTime = performance.now();

function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1); // cap to avoid jumps
  controls.update();
  updateDayNight(dt);
  updateFireflies(dt);
  updateNPCs(dt, timeOfDay, timeSpeed, scene);
  // Water wave animation
  let t = performance.now() * 0.001;
  waterTileMeshes.forEach(wt => {
    const wave = Math.sin(wt.wx * 3.0 + t * 2.0) * Math.cos(wt.wz * 2.5 + t * 1.6) * 0.12
               + Math.sin(wt.wx * 5.0 - t * 1.4) * Math.cos(wt.wz * 4.5 + t * 2.2) * 0.07
               + Math.sin((wt.wx + wt.wz) * 4.0 + t * 3.0) * 0.05;
    wt.mesh.position.y = wt.baseY + wave;
  });
  updateDebugPanel();

  // FPS counter
  fpsFrames++;
  const now = performance.now();
  if (now - fpsTime >= 500) {
    fpsEl.textContent = 'FPS: ' + Math.round(fpsFrames / ((now - fpsTime) / 1000));
    fpsFrames = 0; fpsTime = now;
  }

  // Focus on whatever is at screen center (raycast ground plane)
  mouse.set(0, 0);
  raycaster.setFromCamera(mouse, camera);
  const focusHit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(groundPlane, focusHit)) {
    bokehPass.uniforms['focus'].value = camera.position.distanceTo(focusHit);
  }
  composer.render();
}
animate();

// ─── Resize ──────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});
