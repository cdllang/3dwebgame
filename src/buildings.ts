import * as THREE from 'three';

// ─── Material ───────────────────────────────
const matCache = new Map<string, THREE.MeshStandardMaterial>();
function mat(hex: string, opts?: { transparent?: boolean; opacity?: number }): THREE.MeshStandardMaterial {
  const key = hex + '|' + (opts?.transparent ? '1' : '0') + '|' + (opts?.opacity ?? '1');
  if (matCache.has(key)) return matCache.get(key)!;
  const m = new THREE.MeshStandardMaterial({
    color: hex, roughness: 0.9, metalness: 0,
    transparent: opts?.transparent ?? false,
    opacity: opts?.opacity ?? 1,
    depthWrite: opts?.transparent ? (opts?.opacity ?? 1) > 0.9 : true,
  });
  matCache.set(key, m);
  return m;
}

// ─── Roof geometry helper ───────────────────
function roofGeo(w: number, d: number, h: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const hw = w / 2;
  shape.moveTo(-hw, 0);
  shape.lineTo(0, h);
  shape.lineTo(hw, 0);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
}

function mesh(geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, shadow = true): THREE.Mesh {
  const mh = new THREE.Mesh(geo, m);
  mh.position.set(x, y, z);
  if (shadow) { mh.castShadow = true; mh.receiveShadow = true; }
  return mh;
}

// ─── Voxel helpers (refined models) ────────
const U = 0.25; // base voxel unit for fine detail
function B(sx: number, sy: number, sz: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(sx * U, sy * U, sz * U);
}

// ─── Window material ───────────────────────
const windowMat = new THREE.MeshStandardMaterial({
  color: '#fff8e0', roughness: 0.3, metalness: 0,
  emissive: '#ffe8c0', emissiveIntensity: 0.15,
});
const windowGeo = new THREE.BoxGeometry(0.25, 0.35, 0.04);
const doorMat = new THREE.MeshStandardMaterial({ color: '#6b4226', roughness: 0.85, metalness: 0 });
const doorGeo = new THREE.BoxGeometry(0.4, 0.8, 0.05);

// Refined window/door materials
const windowFrameMat = mat('#8b7355');
const sillMat = mat('#c8b898');
const shutterMat = mat('#a08060');
const doorFrameMat = mat('#8b7355');
const stepMat = mat('#c0b8a8');

function addWindow(g: THREE.Group, x: number, y: number, z: number, rotY: number = 0) {
  const w = new THREE.Mesh(windowGeo, windowMat);
  w.position.set(x, y, z);
  w.rotation.y = rotY;
  w.userData.isHouseWindow = true;
  g.add(w);
}

function addDoor(g: THREE.Group, x: number, y: number, z: number, rotY: number = 0) {
  const d = new THREE.Mesh(doorGeo, doorMat);
  d.position.set(x, y, z);
  d.rotation.y = rotY;
  d.userData.isDoor = true;
  g.add(d);
}

// ─── Refined window/door helpers ──────────────
function addWindowDetailed(g: THREE.Group, wx: number, wy: number, wz: number, rotY: number = 0, hasShutters: boolean = false, hScale: number = 1) {
  const wg = new THREE.Group();
  const gh = 5 * hScale;
  const fh = gh + 0.4;
  const halfGH = gh / 2;
  const glass = mesh(B(3, gh, 0.2), windowMat, 0, 0, 0);
  glass.userData.isHouseWindow = true;
  wg.add(glass);
  wg.add(mesh(B(3.4, 0.6, 0.3), windowFrameMat, 0, (halfGH + 0.2) * U, 0.05));
  wg.add(mesh(B(3.4, 0.6, 0.3), windowFrameMat, 0, -(halfGH + 0.2) * U, 0.05));
  wg.add(mesh(B(0.6, fh, 0.3), windowFrameMat, 1.7 * U, 0, 0.05));
  wg.add(mesh(B(0.6, fh, 0.3), windowFrameMat, -1.7 * U, 0, 0.05));
  wg.add(mesh(B(4, 0.6, 0.8), sillMat, 0, -(halfGH + 0.6) * U, 0.2));
  if (hasShutters) {
    wg.add(mesh(B(1.4, gh, 0.3), shutterMat, 2.1 * U, 0, 0.1));
    wg.add(mesh(B(1.4, gh, 0.3), shutterMat, -2.1 * U, 0, 0.1));
  }
  wg.position.set(wx, wy, wz);
  wg.rotation.y = rotY;
  g.add(wg);
}

function addDoorDetailed(g: THREE.Group, dx: number, dy: number, dz: number, rotY: number = 0) {
  const dg = new THREE.Group();
  const door = mesh(B(3.2, 7, 0.4), doorMat, 0, 0.8 * U, 0);
  door.userData.isDoor = true;
  dg.add(door);
  dg.add(mesh(B(3.6, 0.6, 0.5), doorFrameMat, 0, 4.2 * U, 0.05));
  dg.add(mesh(B(0.6, 7.6, 0.5), doorFrameMat, 1.9 * U, 0.8 * U, 0.05));
  dg.add(mesh(B(0.6, 7.6, 0.5), doorFrameMat, -1.9 * U, 0.8 * U, 0.05));
  dg.add(mesh(B(4.5, 0.8, 0.8), stepMat, 0, -dy, 0.3));
  dg.position.set(dx, dy, dz);
  dg.rotation.y = rotY;
  g.add(dg);
}

