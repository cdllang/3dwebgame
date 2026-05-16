import * as THREE from 'three';
import { SPACING, GRID, HALF, gridToWorld, worldToGrid, isCellFree, type PlacedBuilding, placedBuildings } from './placement';

// ─── NPC Name Pool ───────────────────────────
const NPC_NAMES = [
  '小明', '小红', '阿木', '小石', '花姐', '老李',
  '阿星', '豆豆', '小月', '大山', '春丽', '阿福',
  '小蓝', '石头', '木匠', '铁匠', '小溪', '白云',
];

// ─── Types ───────────────────────────────────
export type NPCState = 'sleeping' | 'daytime' | 'going_home';

export interface NPCData {
  id: string;
  name: string;
  homeGx: number;
  homeGz: number;
  homeW: number;
  homeD: number;
  group: THREE.Group;
  state: NPCState;
  currentGx: number;
  currentGz: number;
  activityTimer: number;
  wanderMoveTimer: number; // sub-timer for position change during wandering
  animPhase: number; // random phase offset so NPCs don't animate in sync
  facilityTarget: { gx: number; gz: number; defId: string } | null;
  currentActivity: string | null; // activity type key, null = walking
  skinColor: string;
  clothColor: string;
  path: [number, number][];
  walkSpeed: number;
  head: THREE.Mesh;
  body: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  legL: THREE.Group; // pivot at hip
  legR: THREE.Group; // pivot at hip
  label: THREE.Sprite;
  thoughtBubble: THREE.Sprite | null;
  arrivedHome: boolean;
}

export const npcs: NPCData[] = [];

// ─── Activity System ─────────────────────────
interface ActivityDef {
  facilityId: string | null; // null = wandering
  bubbles: string[];
}
const ACTIVITIES: Record<string, ActivityDef> = {
  farming:      { facilityId: 'farm_plot',   bubbles: ['正在耕作中...', '今天庄稼长势不错', '除草施肥中...'] },
  draw_water:   { facilityId: 'well',         bubbles: ['打水中...', '排队取水...', '水好清凉~'] },
  resting:      { facilityId: 'bench',        bubbles: ['思考人生中...', '休息一下...', '晒晒太阳真舒服', '看看风景...'] },
  shopping:     { facilityId: 'market_stall',  bubbles: ['看看有什么好东西...', '挑选商品中...', '这个不错!'] },
  crafting:     { facilityId: 'workshop',      bubbles: ['正在制作工具...', '叮叮当当...', '专注工作中...'] },
  baking:       { facilityId: 'bakery',        bubbles: ['闻到了面包香...', '等待新鲜面包出炉...', '好香啊~'] },
  flower_gazing: { facilityId: 'flower_bed',   bubbles: ['赏花中...', '浇花中...', '花香真好闻~', '这花开得真好看'] },
  wandering:    { facilityId: null,            bubbles: ['散步中...', '透透气...', '随便走走...'] },
};
const ACTIVITY_KEYS = Object.keys(ACTIVITIES);

function createThoughtBubble(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 768; canvas.height = 192;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '44px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  const w = tw + 60;
  const x0 = (768 - w) / 2;
  const r = 20; const rx = x0, ry = 16, rw = w, rh = 100;
  ctx.beginPath();
  ctx.moveTo(rx + r, ry);
  ctx.lineTo(rx + rw - r, ry);
  ctx.arcTo(rx + rw, ry, rx + rw, ry + r, r);
  ctx.lineTo(rx + rw, ry + rh - r);
  ctx.arcTo(rx + rw, ry + rh, rx + rw - r, ry + rh, r);
  ctx.lineTo(rx + r, ry + rh);
  ctx.arcTo(rx, ry + rh, rx, ry + rh - r, r);
  ctx.lineTo(rx, ry + r);
  ctx.arcTo(rx, ry, rx + r, ry, r);
  ctx.closePath(); ctx.fill();
  // Triangle pointer
  ctx.beginPath(); ctx.moveTo(384 - 14, 116); ctx.lineTo(384, 144); ctx.lineTo(384 + 14, 116); ctx.fill();
  // Text
  ctx.fillStyle = '#555';
  ctx.fillText(text, 384, 66);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, transparent: true }));
  sprite.scale.set(4.8, 1.2, 1);
  sprite.position.set(0, 2.0, 0);
  return sprite;
}

function updateThoughtBubble(npc: NPCData) {
  // Remove old bubble
  if (npc.thoughtBubble) {
    npc.group.remove(npc.thoughtBubble);
    (npc.thoughtBubble.material as THREE.SpriteMaterial).map?.dispose();
    (npc.thoughtBubble.material as THREE.SpriteMaterial).dispose();
    npc.thoughtBubble = null;
  }
  // Show bubble while activity is active (walking or standing at destination)
  if (npc.currentActivity && npc.state === 'daytime') {
    const act = ACTIVITIES[npc.currentActivity];
    if (act) {
      const text = act.bubbles[Math.floor(Math.random() * act.bubbles.length)];
      npc.thoughtBubble = createThoughtBubble(text);
      npc.group.add(npc.thoughtBubble);
    }
  }
}

