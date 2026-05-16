// ─── IndexedDB Storage ──────────────────────

export interface SaveData {
  version: number;
  gridSize?: number; // default 12 if absent (backwards compat)
  timeOfDay: number;
  buildings: { defId: string; gx: number; gz: number; rotation: number; customName?: string }[];
  tiles?: string[][];
  npcs?: { id: string; name: string; homeGx: number; homeGz: number; homeW: number; homeD: number; homeDefId?: string; skinColor: string; clothColor: string }[];
  thumbnail?: string; // base64 PNG data URL for world preview
}

export interface WorldMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  thumbnail?: string;
}

export interface WorldRecord extends WorldMeta {
  data: SaveData;
}

const DB_NAME = 'voxel_worlds';
const DB_VERSION = 1;
const STORE = 'worlds';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

// ─── World CRUD ─────────────────────────────

export async function getWorldList(): Promise<WorldMeta[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      resolve(req.result.map((r: WorldRecord) => ({
        id: r.id, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt,
        thumbnail: r.data?.thumbnail,
      })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadWorld(id: string): Promise<WorldRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveWorld(id: string, name: string, data: SaveData): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const existing = store.get(id);
    existing.onsuccess = () => {
      const now = new Date().toISOString();
      const record: WorldRecord = existing.result
        ? { ...existing.result, name, data, updatedAt: now }
        : { id, name, data, createdAt: now, updatedAt: now };
      store.put(record);
    };
    existing.onerror = () => reject(existing.error);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

export async function renameWorld(id: string, newName: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      if (!req.result) { resolve(); return; }
      const record = req.result;
      record.name = newName;
      record.updatedAt = new Date().toISOString();
      store.put(record);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteWorld(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

export async function createWorld(name: string, gridSize: number = 12): Promise<WorldMeta> {
  const id = `world_${Date.now()}`;
  const now = new Date().toISOString();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const record: WorldRecord = {
      id, name, createdAt: now, updatedAt: now,
      data: { version: 1, gridSize, timeOfDay: 0.35, buildings: [], tiles: [], npcs: [] },
    };
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => { db.close(); resolve({ id, name, createdAt: now, updatedAt: now }); };
    tx.onerror = () => reject(tx.error);
  });
}

// ─── Migrate from localStorage ──────────────

export async function migrateFromLocalStorage(): Promise<boolean> {
  const oldSave = localStorage.getItem('voxel_world_save');
  const exitSave = localStorage.getItem('voxel_exit_save');

  // Prefer exit save (more recent), then old save
  const raw = exitSave ?? oldSave;
  if (!raw) return false;

  try {
    let saveData: SaveData;
    let worldName = '我的第一个世界';

    if (exitSave) {
      const parsed = JSON.parse(exitSave);
      saveData = parsed.data;
      worldName = parsed.name ?? worldName;
      localStorage.removeItem('voxel_exit_save');
    } else {
      saveData = JSON.parse(raw);
    }

    await createWorld(worldName);
    const list = await getWorldList();
    if (list.length > 0) {
      await saveWorld(list[0].id, worldName, saveData);
      localStorage.removeItem('voxel_world_save');
      return true;
    }
  } catch { /* corrupt */ }
  return false;
}