// ─── Refined building helpers ─────────────────
function addFoundation(g: THREE.Group, w: number, d: number) {
  const stoneColors = ['#c0b8a8', '#b8b0a0', '#c8c0b0', '#b0a898'];
  for (let ix = 0; ix < w; ix++) {
    for (let iz = 0; iz < d; iz++) {
      const c = stoneColors[(ix + iz * 3) % stoneColors.length];
      const bx = (-(w - 1) / 2 + ix) * U;
      const bz = (-(d - 1) / 2 + iz) * U;
      g.add(mesh(B(1, 1.5, 1), mat(c), bx, 0.75 * U, bz));
    }
  }
}

function addTexturedWall(g: THREE.Group, w: number, h: number, d: number, baseY: number, baseColor: string, variationColors: string[]) {
  const colors = [baseColor, ...variationColors];
  const bodyW = w * U, bodyH = h * U, bodyD = d * U;
  const hw = bodyW / 2, hd = bodyD / 2;
  for (let row = 0; row < h; row++) {
    const y = baseY + row * U + U / 2;
    for (let col = 0; col < w; col++) {
      const x = -hw + col * U + U / 2;
      const ci = (row * 7 + col * 3) % colors.length;
      g.add(mesh(B(1, 1, 0.5), mat(colors[ci]), x, y, hd + U * 0.2));
      g.add(mesh(B(1, 1, 0.5), mat(colors[(ci + 2) % colors.length]), x, y, -hd - U * 0.2));
    }
  }
  for (let row = 0; row < h; row++) {
    const y = baseY + row * U + U / 2;
    for (let col = 0; col < d; col++) {
      const z = -hd + col * U + U / 2;
      const ci = (row * 5 + col * 3) % colors.length;
      g.add(mesh(B(0.5, 1, 1), mat(colors[ci]), hw + U * 0.2, y, z));
      g.add(mesh(B(0.5, 1, 1), mat(colors[(ci + 2) % colors.length]), -hw - U * 0.2, y, z));
    }
  }
  const cornerC = variationColors[0] || baseColor;
  for (let row = 0; row < h; row++) {
    const y = baseY + row * U + U / 2;
    g.add(mesh(B(0.7, 1, 0.7), mat(cornerC), hw, y, hd));
    g.add(mesh(B(0.7, 1, 0.7), mat(cornerC), -hw, y, hd));
    g.add(mesh(B(0.7, 1, 0.7), mat(cornerC), hw, y, -hd));
    g.add(mesh(B(0.7, 1, 0.7), mat(cornerC), -hw, y, -hd));
  }
}

function addGableRoof(g: THREE.Group, w: number, d: number, h: number, baseY: number, color1: string, color2: string) {
  const rw = w * U, rd = d * U, rh = h * U;
  g.add(mesh(new THREE.BoxGeometry(rw + 0.2, 0.15, 0.3), mat('#8b7355'), 0, baseY + rh, 0));
  const tileH = 0.18;
  const rows = Math.ceil(rh / tileH);
  for (let row = 0; row < rows; row++) {
    const y = baseY + row * tileH + tileH / 2;
    const t = row / rows;
    const rowW = rw * (1 - t);
    const tc = row % 3 === 1 ? color2 : color1;
    const lt = new THREE.Mesh(new THREE.BoxGeometry(rowW / 2, tileH, rd + 0.1), mat(tc));
    lt.position.set(-rowW / 4, y, 0);
    lt.castShadow = true; lt.receiveShadow = true;
    g.add(lt);
    const rt = new THREE.Mesh(new THREE.BoxGeometry(rowW / 2, tileH, rd + 0.1), mat(tc));
    rt.position.set(rowW / 4, y, 0);
    rt.castShadow = true; rt.receiveShadow = true;
    g.add(rt);
  }
  g.add(mesh(new THREE.BoxGeometry(rw + 0.4, 0.12, rd + 0.4), mat('#a09080'), 0, baseY + 0.06, 0));
}

function addChimney(g: THREE.Group, cx: number, cz: number, baseY: number, height: number) {
  const stoneColors = ['#b0a898', '#a89888', '#c0b8a8', '#a09080'];
  const h = height * U;
  for (let i = 0; i < 6; i++) {
    const y = baseY + i * 0.35;
    g.add(mesh(new THREE.BoxGeometry(0.5, 0.35, 0.5), mat(stoneColors[i % 4]), cx, y, cz));
  }
  g.add(mesh(new THREE.BoxGeometry(0.35, 0.4, 0.35), mat('#8b7355'), cx, baseY + h + 0.2, cz));
  g.add(mesh(new THREE.BoxGeometry(0.6, 0.1, 0.6), mat('#a09080'), cx, baseY + h, cz));
}

// ─── Offset helpers (for side wings) ─────────
function addTexturedWallAt(g: THREE.Group, w: number, h: number, d: number, baseY: number, baseColor: string, variationColors: string[], offsetX: number, offsetZ: number) {
  const colors = [baseColor, ...variationColors];
  const bodyW = w * U, bodyH = h * U, bodyD = d * U;
  const hw = bodyW / 2, hd = bodyD / 2;
  for (let row = 0; row < h; row++) {
    const y = baseY + row * U + U / 2;
    for (let col = 0; col < w; col++) {
      const x = -hw + col * U + U / 2;
      const ci = (row * 7 + col * 3) % colors.length;
      g.add(mesh(B(1, 1, 0.5), mat(colors[ci]), offsetX + x, y, offsetZ + hd + U * 0.2));
      g.add(mesh(B(1, 1, 0.5), mat(colors[(ci + 2) % colors.length]), offsetX + x, y, offsetZ - hd - U * 0.2));
    }
  }
  for (let row = 0; row < h; row++) {
    const y = baseY + row * U + U / 2;
    for (let col = 0; col < d; col++) {
      const z = -hd + col * U + U / 2;
      const ci = (row * 5 + col * 3) % colors.length;
      g.add(mesh(B(0.5, 1, 1), mat(colors[ci]), offsetX + hw + U * 0.2, y, offsetZ + z));
      g.add(mesh(B(0.5, 1, 1), mat(colors[(ci + 2) % colors.length]), offsetX - hw - U * 0.2, y, offsetZ + z));
    }
  }
}