// ─── NPC Model Creation ──────────────────────
function createNPCModel(skinColor: string, clothColor: string): { group: THREE.Group; head: THREE.Mesh; body: THREE.Mesh; armL: THREE.Mesh; armR: THREE.Mesh; legL: THREE.Group; legR: THREE.Group } {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.7, metalness: 0 });
  const cloth = new THREE.MeshStandardMaterial({ color: clothColor, roughness: 0.85, metalness: 0 });
  const dark = new THREE.MeshStandardMaterial({ color: '#444444', roughness: 0.9, metalness: 0 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.42, 0.2), cloth);
  body.position.set(0, 0.52, 0);
  body.castShadow = true;
  g.add(body);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.24, 0.22), skin);
  head.position.set(0, 0.36, 0); // relative to body (0.88 - 0.52)
  head.castShadow = true;
  body.add(head); // child of body so it moves when body bends

  const armGeo = new THREE.BoxGeometry(0.08, 0.35, 0.08);
  const armL = new THREE.Mesh(armGeo, cloth);
  armL.position.set(-0.19, 0.18, 0); // relative to body (0.70 - 0.52)
  armL.castShadow = true;
  body.add(armL);

  const armR = new THREE.Mesh(armGeo, cloth);
  armR.position.set(0.19, 0.18, 0);
  armR.castShadow = true;
  body.add(armR);

  const legGeo = new THREE.BoxGeometry(0.1, 0.28, 0.1);
  // Leg pivot at hip joint (y≈0.30), leg mesh offset downward
  const legLPivot = new THREE.Group();
  legLPivot.position.set(-0.07, 0.30, 0);
  const legLMesh = new THREE.Mesh(legGeo, dark);
  legLMesh.position.set(0, -0.14, 0);
  legLMesh.castShadow = true;
  legLPivot.add(legLMesh);
  g.add(legLPivot);

  const legRPivot = new THREE.Group();
  legRPivot.position.set(0.07, 0.30, 0);
  const legRMesh = new THREE.Mesh(legGeo, dark);
  legRMesh.position.set(0, -0.14, 0);
  legRMesh.castShadow = true;
  legRPivot.add(legRMesh);
  g.add(legRPivot);

  return { group: g, head, body, armL, armR, legL: legLPivot, legR: legRPivot };
}

// ─── Name Label ──────────────────────────────
export function createLabel(name: string): THREE.Sprite {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 72px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillText(name, size / 2 + 3, 82);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(name, size / 2, 80);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, transparent: true }));
  sprite.scale.set(2.7, 0.84, 1);
  sprite.position.set(0, 1.4, 0);
  return sprite;
}

// ─── Building inner blocking size ─────────────
// Returns [innerW, innerD] in sub-cells for the building's footprint
function getBuildingInner(defId: string, gridW: number, gridD: number): { innerW: number; innerD: number } | 'fence' {
  if (defId === 'fence') return 'fence';
  if (defId === 'street_lamp') return { innerW: 1, innerD: 1 };
  if (defId === 'large_tree') return { innerW: 5, innerD: 5 };
  // Default 3×3 inner per cell → for multi-cell: (gridW*5-2)×(gridD*5-2)
  const totalW = gridW * SUB;
  const totalD = gridD * SUB;
  return { innerW: totalW - 2, innerD: totalD - 2 };
}

// ─── Sub-Cell Navigation Grid ──────────────────
export const SUB = 5;
const NAV = GRID * SUB; // 60

function subToWorld(sx: number, sz: number): [number, number] {
  const gx = Math.floor(sx / SUB);
  const gz = Math.floor(sz / SUB);
  const [cellWx, cellWz] = gridToWorld(gx, gz);
  const localX = ((sx % SUB) - (SUB - 1) / 2) * (SPACING / SUB);
  const localZ = ((sz % SUB) - (SUB - 1) / 2) * (SPACING / SUB);
  return [cellWx + localX, cellWz + localZ];
}

function worldToSub(wx: number, wz: number): [number, number] {
  const halfSub = (SUB - 1) / 2; // = 2 for SUB=5
  const sx = Math.round((wx + HALF) / (SPACING / SUB) + halfSub);
  const sz = Math.round((wz + HALF) / (SPACING / SUB) + halfSub);
  return [
    THREE.MathUtils.clamp(sx, 0, NAV - 1),
    THREE.MathUtils.clamp(sz, 0, NAV - 1),
  ];
}

let cachedNavGrid: boolean[][] | null = null;

export function invalidateNavCache() { cachedNavGrid = null; }

