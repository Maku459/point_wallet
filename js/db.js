/**
 * 永続化の土台。
 * - 主ストレージ：IndexedDB（容量が大きく、ブラウザの永続化要求の対象になる）
 * - 予備：localStorage（IndexedDB が使えない環境と、冗長コピー用）
 * - ブラウザによる自動削除を防ぐ navigator.storage.persist() の要求
 * - File System Access API による自動バックアップ先ファイルの保持
 * いずれも失敗しうるため、呼び出し側は例外とフォールバックを前提にする。
 */

const DB_NAME = 'point-wallet';
const DB_VERSION = 1;
export const ENTRY_STORE = 'entries';
export const META_STORE = 'meta';

let dbPromise = null;

function hasIndexedDB() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

export function openDB() {
  if (!hasIndexedDB()) return Promise.reject(new Error('IndexedDB を利用できません'));
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ENTRY_STORE)) db.createObjectStore(ENTRY_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      // 別タブが新しいバージョンを開いたら接続を手放す
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('別のタブが開いているため更新できません'));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });

  return dbPromise;
}

/** 全ポイントを読み出す */
export async function readAll() {
  const db = await openDB();
  const tx = db.transaction(ENTRY_STORE, 'readonly');
  const rows = await requestToPromise(tx.objectStore(ENTRY_STORE).getAll());
  await txDone(tx);
  return rows;
}

/** 全ポイントを置き換える（ひとつのトランザクションで原子的に行う） */
export async function replaceAll(entries) {
  const db = await openDB();
  const tx = db.transaction(ENTRY_STORE, 'readwrite');
  const store = tx.objectStore(ENTRY_STORE);
  store.clear();
  for (const entry of entries) store.put(entry);
  await txDone(tx);
}

export async function getMeta(key) {
  const db = await openDB();
  const tx = db.transaction(META_STORE, 'readonly');
  const value = await requestToPromise(tx.objectStore(META_STORE).get(key));
  await txDone(tx);
  return value;
}

export async function setMeta(key, value) {
  const db = await openDB();
  const tx = db.transaction(META_STORE, 'readwrite');
  tx.objectStore(META_STORE).put(value, key);
  await txDone(tx);
}

export async function deleteMeta(key) {
  const db = await openDB();
  const tx = db.transaction(META_STORE, 'readwrite');
  tx.objectStore(META_STORE).delete(key);
  await txDone(tx);
}

/* ---------------- 永続化の要求 ---------------- */

/**
 * ブラウザに「容量が不足してもこのサイトのデータを自動削除しない」よう要求する。
 * Chrome ではホーム画面への追加や利用実績があると自動的に許可される。
 * @returns {Promise<{supported: boolean, persisted: boolean}>}
 */
export async function requestPersistence() {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!storage || typeof storage.persist !== 'function') return { supported: false, persisted: false };
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) {
      return { supported: true, persisted: true };
    }
    return { supported: true, persisted: await storage.persist() };
  } catch {
    return { supported: true, persisted: false };
  }
}

/** 現在の永続化状態と使用容量 */
export async function storageStatus() {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  const status = { supported: Boolean(storage && storage.persist), persisted: false, usage: null, quota: null };
  if (!storage) return status;
  try {
    if (typeof storage.persisted === 'function') status.persisted = await storage.persisted();
    if (typeof storage.estimate === 'function') {
      const estimate = await storage.estimate();
      status.usage = estimate.usage ?? null;
      status.quota = estimate.quota ?? null;
    }
  } catch {
    /* 取得できない環境では既定値のまま返す */
  }
  return status;
}

/* ---------------- ファイルへの自動バックアップ ---------------- */

const BACKUP_HANDLE_KEY = 'backupFileHandle';

/** File System Access API が使えるか */
export function supportsFileBackup() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

/** 保存先ファイルをユーザーに選んでもらい、ハンドルを保持する */
export async function chooseBackupFile(suggestedName) {
  const handle = await window.showSaveFilePicker({
    suggestedName,
    types: [{ description: 'ポイントウォレットのバックアップ', accept: { 'application/json': ['.json'] } }],
  });
  await setMeta(BACKUP_HANDLE_KEY, handle);
  return handle;
}

export async function getBackupHandle() {
  try {
    return (await getMeta(BACKUP_HANDLE_KEY)) || null;
  } catch {
    return null;
  }
}

export async function clearBackupHandle() {
  await deleteMeta(BACKUP_HANDLE_KEY);
}

/**
 * 保存先への書き込み権限を確認する。
 * @param {boolean} prompt 必要ならユーザーに再許可を求める（ユーザー操作中のみ有効）
 */
export async function verifyBackupPermission(handle, prompt = false) {
  if (!handle || typeof handle.queryPermission !== 'function') return false;
  const options = { mode: 'readwrite' };
  if ((await handle.queryPermission(options)) === 'granted') return true;
  if (!prompt) return false;
  return (await handle.requestPermission(options)) === 'granted';
}

/** 保存先ファイルへ書き込む */
export async function writeBackupFile(handle, text) {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}
