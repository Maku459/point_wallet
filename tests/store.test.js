import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { EXPORT_FORMAT, appendEntries, buildBackup, mergeEntries, parseBackup } from '../js/store.js';

const entry = (over = {}) => ({
  id: 'a',
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

describe('バックアップの書き出し・読み込み', () => {
  test('書き出した JSON をそのまま読み戻せる', () => {
    const entries = [entry({ id: '1', site: '楽天', points: 1200, expiry: '2026-12-31' })];
    const json = JSON.parse(buildBackup(entries));
    assert.equal(json.format, EXPORT_FORMAT);
    const parsed = parseBackup(JSON.stringify(json));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.entries[0].site, '楽天');
    assert.equal(parsed.entries[0].points, 1200);
    assert.equal(parsed.entries[0].expiry, '2026-12-31');
  });

  test('配列のみの JSON も読み込める', () => {
    const parsed = parseBackup(JSON.stringify([{ site: 'A', points: 5 }]));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.entries.length, 1);
  });

  test('壊れた入力はエラーを返す', () => {
    assert.equal(parseBackup('{').ok, false);
    assert.equal(parseBackup('{"foo":1}').ok, false);
    assert.equal(parseBackup('[]').ok, false);
    assert.equal(parseBackup(JSON.stringify([{ site: '', points: 'x' }])).ok, false);
  });

  test('壊れた要素だけを除いて読み込む', () => {
    const parsed = parseBackup(JSON.stringify([{ site: 'A', points: 5 }, null, { site: '', points: 1 }]));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.entries.length, 1);
  });
});

describe('統合', () => {
  test('未知の id は追加、既知の id は新しい方を採用する', () => {
    const current = [entry({ id: '1', site: '旧', updatedAt: '2026-01-01T00:00:00.000Z' })];
    const incoming = [
      entry({ id: '1', site: '新', updatedAt: '2026-05-01T00:00:00.000Z' }),
      entry({ id: '2', site: '追加' }),
    ];
    const result = mergeEntries(current, incoming);
    assert.equal(result.added, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.entries.find((e) => e.id === '1').site, '新');
  });

  test('取り込み側が古い場合は既存を保つ', () => {
    const current = [entry({ id: '1', site: '新しい', updatedAt: '2026-05-01T00:00:00.000Z' })];
    const incoming = [entry({ id: '1', site: '古い', updatedAt: '2026-01-01T00:00:00.000Z' })];
    const result = mergeEntries(current, incoming);
    assert.equal(result.updated, 0);
    assert.equal(result.entries[0].site, '新しい');
  });

  test('appendEntries は既存を残したまま新しい id で追加する', () => {
    const current = [entry({ id: '1' })];
    const result = appendEntries(current, [entry({ id: '1', site: '複製' })]);
    assert.equal(result.entries.length, 2);
    assert.notEqual(result.entries[1].id, '1');
    assert.equal(result.entries[0].site, 'サイト');
  });
});