export function buildNavGrid(): boolean[][] {
  if (cachedNavGrid) return cachedNavGrid;
  const grid: boolean[][] = Array.from({ length: NAV }, () => new Array(NAV).fill(false));

  for (const pb of placedBuildings) {
    const isFence = pb.def.id === 'fence';
    const w = pb.rotation === 90 || pb.rotation === 270 ? pb.def.gridD : pb.def.gridW;
    const d = pb.rotation === 90 || pb.rotation === 270 ? pb.def.gridW : pb.def.gridD;
    const inner = getBuildingInner(pb.def.id, w, d);

    if (inner === 'fence') {
      // Fence: block continuous path from post to edge in connected directions
      for (let gx = pb.gx; gx < pb.gx + w; gx++) {
        for (let gz = pb.gz; gz < pb.gz + d; gz++) {
          const sx = gx * SUB;
          const sz = gz * SUB;
          grid[sx + 2][sz + 2] = true; // center post
          // N connection: block from center (sz+2) to north edge (sz+0)
          if (placedBuildings.some(b => b.def.id === 'fence' && b.gx === gx && b.gz === gz - 1)) {
            grid[sx + 2][sz + 0] = true;
            grid[sx + 2][sz + 1] = true;
          }
          // S connection: block from center to south edge (sz+4)
          if (placedBuildings.some(b => b.def.id === 'fence' && b.gx === gx && b.gz === gz + 1)) {
            grid[sx + 2][sz + 3] = true;
            grid[sx + 2][sz + 4] = true;
          }
          // W connection: block from center to west edge (sx+0)
          if (placedBuildings.some(b => b.def.id === 'fence' && b.gx === gx - 1 && b.gz === gz)) {
            grid[sx + 0][sz + 2] = true;
            grid[sx + 1][sz + 2] = true;
          }
          // E connection: block from center to east edge (sx+4)
          if (placedBuildings.some(b => b.def.id === 'fence' && b.gx === gx + 1 && b.gz === gz)) {
            grid[sx + 3][sz + 2] = true;
            grid[sx + 4][sz + 2] = true;
          }
        }
      }
    } else if (pb.def.id === 'farm_plot') {
      // Farm plots are fully walkable — NPCs can walk on farmland
      // No blocking needed
    } else {
      // Buildings: only outer ring is walkable
      const sx0 = pb.gx * SUB;
      const sz0 = pb.gz * SUB;
      const sx1 = (pb.gx + w) * SUB - 1;
      const sz1 = (pb.gz + d) * SUB - 1;

      for (let sx = sx0; sx <= sx1; sx++) {
        for (let sz = sz0; sz <= sz1; sz++) {
          const onRing = sx === sx0 || sx === sx1 || sz === sz0 || sz === sz1;
          if (!onRing) grid[sx][sz] = true;
        }
      }

      // Street lamp: override to only block center sub-cell
      if (pb.def.id === 'street_lamp') {
        for (let sx = sx0 + 1; sx <= sx1 - 1; sx++) {
          for (let sz = sz0 + 1; sz <= sz1 - 1; sz++) {
            if (sx === sx0 + 2 && sz === sz0 + 2) continue;
            grid[sx][sz] = false;
          }
        }
      }

      // For large_tree (inner=5×5), block all sub-cells in the cell.
      if (pb.def.id === 'large_tree') {
        for (let sx = sx0; sx <= sx1; sx++) {
          for (let sz = sz0; sz <= sz1; sz++) {
            grid[sx][sz] = true;
          }
        }
      }
    }
  }
  cachedNavGrid = grid;
  return grid;
}

// ─── Find free sub-cells adjacent to a house ──
function getHouseAdjacentSubs(homeGx: number, homeGz: number, homeW: number, homeD: number): [number, number][] {
  const result: [number, number][] = [];
  const sx0 = homeGx * SUB;
  const sz0 = homeGz * SUB;
  const sx1 = (homeGx + homeW) * SUB - 1;
  const sz1 = (homeGz + homeD) * SUB - 1;

  // Outer ring of the house's sub-cell area
  for (let sx = sx0; sx <= sx1; sx++) {
    for (let sz = sz0; sz <= sz1; sz++) {
      const onRing = sx === sx0 || sx === sx1 || sz === sz0 || sz === sz1;
      if (!onRing) continue;
      // Must be on the world grid and not occupied by another building
      if (sx < 0 || sx >= NAV || sz < 0 || sz >= NAV) continue;
      const gx = Math.floor(sx / SUB);
      const gz = Math.floor(sz / SUB);
      // Allow if this sub-cell is in a free cell, or if it's part of the house itself
      if (isCellFree(gx, gz) || (gx >= homeGx && gx < homeGx + homeW && gz >= homeGz && gz < homeGz + homeD)) {
        result.push([sx, sz]);
      }
    }
  }
  return result;
}

// ─── A* Pathfinding on sub-cell grid ───────────
const DIRS_8: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [-1, -1], [1, -1], [-1, 1],
];

function heuristic(ax: number, az: number, bx: number, bz: number): number {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
}

function findSubPath(navGrid: boolean[][], startSx: number, startSz: number, endSx: number, endSz: number): [number, number][] {
  if (startSx === endSx && startSz === endSz) return [[endSx, endSz]];

  const key = (x: number, z: number) => `${x},${z}`;
  const endKey = key(endSx, endSz);

  const openSet = new Map<string, { g: number; f: number }>();
  openSet.set(key(startSx, startSz), { g: 0, f: heuristic(startSx, startSz, endSx, endSz) });
  const closedSet = new Set<string>();
  const parents = new Map<string, string | null>();
  parents.set(key(startSx, startSz), null);

  while (openSet.size > 0) {
    let curKey: string = null!;
    let best = Infinity;
    openSet.forEach((v, k) => { if (v.f < best) { best = v.f; curKey = k; } });
    if (curKey === endKey) {
      const path: [number, number][] = [];
      let k: string | null = curKey;
      while (k) {
        const [px, pz] = k.split(',').map(Number);
        path.unshift([px, pz]);
        k = parents.get(k)!;
      }
      return path;
    }

    const cur = openSet.get(curKey)!;
    openSet.delete(curKey);
    closedSet.add(curKey);
    const [cx, cz] = curKey.split(',').map(Number);

    for (const [dx, dz] of DIRS_8) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nx >= NAV || nz < 0 || nz >= NAV) continue;
      const nKey = key(nx, nz);
      if (closedSet.has(nKey) || navGrid[nx][nz]) continue;
      if (dx !== 0 && dz !== 0) {
        if (navGrid[cx + dx][cz] || navGrid[cx][cz + dz]) continue;
      }
      const tg = cur.g + (dx !== 0 && dz !== 0 ? Math.SQRT2 : 1);
      const exist = openSet.get(nKey);
      if (!exist || tg < exist.g) {
        openSet.set(nKey, { g: tg, f: tg + heuristic(nx, nz, endSx, endSz) });
        parents.set(nKey, curKey);
      }
    }
  }
  return [];
}