function addGableRoofAt(g: THREE.Group, w: number, d: number, h: number, baseY: number, color1: string, color2: string, ox: number, oz: number, rotY: number, noRidge: boolean = false) {
  const rg = new THREE.Group();
  const rw = w * U, rd = d * U, rh = h * U;
  if (!noRidge) rg.add(mesh(new THREE.BoxGeometry(rw + 0.2, 0.15, 0.3), mat('#8b7355'), 0, baseY + rh, 0));
  const tileH = 0.18;
  const rows = Math.ceil(rh / tileH);
  for (let row = 0; row < rows; row++) {
    const y = baseY + row * tileH + tileH / 2;
    const t = row / rows;
    const rowW = rw * (1 - t);
    const tc = row % 3 === 1 ? color2 : color1;
    const lt = new THREE.Mesh(new THREE.BoxGeometry(rowW / 2, tileH, rd + 0.1), mat(tc));
    lt.position.set(-rowW / 4, y, 0);
    lt.castShadow = true; lt.receiveShadow = true;
    rg.add(lt);
    const rt = new THREE.Mesh(new THREE.BoxGeometry(rowW / 2, tileH, rd + 0.1), mat(tc));
    rt.position.set(rowW / 4, y, 0);
    rt.castShadow = true; rt.receiveShadow = true;
    rg.add(rt);
  }
  rg.add(mesh(new THREE.BoxGeometry(rw + 0.4, 0.12, rd + 0.4), mat('#a09080'), 0, baseY + 0.06, 0));
  rg.position.set(ox, 0, oz);
  rg.rotation.y = rotY;
  g.add(rg);
}

// ══════════════════════════════════════════════
// 房屋类
// ══════════════════════════════════════════════

export interface HouseOptions {
  bodyColor?: string;
  roofColor?: string;
}

function darken(hex: string, amount: number): string {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount);
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount);
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function lighten(hex: string, amount: number): string {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + amount);
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + amount);
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + amount);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

export function createSmallWoodenHouse(opts?: HouseOptions): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09; // raise above ground tile
  g.add(inner);
  const W = 5; const D = 5; const H = 6;
  const bodyC = opts?.bodyColor ?? '#f2d8c0';
  const roofC = opts?.roofColor ?? '#d4a090';
  const v = [darken(bodyC, 20), lighten(bodyC, 10), darken(bodyC, 5), darken(bodyC, 35)];

  addFoundation(inner, W + 1, D + 1);
  addTexturedWall(inner, W, H, D, 1.5 * U, bodyC, v);
  addGableRoof(inner, W + 3, D + 3, 5, (1.5 + H) * U, roofC, darken(roofC, 30));
  addChimney(inner, 1.0, 0.5, (1.5 + H) * U, 4);

  addWindowDetailed(inner, -(W/2 + 0.6) * U, (1.5 + 3) * U, 0, -Math.PI/2, false, 0.6);
  addWindowDetailed(inner, (W/2 + 0.6) * U, (1.5 + 3) * U, 0, Math.PI/2, false, 0.6);

  addDoorDetailed(inner, 0, 1.5 * U, (D/2 + 0.5) * U, 0);

  return g;
}

export function createStoneCottage(): THREE.Group {
  return createSmallWoodenHouse({ bodyColor: '#c8d8e8', roofColor: '#8898b0' });
}

export function createMediumWoodenHouse(opts?: HouseOptions): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09;
  g.add(inner);
  const bodyC = opts?.bodyColor ?? '#c0d8c4';
  const roofC = opts?.roofColor ?? '#8aaa90';
  const W = 10; const D = 10; const H = 8;
  const v = [darken(bodyC, 20), lighten(bodyC, 10), darken(bodyC, 5), darken(bodyC, 35)];

  addFoundation(inner, W + 1, D + 1);
  addTexturedWall(inner, W, H, D, 1.5 * U, bodyC, v);
  addGableRoof(inner, W + 4, D + 4, 7, (1.5 + H) * U, roofC, darken(roofC, 30));
  addChimney(inner, 2.0, 0.8, (1.5 + H) * U, 5);

  addDoorDetailed(inner, 0, 1.5 * U, (D/2 + 0.5) * U, 0);
  inner.add(mesh(B(5, 0.3, 2.5), mat(roofC), 0, (1.5 + 4.5) * U, (D/2 + 1.2) * U));

  const plaqueZ = (D/2 + 0.4 + 0.3) * U;
  const plaqueY = (1.5 + 6.5) * U;
  inner.add(mesh(B(7, 2, 0.3), mat('#d4c0a0'), 0, plaqueY, plaqueZ));
  const pCanvas = document.createElement('canvas'); pCanvas.width = 512; pCanvas.height = 128;
  const pctx = pCanvas.getContext('2d')!;
  pctx.fillStyle = '#5a4030';
  pctx.font = 'bold 90px "Segoe UI Emoji", "Segoe UI", system-ui, sans-serif';
  pctx.textAlign = 'center'; pctx.textBaseline = 'middle';
  pctx.fillText('中型木屋', 256, 64);
  const pTex = new THREE.CanvasTexture(pCanvas); pTex.minFilter = THREE.LinearFilter;
  const textPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.375),
    new THREE.MeshBasicMaterial({ map: pTex, transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide })
  );
  textPlane.position.set(0, plaqueY, plaqueZ + 0.06);
  textPlane.userData.noMerge = true;
  textPlane.userData.isPlaque = true;
  textPlane.userData.plaqueFont = 'bold 90px "Segoe UI Emoji", "Segoe UI", system-ui, sans-serif';
  inner.add(textPlane);

  addWindowDetailed(inner, -(W/2 + 0.65) * U, (1.5 + 4.5) * U, 0, -Math.PI/2, true);
  addWindowDetailed(inner, (W/2 + 0.65) * U, (1.5 + 4.5) * U, 0, Math.PI/2, true);

  // Dormer window
  const dormerY = (1.5 + H) * U + 0.7;
  const dormer = new THREE.Group();
  dormer.add(mesh(B(3, 3, 2), mat(bodyC), 0, 0.4, 0));
  dormer.add(mesh(B(4, 0.3, 3), mat(roofC), 0, 0.9, 0));
  dormer.add(mesh(B(3.4, 0.5, 0.3), windowFrameMat, 0, 0.5, 1.05));
  dormer.add(mesh(B(3.4, 0.5, 0.3), windowFrameMat, 0, -0.15, 1.05));
  const dGlass = mesh(B(3, 2.5, 0.15), windowMat, 0, 0.18, 1.0);
  dGlass.userData.isHouseWindow = true;
  dormer.add(dGlass);
  dormer.position.set(0, dormerY, (D/2 - 1.7) * U);
  inner.add(dormer);

  return g;
}

