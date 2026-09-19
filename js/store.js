/**
 * localStorage へのデータ永続化と、JSON によるバックアップ／復元。
 * 端末内にのみ保存し、外部にデータを送信することはない。
 */
import { sanitizeEntry, uid } from './core.js';

const STORAGE_KEY = 'point-wallet:entries:v1';
const SETTINGS_KEY = 'point-wallet:settings:v1';
export const EXPORT_FORMAT = 'point-wallet-backup';

const defaultSettings = {
  sort: 'expiry',
  status: 'all',
  unit: 'all',
  theme: 'auto',
  notify: false,
};

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
    console.error('保存に失敗しました', err);
    return false;
  }
}

export function loadEntries() {
  const raw = readJSON(STORAGE_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeEntry).filter(Boolean);
}

export function saveEntries(entries) {
  return writeJSON(STORAGE_KEY, entries);
}

export function loadSettings() {
  return { ...defaultSettings, ...readJSON(SETTINGS_KEY, {}) };
}

export function saveSettings(settings) {
  return writeJSON(SETTINGS_KEY, { ...defaultSettings, ...settings });
}

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
      // 別端末由来などで id が衝突しないよう、未知の id はそのまま採用する
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