function findPath(fromWx: number, fromWz: number, toWx: number, toWz: number): [number, number][] {
  const navGrid = buildNavGrid();
  const [startSx, startSz] = worldToSub(fromWx, fromWz);
  const [endSx, endSz] = worldToSub(toWx, toWz);

  // Only clear the exact start and end sub-cells (clearing a 3×3 area
  // around them would punch holes in building walls, letting NPCs walk through)
  navGrid[startSx][startSz] = false;
  navGrid[endSx][endSz] = false;

  const subPath = findSubPath(navGrid, startSx, startSz, endSx, endSz);
  if (subPath.length === 0) return [];

  return subPath.map(([sx, sz]) => subToWorld(sx, sz));
}

// ─── Spawn / Despawn ─────────────────────────
export function spawnNPC(homeGx: number, homeGz: number, homeW: number, homeD: number, scene: THREE.Scene, timeOfDay: number, name?: string, skinColor?: string, clothColor?: string, rotation?: number): NPCData {
  const skinColors = ['#f0c8a0', '#e8b88a', '#d8a878', '#f2d0b0', '#e0c098'];
  const clothColors = ['#d4a090', '#8898b0', '#8aaa90', '#c0a0a8', '#b0a8c0', '#c8b898', '#88a8b8'];

  const npc: NPCData = {
    id: `npc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: name ?? NPC_NAMES[Math.floor(Math.random() * NPC_NAMES.length)],
    homeGx, homeGz, homeW, homeD,
    group: null!,
    state: 'sleeping',
    currentGx: homeGx,
    currentGz: homeGz,
    activityTimer: 50 + Math.random() * 50,
    wanderMoveTimer: 0,
    animPhase: Math.random() * Math.PI * 2,
    facilityTarget: null,
    currentActivity: null,
    skinColor: skinColor ?? skinColors[Math.floor(Math.random() * skinColors.length)],
    clothColor: clothColor ?? clothColors[Math.floor(Math.random() * clothColors.length)],
    path: [],
    walkSpeed: 0.6 + Math.random() * 0.3,
    head: null!, body: null!, armL: null!, armR: null!, legL: null!, legR: null!,
    label: null!,
    thoughtBubble: null,
    arrivedHome: false,
  };

  const model = createNPCModel(npc.skinColor, npc.clothColor);
  npc.group = model.group;
  npc.head = model.head; npc.body = model.body; npc.armL = model.armL; npc.armR = model.armR;
  npc.legL = model.legL; npc.legR = model.legR;
  npc.label = createLabel(npc.name);
  npc.group.add(npc.label);

  // Position at a free sub-cell on the house outer ring, prefer door side
  const allAdjSubs = getHouseAdjacentSubs(homeGx, homeGz, homeW, homeD);
  // Door faces +Z in model space → after rotation, determine world door direction
  const rot = rotation ?? 0;
  const doorSide = rot === 0 ? 'szMax' : rot === 90 ? 'sxMax' : rot === 180 ? 'szMin' : 'sxMin';
  const sx0 = homeGx * SUB;
  const sz0 = homeGz * SUB;
  const sxMax = (homeGx + homeW) * SUB - 1;
  const szMax = (homeGz + homeD) * SUB - 1;
  const doorSubs = allAdjSubs.filter(([sx, sz]) => {
    if (doorSide === 'szMax') return sz === szMax;
    if (doorSide === 'szMin') return sz === sz0;
    if (doorSide === 'sxMax') return sx === sxMax;
    return sx === sx0; // sxMin
  });
  const candidates = doorSubs.length > 0 ? doorSubs : allAdjSubs;
  if (candidates.length > 0) {
    const [ssx, ssz] = candidates[Math.floor(Math.random() * candidates.length)];
    const [wx, wz] = subToWorld(ssx, ssz);
    npc.group.position.set(wx, 0, wz);
    const [cgx, cgz] = worldToGrid(wx, wz);
    npc.currentGx = cgx; npc.currentGz = cgz;
  } else {
    const [wx, wz] = gridToWorld(homeGx, homeGz);
    npc.group.position.set(wx, 0, wz);
  }

  // Determine initial state
  const t = timeOfDay;
  if (t >= 0.333 && t < 0.729) {
    npc.state = 'daytime';
    npc.group.visible = true;
  } else if (t >= 0.729 && t < 0.833) {
    npc.state = 'going_home';
    npc.group.visible = true;
    startGoingHome(npc);
  } else {
    npc.state = 'sleeping';
    npc.group.visible = false;
  }

  scene.add(npc.group);
  npcs.push(npc);
  return npc;
}

export function despawnNPC(npc: NPCData) {
  const idx = npcs.indexOf(npc);
  if (idx !== -1) npcs.splice(idx, 1);
  if (npc.group) {
    // Clean up thought bubble texture before traversing
    if (npc.thoughtBubble) {
      (npc.thoughtBubble.material as THREE.SpriteMaterial).map?.dispose();
    }
    npc.group.removeFromParent();
    npc.group.traverse(c => {
      if (c instanceof THREE.Mesh) c.geometry.dispose();
      if (c instanceof THREE.Mesh || c instanceof THREE.Sprite) {
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach(m => { m.map?.dispose(); m.dispose(); });
      }
    });
  }
}

export function despawnAllNPCs() {
  while (npcs.length > 0) despawnNPC(npcs[0]);
}

// ─── Activity Selection ──────────────────────
function findFacilities(): { gx: number; gz: number; defId: string; gw: number; gd: number }[] {
  const facilityDefIds = ['farm_plot', 'well', 'bench', 'market_stall', 'workshop', 'bakery', 'flower_bed'];
  return placedBuildings
    .filter(b => facilityDefIds.includes(b.def.id))
    .map(b => ({
      gx: b.gx, gz: b.gz, defId: b.def.id,
      gw: b.rotation === 90 || b.rotation === 270 ? b.def.gridD : b.def.gridW,
      gd: b.rotation === 90 || b.rotation === 270 ? b.def.gridW : b.def.gridD,
    }));
}

function getActivityForFacility(defId: string): string {
  for (const [key, def] of Object.entries(ACTIVITIES)) {
    if (def.facilityId === defId) return key;
  }
  return 'wandering';
}

function getAdjacentSubCell(bx: number, bz: number, bw: number, bd: number, preferFree: boolean): [number, number] | null {
  const candidates: [number, number][] = [];
  const seen = new Set<string>();
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  // Iterate over all cells in the building footprint
  for (let gx = bx; gx < bx + bw; gx++) {
    for (let gz = bz; gz < bz + bd; gz++) {
      for (const [dx, dz] of offsets) {
        const agx = THREE.MathUtils.clamp(gx + dx, 0, GRID - 1);
        const agz = THREE.MathUtils.clamp(gz + dz, 0, GRID - 1);
        // Skip cells within the building footprint itself
        if (agx >= bx && agx < bx + bw && agz >= bz && agz < bz + bd) continue;
        if (preferFree && !isCellFree(agx, agz)) continue;
        const key = `${agx},${agz}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push([agx, agz]);
      }
    }
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function startGoingHome(npc: NPCData) {
  npc.facilityTarget = null;
  npc.currentActivity = null;
  npc.arrivedHome = false;
  // Clear thought bubble
  if (npc.thoughtBubble) {
    npc.group.remove(npc.thoughtBubble);
    (npc.thoughtBubble.material as THREE.SpriteMaterial).map?.dispose();
    (npc.thoughtBubble.material as THREE.SpriteMaterial).dispose();
    npc.thoughtBubble = null;
  }
  // Reset pose
  npc.legL.rotation.x = 0; npc.legR.rotation.x = 0;
  npc.head.rotation.set(0, 0, 0);
  npc.body.rotation.set(0, 0, 0);
  npc.armL.rotation.x = 0; npc.armR.rotation.x = 0;
  // Find best reachable sub-cell on house outer ring
  const adjSubs = getHouseAdjacentSubs(npc.homeGx, npc.homeGz, npc.homeW, npc.homeD);
  if (adjSubs.length === 0) {
    npc.path = [];
    npc.arrivedHome = true;
    npc.group.visible = false;
    return;
  }

  // Try each adjacent sub-cell, find the closest reachable one
  const fromWx = npc.group.position.x;
  const fromWz = npc.group.position.z;
  let bestPath: [number, number][] = [];
  let bestDist = Infinity;
  for (const [ssx, ssz] of adjSubs) {
    const [twx, twz] = subToWorld(ssx, ssz);
    const d = Math.hypot(twx - fromWx, twz - fromWz);
    if (d >= bestDist) continue;
    const path = findPath(fromWx, fromWz, twx, twz);
    if (path.length > 0 && d < bestDist) {
      bestDist = d;
      bestPath = path;
    }
  }
  npc.path = bestPath;
  if (bestPath.length === 0) {
    // Nowhere to go — just disappear
    npc.arrivedHome = true;
    npc.group.visible = false;
  }
}