export function createLargeHouse(opts?: HouseOptions): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09;
  g.add(inner);
  const bodyC = opts?.bodyColor ?? '#e8d0d4';
  const roofC = opts?.roofColor ?? '#c0a0a8';
  const MW = 10; const MD = 10; const MH = 9;
  const SW = 5;  const SD = 5;  const SH = 7;
  const v = [darken(bodyC, 20), lighten(bodyC, 10), darken(bodyC, 5), darken(bodyC, 35)];
  const offX = -0.8; // re-center: main wing + side wing visual balance

  addFoundation(inner, MW + 1, MD + 1);

  const swX = offX + (MW/2 + SW/2 + 2.0) * U;
  const swZ = (MD/2 - SD/2) * U;
  const foundationColors = ['#c0b8a8', '#b8b0a0', '#c8c0b0', '#b0a898'];
  for (let ix = 0; ix < SW + 1; ix++) {
    for (let iz = 0; iz < SD + 1; iz++) {
      const c = foundationColors[(ix + iz * 3) % 4];
      inner.add(mesh(B(1, 1.5, 1), mat(c), swX + (ix - SW/2) * U, 0.75 * U, swZ + (iz - SD/2) * U));
    }
  }

  addTexturedWallAt(inner, MW, MH, MD, 1.5 * U, bodyC, v, offX, 0);
  addTexturedWallAt(inner, SW, SH, SD, 1.5 * U, bodyC, v, swX, swZ);

  addGableRoofAt(inner, MW + 4, MD + 4, 7, (1.5 + MH) * U, roofC, darken(roofC, 30), offX, 0, 0, false);
  addGableRoofAt(inner, SD + 1.5, SW + 1.5, 3, (1.5 + SH) * U, roofC, darken(roofC, 30), swX, swZ, 0, true);
  addChimney(inner, offX + 2.5, 0, (1.5 + MH) * U, 5);

  addWindowDetailed(inner, offX + -(MW/2 + 0.65) * U, (1.5 + 5) * U, 0, -Math.PI/2, true);
  addWindowDetailed(inner, offX + (MW/2 + 0.65) * U, (1.5 + 5) * U, -0.6, Math.PI/2, false, 0.6);
  addWindowDetailed(inner, swX + (SW/2 + 0.65) * U, (1.5 + 4) * U, swZ, Math.PI/2, false);
  addWindowDetailed(inner, swX, (1.5 + 4) * U, swZ + (SD/2 + 0.65) * U, 0, false, 0.6);

  addDoorDetailed(inner, offX + 0.6, 2.7 * U, (MD/2 + 0.5) * U, 0);
  inner.add(mesh(B(0.8, 11, 0.8), mat('#e0d0c8'), offX - 0.8, 1.375, (MD/2 + 1.2) * U));
  inner.add(mesh(B(7, 0.3, 3), mat(roofC), offX + 0.5, (1.5 + 5.8) * U, (MD/2 + 1.5) * U));

  const plaqueZ = (MD/2 + 0.4 + 0.3) * U;
  const plaqueY = (1.5 + 7.3) * U;
  inner.add(mesh(B(7, 2, 0.3), mat('#d4c0a0'), offX + 0.5, plaqueY, plaqueZ));
  const pCanvas = document.createElement('canvas'); pCanvas.width = 512; pCanvas.height = 128;
  const pctx = pCanvas.getContext('2d')!;
  pctx.fillStyle = '#5a4030';
  pctx.font = 'bold 90px "Segoe UI Emoji", "Segoe UI", system-ui, sans-serif';
  pctx.textAlign = 'center'; pctx.textBaseline = 'middle';
  pctx.fillText('大房子', 256, 64);
  const pTex = new THREE.CanvasTexture(pCanvas); pTex.minFilter = THREE.LinearFilter;
  const textPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.375),
    new THREE.MeshBasicMaterial({ map: pTex, transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide })
  );
  textPlane.position.set(offX + 0.5, plaqueY, plaqueZ + 0.06);
  textPlane.userData.noMerge = true;
  textPlane.userData.isPlaque = true;
  textPlane.userData.plaqueFont = 'bold 90px "Segoe UI Emoji", "Segoe UI", system-ui, sans-serif';
  inner.add(textPlane);

  return g;
}

