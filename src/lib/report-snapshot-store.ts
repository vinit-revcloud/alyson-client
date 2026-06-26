/** Indexed localStorage snapshots for large report payloads (per date-range key). */

const MAX_ENTRIES = 12;

type SnapshotEntry<T> = {
  at: number;
  data: T;
};

type SnapshotIndex = {
  version: 1;
  keys: string[];
};

function readIndex(indexKey: string): SnapshotIndex {
  if (typeof window === "undefined") return { version: 1, keys: [] };
  try {
    const raw = localStorage.getItem(indexKey);
    if (!raw) return { version: 1, keys: [] };
    const parsed = JSON.parse(raw) as SnapshotIndex;
    if (parsed?.version !== 1 || !Array.isArray(parsed.keys)) return { version: 1, keys: [] };
    return parsed;
  } catch {
    return { version: 1, keys: [] };
  }
}

function writeIndex(indexKey: string, index: SnapshotIndex) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(indexKey, JSON.stringify(index));
  } catch {
    // ignore
  }
}

function dataKey(prefix: string, snapshotKey: string) {
  return `${prefix}:data:${snapshotKey.replace(/[|:]/g, "_")}`;
}

export function readReportSnapshot<T>(args: {
  indexKey: string;
  dataPrefix: string;
  snapshotKey: string;
}): T | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(dataKey(args.dataPrefix, args.snapshotKey));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as SnapshotEntry<T>;
    return parsed?.data;
  } catch {
    return undefined;
  }
}

export function writeReportSnapshot<T>(args: {
  indexKey: string;
  dataPrefix: string;
  snapshotKey: string;
  data: T;
}) {
  if (typeof window === "undefined") return;
  const entry: SnapshotEntry<T> = { at: Date.now(), data: args.data };
  const dk = dataKey(args.dataPrefix, args.snapshotKey);

  try {
    localStorage.setItem(dk, JSON.stringify(entry));
  } catch {
    return;
  }

  const index = readIndex(args.indexKey);
  let keys = [args.snapshotKey, ...index.keys.filter((k) => k !== args.snapshotKey)];
  while (keys.length > MAX_ENTRIES) {
    const evict = keys.pop();
    if (evict) localStorage.removeItem(dataKey(args.dataPrefix, evict));
  }
  writeIndex(args.indexKey, { version: 1, keys });
}

export function migrateSessionStorageToLocalStorage(sessionKey: string, localKey: string) {
  if (typeof window === "undefined") return;
  try {
    if (localStorage.getItem(localKey)) return;
    const raw = sessionStorage.getItem(sessionKey);
    if (!raw) return;
    localStorage.setItem(localKey, raw);
    sessionStorage.removeItem(sessionKey);
  } catch {
    // ignore
  }
}
