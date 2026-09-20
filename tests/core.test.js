import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  BACKUP_STALE_DAYS,
  backupAgeLabel,
  daysSince,
  daysUntil,
  formatBytes,
  isBackupStale,
  isSameEntry,
  expiryLabel,
  filterEntries,
  formatDate,
  parseISODate,
  sanitizeEntry,
  sortEntries,
  statusOf,
  summarize,
  toISODate,
  toLocalISODate,
  upcomingExpirations,
  updatedLabel,
  validateEntry,
} from '../js/core.js';

const TODAY = '2026-09-19';

const entry = (over = {}) => ({
  id: over.id || 'id',
  site: 'サイト',
  points: 100,
  unit: 'ポイント',
  expiry: '',
  category: '',
  url: '',
  memo: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('日付ユーティリティ', () => {
  test('toISODate はローカル日付を YYYY-MM-DD で返す', () => {
    assert.equal(toISODate(new Date(2026, 8, 19)), '2026-09-19');
    assert.equal(toISODate(new Date(2026, 0, 5)), '2026-01-05');
  });

  test('parseISODate は存在しない日付を拒否する', () => {
    assert.equal(parseISODate('2026-02-31'), null);
    assert.equal(parseISODate('2026-13-01'), null);
    assert.equal(parseISODate('2026/09/19'), null);
    assert.equal(parseISODate(''), null);
    assert.ok(parseISODate('2024-02-29') instanceof Date, 'うるう年は有効');
  });

  test('daysUntil は残り日数を返す', () => {
    assert.equal(daysUntil('2026-09-19', TODAY), 0);
    assert.equal(daysUntil('2026-09-20', TODAY), 1);
    assert.equal(daysUntil('2026-09-12', TODAY), -7);
    assert.equal(daysUntil('', TODAY), null);
  });

  test('daysUntil は夏時間の切り替えを跨いでも整数日になる', () => {
    // 3月・11月の切り替えを含む区間でも端数が出ないこと
    assert.equal(daysUntil('2026-03-20', '2026-03-01'), 19);
    assert.equal(daysUntil('2026-11-20', '2026-11-01'), 19);
  });

  test('formatDate は日本語表記にする', () => {
    assert.equal(formatDate('2026-09-19'), '2026年9月19日');
    assert.equal(formatDate('bad'), '');
  });
});

describe('状態判定', () => {
  test('期限に応じた状態を返す', () => {
    assert.equal(statusOf(entry({ expiry: '' }), TODAY), 'none');
    assert.equal(statusOf(entry({ expiry: '2026-09-18' }), TODAY), 'expired');
    assert.equal(statusOf(entry({ expiry: '2026-09-19' }), TODAY), 'danger');
    assert.equal(statusOf(entry({ expiry: '2026-09-26' }), TODAY), 'danger', '7日後は危険');
    assert.equal(statusOf(entry({ expiry: '2026-09-27' }), TODAY), 'warn', '8日後は警告');
    assert.equal(statusOf(entry({ expiry: '2026-10-19' }), TODAY), 'warn', '30日後は警告');
    assert.equal(statusOf(entry({ expiry: '2026-10-20' }), TODAY), 'safe');
  });

  test('expiryLabel は残り日数を文章にする', () => {
    assert.equal(expiryLabel(entry({ expiry: '2026-09-19' }), TODAY), '本日が期限');
    assert.equal(expiryLabel(entry({ expiry: '2026-09-20' }), TODAY), '明日が期限');
    assert.equal(expiryLabel(entry({ expiry: '2026-09-25' }), TODAY), 'あと6日');
    assert.equal(expiryLabel(entry({ expiry: '2026-09-17' }), TODAY), '2日前に失効');
    assert.equal(expiryLabel(entry({ expiry: '' }), TODAY), '期限なし');
  });
});

describe('入力の検証', () => {
  test('サイト名とポイント数は必須', () => {
    const result = validateEntry({ site: '  ', points: '' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.site);
    assert.ok(result.errors.points);
  });

  test('数値以外・負の数を拒否する', () => {
    assert.equal(validateEntry({ site: 'A', points: 'abc' }).ok, false);
    assert.equal(validateEntry({ site: 'A', points: '-1' }).ok, false);
    assert.equal(validateEntry({ site: 'A', points: '0' }).ok, true);
  });

  test('カンマ区切りの数値を受け付ける', () => {
    const result = validateEntry({ site: 'A', points: '12,345' });
    assert.equal(result.ok, true);
    assert.equal(result.entry.points, 12345);
  });

  test('不正な有効期限を拒否する', () => {
    assert.equal(validateEntry({ site: 'A', points: '1', expiry: '2026-02-30' }).ok, false);
    assert.equal(validateEntry({ site: 'A', points: '1', expiry: '' }).ok, true);
  });

  test('既定値を補い、前後の空白を除去する', () => {
    const result = validateEntry({ site: ' 楽天 ', points: '10' });
    assert.equal(result.ok, true);
    assert.equal(result.entry.site, '楽天');
    assert.equal(result.entry.unit, 'ポイント');
    assert.ok(result.entry.id);
    assert.ok(result.entry.createdAt);
  });
});

describe('絞り込みと並び替え', () => {
  const entries = [
    entry({ id: '1', site: '楽天', points: 300, expiry: '2026-10-01', category: 'EC' }),
    entry({ id: '2', site: 'ANA', points: 5000, unit: 'マイル', expiry: '', memo: '特典航空券' }),
    entry({ id: '3', site: 'dポイント', points: 120, expiry: '2026-09-01' }),
    entry({ id: '4', site: 'Ponta', points: 900, expiry: '2026-09-22' }),
  ];

  test('キーワードはサイト名・カテゴリ・メモを横断する', () => {
    assert.deepEqual(filterEntries(entries, { query: '楽天' }, TODAY).map((e) => e.id), ['1']);
    assert.deepEqual(filterEntries(entries, { query: 'ec' }, TODAY).map((e) => e.id), ['1']);
    assert.deepEqual(filterEntries(entries, { query: '特典' }, TODAY).map((e) => e.id), ['2']);
    assert.equal(filterEntries(entries, { query: '該当なし' }, TODAY).length, 0);
  });

  test('状態と単位で絞り込める', () => {
    assert.deepEqual(filterEntries(entries, { status: 'expired' }, TODAY).map((e) => e.id), ['3']);
    assert.deepEqual(filterEntries(entries, { status: 'none' }, TODAY).map((e) => e.id), ['2']);
    assert.deepEqual(filterEntries(entries, { status: 'active' }, TODAY).map((e) => e.id), ['1', '2', '4']);
    assert.deepEqual(filterEntries(entries, { unit: 'マイル' }, TODAY).map((e) => e.id), ['2']);
  });

  test('期限順では期限なしが末尾になる', () => {
    assert.deepEqual(sortEntries(entries, 'expiry').map((e) => e.id), ['3', '4', '1', '2']);
  });

  test('ポイント順・サイト名順・登録順', () => {
    assert.deepEqual(sortEntries(entries, 'points').map((e) => e.id), ['2', '4', '1', '3']);
    assert.equal(sortEntries(entries, 'site')[0].site, 'ANA');
    const withDates = [
      entry({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
      entry({ id: 'new', createdAt: '2026-09-01T00:00:00.000Z' }),
    ];
    assert.deepEqual(sortEntries(withDates, 'created').map((e) => e.id), ['new', 'old']);
  });

  test('並び替えは元の配列を変更しない', () => {
    const before = entries.map((e) => e.id);
    sortEntries(entries, 'points');
    assert.deepEqual(entries.map((e) => e.id), before);
  });
});

describe('集計', () => {
  const entries = [
    entry({ id: '1', points: 300, expiry: '2026-10-01' }),   // 30日以内
    entry({ id: '2', points: 5000, unit: 'マイル', expiry: '' }),
    entry({ id: '3', points: 120, expiry: '2026-09-01' }),   // 失効済み
    entry({ id: '4', points: 900, expiry: '2027-01-01' }),
  ];

  test('失効済みは合計から除外する', () => {
    const stats = summarize(entries, TODAY);
    assert.deepEqual(stats.totals, [
      { unit: 'マイル', points: 5000 },
      { unit: 'ポイント', points: 1200 },
    ]);
    assert.equal(stats.expiredCount, 1);
    assert.equal(stats.totalCount, 4);
  });

  test('30日以内に失効する分を単位ごとに集計する', () => {
    const stats = summarize(entries, TODAY);
    assert.deepEqual(stats.expiringSoon, [{ unit: 'ポイント', points: 300 }]);
    assert.equal(stats.soonCount, 1);
  });

  test('upcomingExpirations は失効済みを含めず期限順に返す', () => {
    const list = upcomingExpirations(entries, TODAY, 30);
    assert.deepEqual(list.map((e) => e.id), ['1']);
  });
});

describe('保存状態の表示', () => {
  const NOW = new Date('2026-09-19T12:00:00.000Z');

  test('formatBytes は単位を切り替える', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(999), '999 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(20 * 1024 * 1024), '20 MB');
    assert.equal(formatBytes(1024 ** 3), '1.0 GB');
    assert.equal(formatBytes(null), '—');
    assert.equal(formatBytes(-1), '—');
  });

  test('daysSince は経過日数を返す', () => {
    assert.equal(daysSince('2026-09-19T00:00:00.000Z', NOW), 0);
    assert.equal(daysSince('2026-09-05T12:00:00.000Z', NOW), 14);
    assert.equal(daysSince('', NOW), null);
    assert.equal(daysSince('こわれた日付', NOW), null);
  });

  test('isBackupStale は登録があり期間が空いたときだけ true', () => {
    assert.equal(isBackupStale('', 0, NOW), false, 'データが無ければ促さない');
    assert.equal(isBackupStale('', 3, NOW), true, '一度も取得していなければ促す');
    assert.equal(isBackupStale('2026-09-18T00:00:00.000Z', 3, NOW), false);
    const stale = new Date(NOW.getTime() - BACKUP_STALE_DAYS * 86400000).toISOString();
    assert.equal(isBackupStale(stale, 3, NOW), true, `${BACKUP_STALE_DAYS}日で促す`);
  });

  test('backupAgeLabel は経過を文言にする', () => {
    assert.equal(backupAgeLabel('', NOW), 'まだ取得していません');
    assert.equal(backupAgeLabel('2026-09-19T01:00:00.000Z', NOW), '今日');
    assert.equal(backupAgeLabel('2026-09-18T10:00:00.000Z', NOW), '昨日');
    assert.equal(backupAgeLabel('2026-09-09T12:00:00.000Z', NOW), '10日前');
  });
});

describe('最終更新日', () => {
  test('toLocalISODate は ISO のタイムスタンプをローカル日付にする', () => {
    // 日本時間の 2026-09-19 08:00 は UTC では前日の 23:00。ローカルの日付で返す
    const iso = new Date(2026, 8, 19, 8, 0, 0).toISOString();
    assert.equal(toLocalISODate(iso), '2026-09-19');
  });

  test('toLocalISODate は未設定・壊れた値を空文字で返す', () => {
    assert.equal(toLocalISODate(''), '');
    assert.equal(toLocalISODate(undefined), '');
    assert.equal(toLocalISODate('きのう'), '');
  });

  test('updatedLabel は今日・昨日を言葉にし、それ以外は日付で出す', () => {
    const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();
    assert.equal(updatedLabel(at(2026, 9, 19), TODAY), '今日 更新');
    assert.equal(updatedLabel(at(2026, 9, 18), TODAY), '昨日 更新');
    assert.equal(updatedLabel(at(2026, 9, 17), TODAY), '2026年9月17日 更新');
  });

  test('updatedLabel は日付の差で判定する（経過時間では見ない）', () => {
    // 昨日の 23:00 は 13 時間前だが、暦の上では「昨日」
    assert.equal(updatedLabel(new Date(2026, 8, 18, 23, 0).toISOString(), TODAY), '昨日 更新');
    // 今日の 0:05 は「今日」
    assert.equal(updatedLabel(new Date(2026, 8, 19, 0, 5).toISOString(), TODAY), '今日 更新');
  });

  test('updatedLabel は記録が無ければ空文字（表示しない）', () => {
    assert.equal(updatedLabel('', TODAY), '');
    assert.equal(updatedLabel(undefined, TODAY), '');
  });

  test('validateEntry は保存のたびに updatedAt を記録する', () => {
    const now = new Date(2026, 8, 19, 10, 0);
    const result = validateEntry({ site: 'サイト', points: '100' }, now);
    assert.ok(result.ok);
    assert.equal(result.entry.updatedAt, now.toISOString());
    assert.equal(result.entry.createdAt, now.toISOString());
  });

  test('validateEntry は createdAt を引き継ぎ、updatedAt だけ入れ直す', () => {
    const now = new Date(2026, 8, 19, 10, 0);
    const created = '2026-01-01T00:00:00.000Z';
    const result = validateEntry({ id: 'id', site: 'サイト', points: '100', createdAt: created }, now);
    assert.ok(result.ok);
    assert.equal(result.entry.createdAt, created);
    assert.equal(result.entry.updatedAt, now.toISOString());
  });

  test('sanitizeEntry は保存済みの updatedAt を保つ', () => {
    const saved = entry({ updatedAt: '2026-05-05T00:00:00.000Z' });
    assert.equal(sanitizeEntry(saved).updatedAt, '2026-05-05T00:00:00.000Z');
  });

  test('sanitizeEntry は updatedAt が無い古いデータを登録日に合わせる', () => {
    // 読み込むたびに「今日」へ動いてしまわないこと
    const legacy = { site: 'サイト', points: 100, createdAt: '2026-01-01T00:00:00.000Z' };
    assert.equal(sanitizeEntry(legacy).updatedAt, '2026-01-01T00:00:00.000Z');
  });
});

describe('isSameEntry', () => {
  test('編集できる項目が同じなら true', () => {
    const a = entry({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const b = entry({ updatedAt: '2026-09-19T00:00:00.000Z', createdAt: '2020-01-01T00:00:00.000Z' });
    assert.equal(isSameEntry(a, b), true);
  });

  test('編集できる項目が 1 つでも違えば false', () => {
    for (const over of [{ site: '別' }, { points: 101 }, { unit: 'マイル' }, { expiry: '2026-12-31' }, { category: '別' }, { url: 'https://example.com/' }, { memo: '別' }]) {
      assert.equal(isSameEntry(entry(), entry(over)), false, JSON.stringify(over));
    }
  });

  test('片方が無ければ false', () => {
    assert.equal(isSameEntry(entry(), null), false);
    assert.equal(isSameEntry(undefined, entry()), false);
  });
});