// ══════════════════════════════════════════════
// 设施类
// ══════════════════════════════════════════════

export function createFarmPlot(): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09;
  g.add(inner);

  const N = 16; // soil grid size (N*U = 4.0 world units)

  // Soil base
  for (let ix = 0; ix < N; ix++) {
    for (let iz = 0; iz < N; iz++) {
      const c = (ix + iz) % 3 === 0 ? '#b0a080' : '#a89870';
      inner.add(mesh(B(1, 0.4, 1), mat(c), (-(N - 1) / 2 + ix) * U, 0.2 * U, (-(N - 1) / 2 + iz) * U));
    }
  }
  // Crop rows
  const cropRows = 10;
  for (let row = 0; row < cropRows; row++) {
    for (let col = 0; col < N; col++) {
      const x = (-(N - 1) / 2 + col) * U;
      const z = (-(cropRows - 1) * 1.5 / 2 + row * 1.5) * U;
      inner.add(mesh(B(0.3, 1.2, 0.3), mat('#8ab860'), x, 0.9 * U, z));
    }
  }
  // Fence border
  const fenceMat = mat('#d8d0c0');
  const H = N / 2; // half extent in U units
  for (let i = 0; i <= N; i++) {
    inner.add(mesh(B(0.3, 1.5, 0.3), fenceMat, (-H + i) * U, 0.85 * U, -H * U));
    inner.add(mesh(B(0.3, 1.5, 0.3), fenceMat, (-H + i) * U, 0.85 * U, H * U));
    if (i > 0 && i < N) {
      inner.add(mesh(B(0.3, 1.5, 0.3), fenceMat, -H * U, 0.85 * U, (-H + i) * U));
      inner.add(mesh(B(0.3, 1.5, 0.3), fenceMat, H * U, 0.85 * U, (-H + i) * U));
    }
  }

  return g;
}

export function createWell(): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09;
  g.add(inner);

  const stoneColors = ['#c0b8a8', '#b8b0a0', '#c8c0b0'];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const x = Math.cos(angle) * 1.2 * U;
    const z = Math.sin(angle) * 1.2 * U;
    inner.add(mesh(B(0.8, 0.7, 0.8), mat(stoneColors[i % 3]), x, 0.35 * U, z));
  }
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const x = Math.cos(angle) * 1.2 * U;
    const z = Math.sin(angle) * 1.2 * U;
    inner.add(mesh(B(0.8, 0.7, 0.8), mat(stoneColors[(i + 1) % 3]), x, 1.05 * U, z));
  }
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(angle) * 1.4 * U;
    const z = Math.sin(angle) * 1.4 * U;
    inner.add(mesh(B(0.25, 3, 0.25), mat('#8b7355'), x, 2.2 * U, z));
  }
  inner.add(mesh(new THREE.BoxGeometry(1.2, 0.25, 1.2), mat('#d4a090'), 0, 3.7 * U, 0));

  return g;
}

export function createBench(): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09;
  g.add(inner);

  const woodMat = mat('#c8b080');
  const legMat = mat('#a09070');
  for (let ix = 0; ix < 8; ix++) {
    inner.add(mesh(B(1, 0.35, 2), woodMat, (-3.5 + ix) * U, 1.2 * U, 0));
  }
  inner.add(mesh(B(0.5, 1.5, 0.8), legMat, -1.5 * U, 0.55 * U, -0.9 * U));
  inner.add(mesh(B(0.5, 1.5, 0.8), legMat, -1.5 * U, 0.55 * U, 0.9 * U));
  inner.add(mesh(B(0.5, 1.5, 0.8), legMat, 1.5 * U, 0.55 * U, -0.9 * U));
  inner.add(mesh(B(0.5, 1.5, 0.8), legMat, 1.5 * U, 0.55 * U, 0.9 * U));
  inner.add(mesh(B(0.6, 2, 0.6), legMat, -3.5 * U, 2.3 * U, -0.9 * U));
  inner.add(mesh(B(0.6, 2, 0.6), legMat, 3.5 * U, 2.3 * U, -0.9 * U));
  for (let row = 0; row < 2; row++) {
    inner.add(mesh(B(7.5, 0.4, 0.4), woodMat, 0, (1.8 + row * 1.0) * U, -0.9 * U));
  }
  inner.add(mesh(B(0.5, 0.4, 2.2), woodMat, -2 * U, 0.9 * U, 0));
  inner.add(mesh(B(0.5, 0.4, 2.2), woodMat, 2 * U, 0.9 * U, 0));

  return g;
}