function pickNewActivity(npc: NPCData, timeOfDay: number) {
  // Clear previous thought bubble (will reappear when arriving at new destination)
  if (npc.thoughtBubble) {
    npc.group.remove(npc.thoughtBubble);
    (npc.thoughtBubble.material as THREE.SpriteMaterial).map?.dispose();
    (npc.thoughtBubble.material as THREE.SpriteMaterial).dispose();
    npc.thoughtBubble = null;
  }
  npc.currentActivity = null;
  // Reset pose
  npc.legL.rotation.x = 0; npc.legR.rotation.x = 0;
  npc.head.rotation.set(0, 0, 0);
  npc.body.rotation.set(0, 0, 0);
  npc.armL.rotation.x = 0; npc.armR.rotation.x = 0;
  npc.group.position.y = 0;

  // If NPC was on a bench, nudge to walkable outer-ring cell so they
  // don't start pathfinding from the blocked bench center
  if (npc.facilityTarget?.defId === 'bench') {
    const navGrid = buildNavGrid();
    const sx0 = npc.facilityTarget.gx * SUB;
    const sz0 = npc.facilityTarget.gz * SUB;
    const sx1 = sx0 + SUB - 1;
    const sz1 = sz0 + SUB - 1;
    const [curSx, curSz] = worldToSub(npc.group.position.x, npc.group.position.z);
    let bestSx = -1, bestSz = -1, bestD = Infinity;
    for (let sx = sx0; sx <= sx1; sx++) {
      for (let sz = sz0; sz <= sz1; sz++) {
        const onRing = sx === sx0 || sx === sx1 || sz === sz0 || sz === sz1;
        if (!onRing || navGrid[sx][sz]) continue;
        const d = Math.abs(sx - curSx) + Math.abs(sz - curSz);
        if (d < bestD) { bestD = d; bestSx = sx; bestSz = sz; }
      }
    }
    if (bestSx >= 0) {
      const [wx, wz] = subToWorld(bestSx, bestSz);
      npc.group.position.x = wx;
      npc.group.position.z = wz;
    }
  }

  const facilities = findFacilities();
  const fromWx = npc.group.position.x;
  const fromWz = npc.group.position.z;

  // 12:00-13:00 lunch preference
  const lunchTime = timeOfDay >= 0.5 && timeOfDay < 0.542;
  let preferredFacilities = facilities;
  if (lunchTime && facilities.length > 0) {
    const lunchFacs = facilities.filter(f => f.defId === 'bench' || f.defId === 'bakery');
    if (lunchFacs.length > 0 && Math.random() < 0.7) {
      preferredFacilities = lunchFacs;
    }
  }

  if (preferredFacilities.length > 0 && Math.random() < 0.85) {
    // Group facilities by type for fair type-level selection
    const byType = new Map<string, typeof preferredFacilities>();
    for (const f of preferredFacilities) {
      if (!byType.has(f.defId)) byType.set(f.defId, []);
      byType.get(f.defId)!.push(f);
    }
    const types = [...byType.keys()].sort(() => Math.random() - 0.5);
    // Lunch preference: boost bench/bakery by duplicating them in the type list
    if (lunchTime) {
      for (const t of ['bench', 'bakery']) {
        if (byType.has(t)) types.push(t);
      }
    }

    for (const defId of types) {
      const facs = [...(byType.get(defId)!)].sort(() => Math.random() - 0.5);
      for (const fac of facs) {
        let targetWx: number, targetWz: number;

        if (fac.defId === 'bench') {
          // Target a walkable outer-ring sub-cell of the bench cell.
          // The center sub-cell is surrounded by blocked inner cells, making it
          // unreachable via A* (corner-cutting guard blocks diagonal entry).
          // We pathfind to an outer-ring cell, then snap to the center on arrival.
          const navGrid = buildNavGrid();
          const sx0 = fac.gx * SUB, sz0 = fac.gz * SUB;
          const sx1 = (fac.gx + 1) * SUB - 1, sz1 = (fac.gz + 1) * SUB - 1;
          let bestSx = -1, bestSz = -1, bestD = Infinity;
          for (let sx = sx0; sx <= sx1; sx++) {
            for (let sz = sz0; sz <= sz1; sz++) {
              const onRing = sx === sx0 || sx === sx1 || sz === sz0 || sz === sz1;
              if (!onRing || navGrid[sx][sz]) continue;
              const [wx, wz] = subToWorld(sx, sz);
              const d = Math.hypot(wx - fromWx, wz - fromWz);
              if (d < bestD) { bestD = d; bestSx = sx; bestSz = sz; }
            }
          }
          if (bestSx < 0) continue;
          [targetWx, targetWz] = subToWorld(bestSx, bestSz);
        } else if (fac.defId === 'farm_plot' || fac.defId === 'market_stall' || fac.defId === 'flower_bed') {
          const navGrid = buildNavGrid();
          const fb = placedBuildings.find(b => b.gx === fac.gx && b.gz === fac.gz && b.def.id === fac.defId);
          const fw = fb ? (fb.rotation === 90 || fb.rotation === 270 ? fb.def.gridD : fb.def.gridW) : 1;
          const fd = fb ? (fb.rotation === 90 || fb.rotation === 270 ? fb.def.gridW : fb.def.gridD) : 1;
          const sx0 = fac.gx * SUB;
          const sz0 = fac.gz * SUB;
          const sx1 = (fac.gx + fw) * SUB - 1;
          const sz1 = (fac.gz + fd) * SUB - 1;
          // Collect all walkable sub-cells, then pick randomly for natural spread
          const candidates: [number, number][] = [];
          for (let sx = sx0; sx <= sx1; sx++) {
            for (let sz = sz0; sz <= sz1; sz++) {
              if (!navGrid[sx][sz]) candidates.push([sx, sz]);
            }
          }
          if (candidates.length === 0) continue;
          const [pickSx, pickSz] = candidates[Math.floor(Math.random() * candidates.length)];
          [targetWx, targetWz] = subToWorld(pickSx, pickSz);
        } else {
          const adj = getAdjacentSubCell(fac.gx, fac.gz, fac.gw, fac.gd, true);
          if (!adj) continue;
          if (!isCellFree(adj[0], adj[1]) && !(adj[0] === npc.currentGx && adj[1] === npc.currentGz)) continue;
          [targetWx, targetWz] = gridToWorld(adj[0], adj[1]);
        }

        const path = findPath(fromWx, fromWz, targetWx, targetWz);
        if (path.length > 0) {
          npc.facilityTarget = { gx: fac.gx, gz: fac.gz, defId: fac.defId };
          npc.currentActivity = getActivityForFacility(fac.defId);
          npc.path = path;
          npc.activityTimer = 50 + Math.random() * 50;
          updateThoughtBubble(npc);
          return;
        }
      }
    }
  }

  // Wander: 1-2 game hours, reposition every ~5 game minutes
  npc.facilityTarget = null;
  npc.currentActivity = 'wandering';
  npc.wanderMoveTimer = 3.5 + Math.random() * 3;
  npc.activityTimer = 50 + Math.random() * 50;
  if (!pickWanderTarget(npc)) {
    npc.path = [];
  }
  updateThoughtBubble(npc);
}

