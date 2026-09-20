/**
 * データの保存と取り出し。
 *
 * 保存先は IndexedDB を主とし、同じ内容を localStorage にも複製する。
 * どちらか一方が失われても復旧でき、IndexedDB が使えない環境では
 * localStorage だけで動作を継続する。
 */
import { sanitizeEntry, uid } from './core.js';
import { openDB, readAll, replaceAll, getMeta, setMeta } from './db.js';

const STORAGE_KEY = 'point-wallet:entries:v1';
const SETTINGS_KEY = 'point-wallet:settings:v1';
const MIGRATED_KEY = 'legacyMigrated';
export const EXPORT_FORMAT = 'point-wallet-backup';

const defaultSettings = {
  sort: 'expiry',
  theme: 'auto',
  notify: false,
  lastBackupAt: '',
  persistNoticeShown: false,
};

/** 実際に使われている保存先。'indexeddb' | 'localstorage' | 'none' */
let backend = 'none';
export const getBackend = () => backend;

/* ---------------- localStorage（予備・冗長コピー） ---------------- */

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.warn('保存データの読み込みに失敗しました', err);
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('localStorage への保存に失敗しました', err);
    return false;
  }
}

/** localStorage の複製が最新でなければ書き直す（片方が失われても復旧できるように） */
function refreshMirror(entries) {
  try {
    const next = JSON.stringify(entries);
    if (localStorage.getItem(STORAGE_KEY) !== next) localStorage.setItem(STORAGE_KEY, next);
  } catch (err) {
    console.warn('localStorage への複製に失敗しました', err);
  }
}

function readLocalEntries() {
  const raw = readJSON(STORAGE_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeEntry).filter(Boolean);
}

/* ---------------- 読み込み ---------------- */

/**
 * 保存済みのポイントを読み出す。
 * 旧バージョン（localStorage のみ）のデータは初回に IndexedDB へ移行する。
 */
export async function loadEntries() {
  try {
    await openDB();
    const rows = await readAll();
    backend = 'indexeddb';

    const migrated = await getMeta(MIGRATED_KEY).catch(() => undefined);
    if (!migrated) {
      // 移行は一度だけ。以降は IndexedDB を唯一の正とし、削除が復活しないようにする
      const legacy = readLocalEntries();
      const known = new Set(rows.map((row) => row && row.id));
      const missing = legacy.filter((entry) => !known.has(entry.id));
      await setMeta(MIGRATED_KEY, new Date().toISOString());
      if (missing.length > 0) {
        const merged = [...rows.map(sanitizeEntry).filter(Boolean), ...missing];
        await replaceAll(merged);
        refreshMirror(merged);
        return merged;
      }
    }

    const loaded = rows.map(sanitizeEntry).filter(Boolean);
    refreshMirror(loaded);
    return loaded;
  } catch (err) {
    console.warn('IndexedDB を利用できないため localStorage を使います', err);
    backend = typeof localStorage !== 'undefined' ? 'localstorage' : 'none';
    return readLocalEntries();
  }
}

/* ---------------- 保存 ---------------- */

/**
 * ポイントを保存する。IndexedDB と localStorage の両方へ書き込み、
 * 少なくとも一方が成功すれば成功とみなす。
 * @returns {Promise<{ok: boolean, backend: string, mirrored: boolean}>}
 */
export async function saveEntries(entries) {
  let stored = false;
  try {
    await replaceAll(entries);
    backend = 'indexeddb';
    stored = true;
  } catch (err) {
    console.warn('IndexedDB への保存に失敗しました', err);
    if (backend === 'indexeddb') backend = 'localstorage';
  }

  // 冗長コピー。容量超過などで失敗しても IndexedDB が成功していれば問題ない
  const mirrored = writeJSON(STORAGE_KEY, entries);
  if (!stored && mirrored) backend = 'localstorage';

  return { ok: stored || mirrored, backend, mirrored };
}

/* ---------------- 設定 ---------------- */

export function loadSettings() {
  return { ...defaultSettings, ...readJSON(SETTINGS_KEY, {}) };
}

export function saveSettings(settings) {
  return writeJSON(SETTINGS_KEY, { ...defaultSettings, ...settings });
}

/* ---------------- バックアップ ---------------- */

/** バックアップ用の JSON 文字列を作る */
export function buildBackup(entries) {
  return JSON.stringify(
    {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      entries,
    },
    null,
    2,
  );
}

/**
 * バックアップ JSON を読み込む。旧形式（配列のみ）にも対応する。
 * @returns {{ok: true, entries: object[]} | {ok: false, error: string}}
 */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSON を解析できませんでした' };
  }
  const list = Array.isArray(data) ? data : data && data.entries;
  if (!Array.isArray(list)) return { ok: false, error: 'ポイントデータが見つかりませんでした' };
  const entries = list.map(sanitizeEntry).filter(Boolean);
  if (entries.length === 0) return { ok: false, error: '取り込めるポイントデータがありませんでした' };
  return { ok: true, entries };
}

/**
 * 取り込んだデータを既存データへ統合する。
 * id が同じものは新しい updatedAt を採用し、無ければ新規追加する。
 */
export function mergeEntries(current, incoming) {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  let added = 0;
  let updated = 0;

  for (const entry of incoming) {
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, entry);
      added += 1;
      continue;
    }
    if (String(entry.updatedAt) > String(existing.updatedAt)) {
      byId.set(entry.id, entry);
      updated += 1;
    }
  }

  return { entries: [...byId.values()], added, updated };
}

/** 既存データを一切変更せず、取り込み分をすべて新規として追加する */
export function appendEntries(current, incoming) {
  const copies = incoming.map((entry) => ({ ...entry, id: uid() }));
  return { entries: [...current, ...copies], added: copies.length, updated: 0 };
}