export function createStreetLamp(): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09;
  g.add(inner);

  inner.add(mesh(B(2.5, 0.6, 2.5), mat('#a0a098'), 0, 0.3 * U, 0));
  inner.add(mesh(B(1.8, 0.5, 1.8), mat('#b0b0a8'), 0, 0.85 * U, 0));
  inner.add(mesh(B(0.5, 10, 0.5), mat('#706858'), 0, 5.5 * U, 0));
  inner.add(mesh(B(2, 1.5, 2), mat('#888880'), 0, 10.5 * U, 0));

  const glowMat = new THREE.MeshStandardMaterial({
    color: '#fff8e0', roughness: 0.3, metalness: 0,
    emissive: '#ffe8c0', emissiveIntensity: 0.6,
  });
  inner.add(mesh(B(1.5, 1, 0.1), glowMat, 0, 10.5 * U, 1.1 * U));
  inner.add(mesh(B(1.5, 1, 0.1), glowMat, 0, 10.5 * U, -1.1 * U));
  inner.add(mesh(B(0.1, 1, 1.5), glowMat, 1.1 * U, 10.5 * U, 0));
  inner.add(mesh(B(0.1, 1, 1.5), glowMat, -1.1 * U, 10.5 * U, 0));
  inner.add(mesh(B(2.2, 0.3, 2.2), mat('#908880'), 0, 11.3 * U, 0));

  // Point light (off by default, toggled by day/night system)
  const lampLight = new THREE.PointLight('#ffe8c0', 0, 10);
  lampLight.position.set(0, 10.5 * U + 0.09, 0);
  lampLight.castShadow = false; // deferred to after placement (avoids ghost allocation cost)
  lampLight.userData.isStreetLight = true;
  g.add(lampLight);

  return g;
}

export function createMarketStall(): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09;
  g.add(inner);

  const W = 14; const D = 6; const H = 3; // fills 2×1 grid (4.1×2.05)
  for (let ix = 0; ix < W; ix++) {
    for (let iz = 0; iz < D; iz++) {
      const x = (-(W - 1) / 2 + ix) * U;
      const z = (-(D - 1) / 2 + iz) * U;
      inner.add(mesh(B(1, 1, 1), mat('#c8b898'), x, 0.5 * U, z));
    }
  }
  inner.add(mesh(B(W, 0.6, 1.2), mat('#a08060'), 0, (1 + 0.3) * U, (D / 2 - 1) * U));
  const postMat = mat('#b0a090');
  for (let s = -1; s <= 1; s += 2) {
    for (let f = -1; f <= 1; f += 2) {
      inner.add(mesh(B(0.4, H, 0.4), postMat, s * (W / 2 - 0.5) * U, (1 + H / 2) * U, f * (D / 2 - 0.5) * U));
    }
  }
  const awningMat = mat('#e0c8b0');
  for (let ix = 0; ix < W + 2; ix++) {
    const x = (-(W + 1) / 2 + ix + 0.5) * U;
    inner.add(mesh(B(1, 0.25, D + 2), awningMat, x, (1 + H + 0.2) * U, 0));
  }

  return g;
}

export function createWorkshop(): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09;
  g.add(inner);

  const W = 8; const D = 8; const H = 7;
  const bodyC = '#d8d0c8';
  const roofC = '#a09080';
  const v = ['#c8c0b8', '#d0c8c0', '#d8d4cc', '#c0b8b0'];

  addFoundation(inner, W + 1, D + 1);
  addTexturedWall(inner, W, H, D, 1.5 * U, bodyC, v);
  addGableRoof(inner, W + 3, D + 3, 5, (1.5 + H) * U, roofC, '#908070');
  addChimney(inner, -0.8, -0.5, (1.5 + H) * U, 4.5);

  addWindowDetailed(inner, -(W / 2 + 0.6) * U, (1.5 + 3.5) * U, 0, -Math.PI / 2, false, 0.7);
  addWindowDetailed(inner, (W / 2 + 0.6) * U, (1.5 + 3.5) * U, 0, Math.PI / 2, false, 0.7);
  addDoorDetailed(inner, 0, 1.5 * U, (D / 2 + 0.5) * U, 0);

  const sz = (D / 2 + 0.45) * U, sy = (1.5 + 5.6) * U;
  inner.add(mesh(B(5, 1.5, 0.3), mat('#d4c0a0'), 0, sy, sz));
  const wc = document.createElement('canvas'); wc.width = 256; wc.height = 64;
  const wctx = wc.getContext('2d')!;
  wctx.fillStyle = '#5a4030';
  wctx.font = 'bold 48px "Segoe UI Emoji", "Segoe UI", system-ui, sans-serif';
  wctx.textAlign = 'center'; wctx.textBaseline = 'middle';
  wctx.fillText('作坊', 128, 32);
  const wt = new THREE.CanvasTexture(wc); wt.minFilter = THREE.LinearFilter;
  const wp = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.25),
    new THREE.MeshBasicMaterial({ map: wt, transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide }));
  wp.position.set(0, sy, sz + 0.06);
  wp.userData.noMerge = true;
  wp.userData.isPlaque = true;
  wp.userData.plaqueFont = 'bold 48px "Segoe UI Emoji", "Segoe UI", system-ui, sans-serif';
  inner.add(wp);

  return g;
}

