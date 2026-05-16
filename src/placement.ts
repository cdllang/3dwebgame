import * as THREE from 'three';
import { type BuildingDef } from './buildings';

// ─── Grid Occupancy ──────────────────────────
const occupied = new Set<string>();

function cellKey(gx: number, gz: number): string {
  return `${gx},${gz}`;
}

export function isCellFree(gx: number, gz: number): boolean {
  return !occupied.has(cellKey(gx, gz));
}

export function markOccupied(gx: number, gz: number, gridW: number, gridD: number): void {
  for (let x = gx; x < gx + gridW; x++) {
    for (let z = gz; z < gz + gridD; z++) {
      occupied.add(cellKey(x, z));
    }
  }
}

export function clearOccupied(gx: number, gz: number, gridW: number, gridD: number): void {
  for (let x = gx; x < gx + gridW; x++) {
    for (let z = gz; z < gz + gridD; z++) {
      occupied.delete(cellKey(x, z));
    }
  }
}

export function canPlaceAt(gx: number, gz: number, gridW: number, gridD: number): boolean {
  // All cells must be within grid bounds
  if (gx < 0 || gz < 0 || gx + gridW > GRID || gz + gridD > GRID) return false;
  for (let x = gx; x < gx + gridW; x++) {
    for (let z = gz; z < gz + gridD; z++) {
      if (!isCellFree(x, z)) return false;
    }
  }
  return true;
}

// ─── Grid Config ─────────────────────────────
export const SPACING = 2.05;
export let GRID = 12;
export function getHalf(): number { return (GRID - 1) * SPACING / 2; }
export function setGridSize(size: number): void {
  GRID = size;
  // Clear occupancy when grid size changes
  occupied.clear();
}

// ─── Tile Type Reference (set by main.ts) ─────
let _tileTypes: string[][] | null = null;
export function setTileTypesRef(ref: string[][]): void { _tileTypes = ref; }
export function getTileTypeAt(gx: number, gz: number): string | null {
  if (!_tileTypes || gx < 0 || gx >= _tileTypes.length) return null;
  const row = _tileTypes[gx];
  if (!row || gz < 0 || gz >= row.length) return null;
  return row[gz];
}

export function gridToWorld(gx: number, gz: number): [number, number] {
  const h = getHalf();
  return [gx * SPACING - h, gz * SPACING - h];
}

export function worldToGrid(wx: number, wz: number): [number, number] {
  const h = getHalf();
  return [Math.round((wx + h) / SPACING), Math.round((wz + h) / SPACING)];
}

// ─── Ghost Preview ───────────────────────────
export function applyGhostMaterial(obj: THREE.Object3D, mat: THREE.Material): void {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.material = mat;
      child.castShadow = false;
      child.receiveShadow = false;
    }
  });
}

// ─── Placement State ─────────────────────────
export type Rotation = 0 | 90 | 180 | 270;

export interface PlacedBuilding {
  id: number;
  def: BuildingDef;
  gx: number;
  gz: number;
  rotation: Rotation;
  group: THREE.Group;
  customName?: string;
}

let nextId = 1;
export const placedBuildings: PlacedBuilding[] = [];

export function addPlaced(b: PlacedBuilding): void {
  placedBuildings.push(b);
  const { gridW, gridD } = rotate(b.def, b.rotation);
  markOccupied(b.gx, b.gz, gridW, gridD);
}

// ─── Rotation Helper ─────────────────────────
export function rotate(def: BuildingDef, rot: Rotation): { gridW: number; gridD: number } {
  if (rot === 90 || rot === 270) {
    return { gridW: def.gridD, gridD: def.gridW };
  }
  return { gridW: def.gridW, gridD: def.gridD };
}