function pickWanderTarget(npc: NPCData): boolean {
  const fromWx = npc.group.position.x;
  const fromWz = npc.group.position.z;
  const navGrid = buildNavGrid();
  const [curSx, curSz] = worldToSub(fromWx, fromWz);
  const wanderCandidates: [number, number][] = [];
  const searchRadius = 15;
  for (let sx = Math.max(0, curSx - searchRadius); sx <= Math.min(NAV - 1, curSx + searchRadius); sx++) {
    for (let sz = Math.max(0, curSz - searchRadius); sz <= Math.min(NAV - 1, curSz + searchRadius); sz++) {
      if (!navGrid[sx][sz]) wanderCandidates.push([sx, sz]);
    }
  }
  for (let i = wanderCandidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [wanderCandidates[i], wanderCandidates[j]] = [wanderCandidates[j], wanderCandidates[i]];
  }
  for (let attempt = 0; attempt < Math.min(8, wanderCandidates.length); attempt++) {
    const [tsx, tsz] = wanderCandidates[attempt];
    const [twx, twz] = subToWorld(tsx, tsz);
    const path = findPath(fromWx, fromWz, twx, twz);
    if (path.length > 0) {
      npc.path = path;
      return true;
    }
  }
  return false;
}

// ─── Activity Animation ─────────────────────
function playActivityAnimation(npc: NPCData, t: number) {
  npc.legL.rotation.x = 0;
  npc.legR.rotation.x = 0;
  npc.head.rotation.set(0, 0, 0);
  npc.body.rotation.set(0, 0, 0);

  const act = npc.currentActivity;
  switch (act) {
    case 'farming': {
      // Bending forward, hoeing: body tilted, arms swing from shoulders
      npc.body.rotation.x = 0.55;
      npc.head.rotation.x = 0.2;
      const hoe = Math.sin(t * 2.8) * 0.5;
      npc.armL.rotation.x = hoe;
      npc.armR.rotation.x = hoe;
      break;
    }
    case 'draw_water': {
      // Pumping: arms alternate up/down
      const pump = Math.sin(t * 2.5) * 0.6;
      npc.armL.rotation.x = pump;
      npc.armR.rotation.x = -pump;
      break;
    }
    case 'resting': {
      // Sitting on bench: legs forward, gentle breathing
      npc.legL.rotation.x = Math.PI / 2;
      npc.legR.rotation.x = Math.PI / 2;
      const breathe = Math.sin(t * 1.2) * 0.05;
      npc.armL.rotation.x = breathe;
      npc.armR.rotation.x = -breathe;
      break;
    }
    case 'shopping': {
      // Browsing: gesturing, looking around
      npc.armL.rotation.x = Math.sin(t * 1.8) * 0.25;
      npc.armR.rotation.x = Math.sin(t * 2.2) * 0.3;
      npc.head.rotation.y = Math.sin(t * 1.0) * 0.25;
      break;
    }
    case 'crafting': {
      // Hammering: right arm strikes, left holds steady
      const strike = (1 - Math.cos(t * 6.0)) / 2 * 1.0;
      npc.armL.rotation.x = -0.4;
      npc.armR.rotation.x = -strike;
      break;
    }
    case 'baking': {
      // Kneading: both arms push/pull alternately
      const knead = Math.sin(t * 3.0) * 0.4;
      npc.armL.rotation.x = -0.3 + knead;
      npc.armR.rotation.x = -0.3 - knead;
      break;
    }
    case 'flower_gazing': {
      // Admiring flowers: arms behind back, head tilted down, gentle sway
      const sway = Math.sin(t * 0.8) * 0.06;
      npc.armL.rotation.x = 0.6 + sway;
      npc.armR.rotation.x = 0.6 - sway;
      npc.head.rotation.x = 0.2; // look down at flowers
      break;
    }
    default: {
      // Idle breathing
      const idle = Math.sin(t * 1.5) * 0.03;
      npc.armL.rotation.x = idle;
      npc.armR.rotation.x = -idle;
      break;
    }
  }
}