export function createBakery(): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09;
  g.add(inner);

  const W = 8; const D = 8; const H = 7;
  const bodyC = '#f5e8d0';
  const roofC = '#c8a878';
  const v = ['#ead8c0', '#f0e0c8', '#f5e8d4', '#e0d0b8'];

  addFoundation(inner, W + 1, D + 1);
  addTexturedWall(inner, W, H, D, 1.5 * U, bodyC, v);
  addGableRoof(inner, W + 3, D + 3, 5, (1.5 + H) * U, roofC, '#b89868');
  addChimney(inner, 0.8, 0.5, (1.5 + H) * U, 4);

  addWindowDetailed(inner, -(W / 2 + 0.6) * U, (1.5 + 3.5) * U, 0, -Math.PI / 2, false, 0.7);
  addWindowDetailed(inner, (W / 2 + 0.6) * U, (1.5 + 3.5) * U, 0, Math.PI / 2, false, 0.7);
  addDoorDetailed(inner, 0, 1.5 * U, (D / 2 + 0.5) * U, 0);

  const sz = (D / 2 + 0.45) * U, sy = (1.5 + 5.6) * U;
  inner.add(mesh(B(5, 1.5, 0.3), mat('#d4c0a0'), 0, sy, sz));
  const bc = document.createElement('canvas'); bc.width = 256; bc.height = 64;
  const bctx = bc.getContext('2d')!;
  bctx.fillStyle = '#5a4030';
  bctx.font = 'bold 48px "Segoe UI Emoji", "Segoe UI", system-ui, sans-serif';
  bctx.textAlign = 'center'; bctx.textBaseline = 'middle';
  bctx.fillText('面包房', 128, 32);
  const bt = new THREE.CanvasTexture(bc); bt.minFilter = THREE.LinearFilter;
  const bp = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.25),
    new THREE.MeshBasicMaterial({ map: bt, transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide }));
  bp.position.set(0, sy, sz + 0.06);
  bp.userData.noMerge = true;
  bp.userData.isPlaque = true;
  bp.userData.plaqueFont = 'bold 48px "Segoe UI Emoji", "Segoe UI", system-ui, sans-serif';
  inner.add(bp);

  return g;
}

// ══════════════════════════════════════════════
// 装饰类
// ══════════════════════════════════════════════

// ─── Leaf texture ────────────────────────────
function makeLeafTex(baseGreen: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = baseGreen;
  ctx.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 200; i++) {
    const x = Math.random() * 64;
    const y = Math.random() * 64;
    const r = Math.random() * 3 + 1;
    const shade = Math.random() * 40 - 20;
    const r2 = Math.max(0, Math.min(255, parseInt(baseGreen.slice(1, 3), 16) + shade));
    const g2 = Math.max(0, Math.min(255, parseInt(baseGreen.slice(3, 5), 16) + shade));
    const b2 = Math.max(0, Math.min(255, parseInt(baseGreen.slice(5, 7), 16) + shade));
    ctx.fillStyle = 'rgb(' + r2 + ',' + g2 + ',' + b2 + ')';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}
const leafTexLight = makeLeafTex('#b0c8a0');
const leafTexMid = makeLeafTex('#98b888');
const leafTexDark = makeLeafTex('#80a878');
const leafTexPale = makeLeafTex('#c0d4b0');

function leafMat(color: string, tex: THREE.CanvasTexture): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, map: tex });
}

export function createFlowerBed(): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09;
  g.add(inner);

  const borderMat = mat('#d8d0c0');
  inner.add(mesh(B(4.4, 1, 0.4), borderMat, 0, 0.5 * U, -2 * U));
  inner.add(mesh(B(4.4, 1, 0.4), borderMat, 0, 0.5 * U, 2 * U));
  inner.add(mesh(B(0.4, 1, 4.4), borderMat, -2 * U, 0.5 * U, 0));
  inner.add(mesh(B(0.4, 1, 4.4), borderMat, 2 * U, 0.5 * U, 0));

  for (let ix = 0; ix < 4; ix++) {
    for (let iz = 0; iz < 4; iz++) {
      inner.add(mesh(B(0.9, 0.3, 0.9), mat('#a09070'), (-1.5 + ix) * U, 0.25 * U, (-1.5 + iz) * U));
    }
  }

  const flowerColors = ['#e8a0b0', '#f0c0a0', '#e0a0d0', '#f0d080', '#e08080'];
  const flowerPos: [number, number][] = [
    [-0.8, -0.6], [0.6, -0.8], [-1.0, 0.5], [0.8, 0.7],
    [-0.3, -1.0], [0.3, 1.0], [-0.6, 0.1], [1.0, -0.3],
  ];
  for (let i = 0; i < flowerPos.length; i++) {
    inner.add(mesh(B(0.3, 0.8, 0.3), mat(flowerColors[i % 5]), flowerPos[i][0] * U, 0.8 * U, flowerPos[i][1] * U));
  }

  return g;
}

export function createSmallTree(): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09;
  g.add(inner);

  inner.add(mesh(B(1, 2.5, 1), mat('#c8b898'), 0, 1.4 * U, 0));
  inner.add(mesh(B(3.5, 1.5, 3.5), leafMat('#b0c8a0', leafTexLight), 0, 2.8 * U, 0));
  inner.add(mesh(B(2.5, 1.2, 3), leafMat('#98b888', leafTexMid), -0.3, 3.3 * U, 0.2));
  inner.add(mesh(B(2.8, 1.2, 2.5), leafMat('#c0d4b0', leafTexPale), 0.3, 3.3 * U, -0.2));
  inner.add(mesh(B(2, 1, 2), leafMat('#a8c098', leafTexDark), 0, 3.8 * U, 0));

  return g;
}

export function createMediumTree(): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09;
  g.add(inner);

  inner.add(mesh(B(1.2, 3.5, 1.2), mat('#c0b090'), 0, 2 * U, 0));
  inner.add(mesh(B(4.5, 2, 4.5), leafMat('#b0c8a0', leafTexLight), 0, 3.5 * U, 0));
  inner.add(mesh(B(3.5, 1.5, 3), leafMat('#98b888', leafTexMid), -0.5, 4 * U, 0.3));
  inner.add(mesh(B(3, 1.5, 3.5), leafMat('#c0d4b0', leafTexPale), 0.4, 4 * U, -0.3));
  inner.add(mesh(B(3, 1.5, 3), leafMat('#a8c098', leafTexDark), 0, 5.2 * U, 0));
  inner.add(mesh(B(2, 1.2, 2), leafMat('#b0c8a0', leafTexLight), 0, 6 * U, 0));

  return g;
}

