"use client";

const DATABASE_NAME = "matchday-scoring-device";
const STORE_NAME = "identity";
const DEVICE_KEY = "device";

export type ScoringDeviceIdentity = {
  id: string;
  label: string;
};

function defaultDeviceLabel(): string {
  if (typeof navigator === "undefined") return "Scoring device";
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  return mobile ? "Mobile scoring device" : "Desktop scoring device";
}

function validIdentity(value: unknown): value is ScoringDeviceIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ScoringDeviceIdentity>;
  return (
    typeof candidate.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.id) &&
    typeof candidate.label === "string" &&
    candidate.label.length >= 1 &&
    candidate.label.length <= 80
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Scoring device storage is unavailable."));
  });
}

async function readIdentity(database: IDBDatabase): Promise<ScoringDeviceIdentity | null> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).get(DEVICE_KEY);
    request.onsuccess = () => resolve(validIdentity(request.result) ? request.result : null);
    request.onerror = () => reject(request.error ?? new Error("Scoring device identity could not be read."));
  });
}

async function writeIdentity(database: IDBDatabase, identity: ScoringDeviceIdentity): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(identity, DEVICE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Scoring device identity could not be saved."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Scoring device identity could not be saved."));
  });
}

export async function getScoringDeviceIdentity(): Promise<ScoringDeviceIdentity> {
  const database = await openDatabase();
  try {
    const existing = await readIdentity(database);
    if (existing) return existing;
    const identity = { id: crypto.randomUUID(), label: defaultDeviceLabel() };
    await writeIdentity(database, identity);
    return identity;
  } finally {
    database.close();
  }
}

export async function renameScoringDevice(label: string): Promise<ScoringDeviceIdentity> {
  const normalized = label.trim().slice(0, 80);
  if (!normalized) throw new Error("Enter a device name.");
  const database = await openDatabase();
  try {
    const current = await readIdentity(database);
    const identity = { id: current?.id ?? crypto.randomUUID(), label: normalized };
    await writeIdentity(database, identity);
    return identity;
  } finally {
    database.close();
  }
}
