/**
 * ポイント管理アプリのドメインロジック（DOM に依存しない純粋関数群）。
 * ブラウザからも Node のテストからも同じコードを利用する。
 */

/** 失効が近いと判定する日数（警告） */
export const WARN_DAYS = 30;
/** 失効が差し迫っていると判定する日数（危険） */
export const DANGER_DAYS = 7;

/** 登録できる単位の候補 */
export const UNITS = ['ポイント', 'マイル', '円', 'コイン', 'スタンプ'];

/** 状態ごとの表示ラベル */
export const STATUS_LABELS = {
  expired: '失効済み',
  danger: 'まもなく失効',
  warn: '期限が近い',
  safe: '有効',
  none: '期限なし',
};

/** 衝突しにくい ID を生成する */
export function uid() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand}`;
}

/** Date を YYYY-MM-DD（ローカルタイム）に変換する */
export function toISODate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** YYYY-MM-DD をローカルタイムの 0 時の Date に変換する。不正な値は null */
export function parseISODate(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const date = new Date(y, mo - 1, d);
  // 2026-02-31 のような存在しない日付を弾く
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/**
 * 有効期限までの残り日数。今日が期限なら 0、過ぎていれば負の数。
 * 期限未設定・不正な日付なら null。
 */
export function daysUntil(expiry, today = toISODate()) {
  const target = parseISODate(expiry);
  const base = parseISODate(today);
  if (!target || !base) return null;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((target.getTime() - base.getTime()) / MS_PER_DAY);
}

/** ポイントの状態を判定する */
export function statusOf(entry, today = toISODate()) {
  const days = daysUntil(entry && entry.expiry, today);
  if (days === null) return 'none';
  if (days < 0) return 'expired';
  if (days <= DANGER_DAYS) return 'danger';
  if (days <= WARN_DAYS) return 'warn';
  return 'safe';
}

/** 残り日数を人間向けの文言にする */
export function expiryLabel(entry, today = toISODate()) {
  const days = daysUntil(entry && entry.expiry, today);
  if (days === null) return '期限なし';
  if (days < 0) return `${Math.abs(days)}日前に失効`;
  if (days === 0) return '本日が期限';
  if (days === 1) return '明日が期限';
  return `あと${days}日`;
}

/** 数値を日本語ロケールで整形する */
export function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('ja-JP');
}

/** YYYY-MM-DD を「2026年9月19日」形式にする */
export function formatDate(value) {
  const date = parseISODate(value);
  if (!date) return '';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * 入力値を検証して正規化する。
 * @returns {{ok: true, entry: object} | {ok: false, errors: Record<string,string>}}
 */
export function validateEntry(input, now = new Date()) {
  const errors = {};
  const site = String(input.site ?? '').trim();
  if (!site) errors.site = 'サイト名を入力してください';
  if (site.length > 60) errors.site = 'サイト名は60文字以内で入力してください';

  const rawPoints = String(input.points ?? '').trim().replace(/,/g, '');
  const points = Number(rawPoints);
  if (rawPoints === '') {
    errors.points = 'ポイント数を入力してください';
  } else if (!Number.isFinite(points)) {
    errors.points = '数値で入力してください';
  } else if (points < 0) {
    errors.points = '0以上の数値を入力してください';
  }

  const expiry = String(input.expiry ?? '').trim();
  if (expiry && !parseISODate(expiry)) errors.expiry = '有効期限の形式が正しくありません';

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const timestamp = now.toISOString();
  return {
    ok: true,
    entry: {
      id: input.id || uid(),
      site,
      points,
      unit: String(input.unit ?? '').trim() || UNITS[0],
      expiry: expiry || '',
      category: String(input.category ?? '').trim(),
      url: String(input.url ?? '').trim(),
      memo: String(input.memo ?? '').trim(),
      createdAt: input.createdAt || timestamp,
      updatedAt: timestamp,
    },
  };
}

/** 保存済みデータ（外部 JSON 含む）を安全な形に整える */
export function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const result = validateEntry(
    {
      id: typeof raw.id === 'string' ? raw.id : '',
      site: raw.site ?? raw.name ?? '',
      points: raw.points ?? 0,
      unit: raw.unit,
      expiry: raw.expiry ?? '',
      category: raw.category,
      url: raw.url,
      memo: raw.memo,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    },
    new Date(),
  );
  if (!result.ok) return null;
  if (typeof raw.updatedAt === 'string') result.entry.updatedAt = raw.updatedAt;
  return result.entry;
}

/** 検索・絞り込み */
export function filterEntries(entries, { query = '', status = 'all', unit = 'all' } = {}, today = toISODate()) {
  const q = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (status !== 'all') {
      const s = statusOf(entry, today);
      if (status === 'active' ? s === 'expired' : s !== status) return false;
    }
    if (unit !== 'all' && entry.unit !== unit) return false;
    if (!q) return true;
    return [entry.site, entry.category, entry.memo, entry.unit]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(q));
  });
}

/** 並び替え（元配列は変更しない） */
export function sortEntries(entries, key = 'expiry') {
  const copy = [...entries];
  const byExpiry = (a, b) => {
    // 期限なしは常に末尾へ
    if (!a.expiry && !b.expiry) return a.site.localeCompare(b.site, 'ja');
    if (!a.expiry) return 1;
    if (!b.expiry) return -1;
    return a.expiry.localeCompare(b.expiry);
  };
  const comparators = {
    expiry: byExpiry,
    points: (a, b) => b.points - a.points || byExpiry(a, b),
    site: (a, b) => a.site.localeCompare(b.site, 'ja') || byExpiry(a, b),
    created: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
  };
  return copy.sort(comparators[key] || byExpiry);
}

/**
 * 集計。単位ごとの合計と、指定日数以内に失効するポイントを返す。
 */
export function summarize(entries, today = toISODate(), withinDays = WARN_DAYS) {
  const totals = new Map();
  const expiringSoon = new Map();
  let expiredCount = 0;
  let soonCount = 0;

  for (const entry of entries) {
    const status = statusOf(entry, today);
    if (status === 'expired') {
      expiredCount += 1;
      continue; // 失効済みは合計に含めない
    }
    totals.set(entry.unit, (totals.get(entry.unit) || 0) + entry.points);
    const days = daysUntil(entry.expiry, today);
    if (days !== null && days <= withinDays) {
      expiringSoon.set(entry.unit, (expiringSoon.get(entry.unit) || 0) + entry.points);
      soonCount += 1;
    }
  }

  const toList = (map) =>
    [...map.entries()]
      .map(([unit, points]) => ({ unit, points }))
      .sort((a, b) => b.points - a.points);

  return {
    totals: toList(totals),
    expiringSoon: toList(expiringSoon),
    expiredCount,
    soonCount,
    totalCount: entries.length,
  };
}

/** 失効が近い順に、通知すべきポイントを返す */
export function upcomingExpirations(entries, today = toISODate(), withinDays = WARN_DAYS) {
  return sortEntries(
    entries.filter((entry) => {
      const days = daysUntil(entry.expiry, today);
      return days !== null && days >= 0 && days <= withinDays;
    }),
    'expiry',
  );
}