export function createLargeTree(): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09;
  g.add(inner);

  inner.add(mesh(B(1.5, 4.5, 1.5), mat('#b8a888'), 0, 2.5 * U, 0));
  inner.add(mesh(B(5.5, 2.5, 5.5), leafMat('#b0c8a0', leafTexLight), 0, 4.5 * U, 0));
  inner.add(mesh(B(4.5, 1.8, 4), leafMat('#98b888', leafTexMid), -0.6, 5 * U, 0.3));
  inner.add(mesh(B(4, 1.8, 4.5), leafMat('#c0d4b0', leafTexPale), 0.5, 5 * U, -0.4));
  inner.add(mesh(B(3.5, 1.5, 3.5), leafMat('#a8c098', leafTexDark), 0, 5 * U, 0));
  inner.add(mesh(B(4, 2, 4), leafMat('#b0c8a0', leafTexLight), 0, 6.2 * U, 0));
  inner.add(mesh(B(3, 1.5, 3), leafMat('#98b888', leafTexMid), 0, 7 * U, 0));
  inner.add(mesh(B(2, 1.2, 2), leafMat('#c0d4b0', leafTexPale), 0, 7.5 * U, 0));

  return g;
}

export function createFence(): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09;
  g.add(inner);

  const fMat = mat('#e0d8cc');
  const post = mesh(B(0.5, 3.5, 0.5), fMat, 0, 1.75 * U, 0);
  post.userData.isFencePost = true;
  inner.add(post);

  // NOTE: Horizontal rails are added dynamically at placement time
  // when adjacent fence posts are detected (N/S/E/W directions only).

  return g;
}

export function createScarecrow(): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = 0.09;
  g.add(inner);

  inner.add(mesh(B(0.4, 7, 0.4), mat('#b8a888'), 0, 3.5 * U, 0));
  inner.add(mesh(B(3, 0.3, 0.3), mat('#b8a888'), 0, 5 * U, 0));
  inner.add(mesh(B(1.5, 1.8, 0.8), mat('#d8c8b0'), 0, 5.8 * U, 0));
  inner.add(mesh(B(1, 1, 1), mat('#f0d8c0'), 0, 7 * U, 0));
  inner.add(mesh(B(1.4, 0.2, 1.4), mat('#6b4226'), 0, 7.6 * U, 0));
  inner.add(mesh(B(0.8, 0.8, 0.8), mat('#6b4226'), 0, 8.1 * U, 0));

  return g;
}

// ══════════════════════════════════════════════
// Registry
// ══════════════════════════════════════════════

export interface BuildingDef {
  id: string;
  name: string;
  category: 'house' | 'facility' | 'decoration';
  gridW: number;  // grid units wide (X)
  gridD: number;  // grid units deep (Z)
  factory: (opts?: HouseOptions) => THREE.Group;
  defaultOpts?: HouseOptions;
}

export const BUILDINGS: BuildingDef[] = [
  { id: 'wooden_house_small',  name: '小木屋',   category: 'house',      gridW: 1, gridD: 1, factory: createSmallWoodenHouse, defaultOpts: { bodyColor: '#f2d8c0', roofColor: '#d4a090' } },
  { id: 'stone_cottage',       name: '石头小屋', category: 'house',      gridW: 1, gridD: 1, factory: createStoneCottage },
  { id: 'wooden_house_medium', name: '中型木屋', category: 'house',      gridW: 2, gridD: 2, factory: createMediumWoodenHouse, defaultOpts: { bodyColor: '#c0d8c4', roofColor: '#8aaa90' } },
  { id: 'wooden_house_large',  name: '大房子',   category: 'house',      gridW: 3, gridD: 2, factory: createLargeHouse, defaultOpts: { bodyColor: '#e8d0d4', roofColor: '#c0a0a8' } },
  { id: 'farm_plot',           name: '农田',     category: 'facility',   gridW: 2, gridD: 2, factory: createFarmPlot },
  { id: 'well',                name: '水井',     category: 'facility',   gridW: 1, gridD: 1, factory: createWell },
  { id: 'bench',               name: '长椅',     category: 'facility',   gridW: 1, gridD: 1, factory: createBench },
  { id: 'street_lamp',         name: '路灯',     category: 'facility',   gridW: 1, gridD: 1, factory: createStreetLamp },
  { id: 'market_stall',        name: '市集摊位', category: 'facility',   gridW: 2, gridD: 1, factory: createMarketStall },
  { id: 'workshop',            name: '作坊',     category: 'facility',   gridW: 2, gridD: 2, factory: createWorkshop },
  { id: 'bakery',              name: '面包房',   category: 'facility',   gridW: 2, gridD: 2, factory: createBakery },
  { id: 'flower_bed',          name: '花坛',     category: 'decoration', gridW: 1, gridD: 1, factory: createFlowerBed },
  { id: 'small_tree',          name: '小树',     category: 'decoration', gridW: 1, gridD: 1, factory: createSmallTree },
  { id: 'medium_tree',         name: '中树',     category: 'decoration', gridW: 1, gridD: 1, factory: createMediumTree },
  { id: 'large_tree',          name: '大树',     category: 'decoration', gridW: 1, gridD: 1, factory: createLargeTree },
  { id: 'fence',               name: '栅栏',     category: 'decoration', gridW: 1, gridD: 1, factory: createFence },
  { id: 'scarecrow',           name: '稻草人',   category: 'decoration', gridW: 1, gridD: 1, factory: createScarecrow },
];

export function getBuilding(id: string): BuildingDef | undefined {
  return BUILDINGS.find(b => b.id === id);
}