// ─── State Resolution ────────────────────────
function resolveState(timeOfDay: number): NPCState {
  if (timeOfDay >= 0.333 && timeOfDay < 0.729) return 'daytime';   // 8:00-17:30
  if (timeOfDay >= 0.729 && timeOfDay < 0.833) return 'going_home'; // 17:30-20:00
  return 'sleeping';                                                  // 20:00-8:00
}

// ─── Update ──────────────────────────────────
let animTime = 0;

export function updateNPCs(dt: number, timeOfDay: number, timeSpeed: number, _scene: THREE.Scene) {
  const effectiveDt = timeSpeed > 0 ? dt * timeSpeed : 0;
  animTime += effectiveDt;
  const newState = resolveState(timeOfDay);

  for (const npc of npcs) {
    // State transition
    if (npc.state !== newState) {
      const prevState = npc.state;
      npc.state = newState;

      if (newState === 'daytime') {
        // 8:00 — spawn outside house
        if (prevState === 'sleeping') {
          const adjSubs = getHouseAdjacentSubs(npc.homeGx, npc.homeGz, npc.homeW, npc.homeD);
          if (adjSubs.length > 0) {
            const [ssx, ssz] = adjSubs[Math.floor(Math.random() * adjSubs.length)];
            const [wx, wz] = subToWorld(ssx, ssz);
            npc.group.position.set(wx, 0, wz);
            const [cgx, cgz] = worldToGrid(wx, wz);
            npc.currentGx = cgx; npc.currentGz = cgz;
          }
          npc.group.visible = true;
          npc.arrivedHome = false;
        }
        pickNewActivity(npc, timeOfDay);
      } else if (newState === 'going_home') {
        // 17:30 — start walking home (only if not already arrived)
        if (!npc.arrivedHome) startGoingHome(npc);
      } else if (newState === 'sleeping') {
        // 20:00 — hide (if not already hidden from arriving home)
        npc.group.visible = false;
        npc.path = [];
        npc.arrivedHome = true;
      }
    }

    // Activity timer for daytime
    if (npc.state === 'daytime') {
      npc.activityTimer -= effectiveDt;
      if (npc.activityTimer <= 0) {
        pickNewActivity(npc, timeOfDay);
      }
      // Wander sub-timer: move to new position every ~5 game minutes
      if (npc.currentActivity === 'wandering') {
        npc.wanderMoveTimer -= effectiveDt;
        if (npc.wanderMoveTimer <= 0) {
          pickWanderTarget(npc);
          npc.wanderMoveTimer = 3.5 + Math.random() * 3;
        }
      }
    }

    // Check arrival at home during going_home
    if (npc.state === 'going_home' && npc.path.length === 0 && !npc.arrivedHome) {
      npc.arrivedHome = true;
      npc.group.visible = false;
    }

    // Movement along path (world-space waypoints)
    if (npc.path.length > 0 && effectiveDt > 0) {
      const [twx, twz] = npc.path[0];
      const targetPos = new THREE.Vector3(twx, 0, twz);
      const currentPos = npc.group.position.clone();
      currentPos.y = 0;
      const dist = currentPos.distanceTo(targetPos);

      if (dist < 0.08) {
        const [cgx, cgz] = worldToGrid(twx, twz);
        npc.currentGx = cgx; npc.currentGz = cgz;
        npc.path.shift();
        if (npc.path.length === 0 && npc.state === 'daytime') {
          updateThoughtBubble(npc);
          // Snap to bench center and face the bench direction
          if (npc.facilityTarget?.defId === 'bench') {
            const [cx, cz] = gridToWorld(npc.facilityTarget.gx, npc.facilityTarget.gz);
            npc.group.position.x = cx;
            npc.group.position.z = cz;
            const benchBld = placedBuildings.find(b =>
              b.def.id === 'bench' && b.gx === npc.facilityTarget!.gx && b.gz === npc.facilityTarget!.gz,
            );
            if (benchBld) {
              npc.group.rotation.y = THREE.MathUtils.degToRad(benchBld.rotation + 180);
            }
          }
        }
      } else {
        const speed = npc.walkSpeed * SPACING;
        const dir = targetPos.clone().sub(currentPos).normalize();
        const step = Math.min(speed * effectiveDt, dist);
        npc.group.position.x += dir.x * step;
        npc.group.position.z += dir.z * step;
        const angle = Math.atan2(dir.x, dir.z);
        npc.group.rotation.y = THREE.MathUtils.lerp(npc.group.rotation.y, angle, 0.15);
      }

      // Walking animation
      const swingSpeed = 8;
      const swingAmount = 0.35;
      const swing = Math.sin(animTime * swingSpeed) * swingAmount;
      npc.head.rotation.set(0, 0, 0);
      npc.body.rotation.set(0, 0, 0);
      npc.armL.rotation.x = swing;
      npc.armR.rotation.x = -swing;
      npc.legL.rotation.x = -swing * 0.35;
      npc.legR.rotation.x = swing * 0.35;
    } else if (effectiveDt > 0 && npc.group.visible) {
      playActivityAnimation(npc, animTime + npc.animPhase);
    }

    // Adjust Y when standing on farm plot (soil surface at y=0.155)
    if (npc.group.visible) {
      const [cgx, cgz] = worldToGrid(npc.group.position.x, npc.group.position.z);
      const onFarm = placedBuildings.some(b =>
        b.def.id === 'farm_plot' && cgx >= b.gx && cgx < b.gx + b.def.gridW && cgz >= b.gz && cgz < b.gz + b.def.gridD,
      );
      const onBench = npc.facilityTarget?.defId === 'bench' && npc.path.length === 0;
      npc.group.position.y = onBench ? 0.19 : (onFarm ? 0.155 : 0);
    }
  }
}
