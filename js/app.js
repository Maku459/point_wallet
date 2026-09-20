/**
 * 画面の組み立てと操作。ユーザー入力は textContent 経由で描画し、HTML を組み立てない。
 */
import {
  BACKUP_STALE_DAYS,
  DANGER_DAYS,
  STATUS_LABELS,
  UNITS,
  WARN_DAYS,
  backupAgeLabel,
  expiryLabel,
  filterEntries,
  formatBytes,
  formatDate,
  formatNumber,
  isBackupStale,
  isSameEntry,
  sortEntries,
  statusOf,
  summarize,
  toISODate,
  toLocalISODate,
  upcomingExpirations,
  updatedLabel,
  validateEntry,
} from './core.js';
import {
  appendEntries,
  buildBackup,
  getBackend,
  loadEntries,
  loadSettings,
  mergeEntries,
  parseBackup,
  saveEntries,
  saveSettings,
} from './store.js';
import {
  chooseBackupFile,
  clearBackupHandle,
  getBackupHandle,
  requestPersistence,
  storageStatus,
  supportsFileBackup,
  verifyBackupPermission,
  writeBackupFile,
} from './db.js';

const $ = (selector) => document.querySelector(selector);

const el = {
  list: $('#entry-list'),
  emptyState: $('#empty-state'),
  resultCount: $('#result-count'),
  summaryTotal: $('#summary-total'),
  summaryTotalSub: $('#summary-total-sub'),
  summarySoon: $('#summary-soon'),
  summarySoonSub: $('#summary-soon-sub'),
  alert: $('#alert-banner'),
  alertText: $('#alert-text'),
  search: $('#search-input'),
  filterStatus: $('#filter-status'),
  filterUnit: $('#filter-unit'),
  sortSelect: $('#sort-select'),
  dialog: $('#entry-dialog'),
  form: $('#entry-form'),
  dialogTitle: $('#dialog-title'),
  deleteButton: $('#delete-button'),
  noExpiry: $('#no-expiry'),
  expiryInput: $('#expiry-input'),
  confirmDialog: $('#confirm-dialog'),
  confirmText: $('#confirm-text'),
  confirmOk: $('#confirm-ok'),
  confirmCancel: $('#confirm-cancel'),
  storageDialog: $('#storage-dialog'),
  statusBackend: $('#status-backend'),
  statusPersist: $('#status-persist'),
  statusUsage: $('#status-usage'),
  statusBackup: $('#status-backup'),
  persistButton: $('#persist-button'),
  autoBackupText: $('#autobackup-text'),
  autoBackupSet: $('#autobackup-set'),
  autoBackupClear: $('#autobackup-clear'),
  menuButton: $('#menu-button'),
  menuPanel: $('#menu-panel'),
  themeToggle: $('#theme-toggle'),
  themeIcon: $('#theme-icon'),
  importFile: $('#import-file'),
  toast: $('#toast'),
  siteSuggestions: $('#site-suggestions'),
  unitSuggestions: $('#unit-suggestions'),
  categorySuggestions: $('#category-suggestions'),
};

let entries = [];
let settings = loadSettings();
let toastTimer = 0;

/* ---------------- 保存 ---------------- */

let persistenceRequested = false;

/** 変更を保存し、必要なら永続化の要求と自動バックアップを行う */
async function persist() {
  const result = await saveEntries(entries);
  if (!result.ok) {
    showToast('保存に失敗しました。ブラウザの空き容量をご確認ください');
    return false;
  }
  void ensurePersistence();
  scheduleAutoBackup();
  return true;
}

/**
 * ブラウザに自動削除されないよう要求する。
 * 利用者の操作をきっかけに一度だけ行う（Chrome は条件を満たせば無確認で許可される）。
 */
async function ensurePersistence() {
  if (persistenceRequested) return;
  persistenceRequested = true;
  const { supported, persisted } = await requestPersistence();
  if (supported && persisted && !settings.persistNoticeShown) {
    updateSettings({ persistNoticeShown: true });
    showToast('データの永続化が有効になりました');
  }
}

function updateSettings(patch) {
  settings = { ...settings, ...patch };
  saveSettings(settings);
}

/* ---------------- ファイルへの自動バックアップ ---------------- */

let backupHandle = null;
let backupNeedsPermission = false;
let backupTimer = 0;

async function initAutoBackup() {
  backupHandle = await getBackupHandle();
  if (backupHandle) backupNeedsPermission = !(await verifyBackupPermission(backupHandle, false));
}

function scheduleAutoBackup() {
  if (!backupHandle || backupNeedsPermission) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(runAutoBackup, 800);
}

async function runAutoBackup() {
  if (!backupHandle) return false;
  try {
    if (!(await verifyBackupPermission(backupHandle, false))) {
      backupNeedsPermission = true;
      return false;
    }
    await writeBackupFile(backupHandle, buildBackup(entries));
    updateSettings({ lastBackupAt: new Date().toISOString() });
    return true;
  } catch (err) {
    console.warn('自動バックアップに失敗しました', err);
    return false;
  }
}

async function setupAutoBackup() {
  if (!supportsFileBackup()) {
    showToast('このブラウザはファイルへの自動保存に対応していません');
    return;
  }
  try {
    backupHandle = await chooseBackupFile(`point-wallet-${toISODate()}.json`);
    backupNeedsPermission = false;
    const written = await runAutoBackup();
    showToast(written ? '自動バックアップを設定しました' : '保存先を設定しましたが書き込めませんでした');
  } catch (err) {
    if (err && err.name !== 'AbortError') {
      console.warn('自動バックアップの設定に失敗しました', err);
      showToast('保存先を設定できませんでした');
    }
  }
  await refreshStorageDialog();
}

async function removeAutoBackup() {
  try {
    await clearBackupHandle();
  } catch (err) {
    console.warn('自動バックアップの解除に失敗しました', err);
  }
  backupHandle = null;
  backupNeedsPermission = false;
  showToast('自動バックアップを解除しました');
  await refreshStorageDialog();
}

/* ---------------- 保存状態ダイアログ ---------------- */

const BACKEND_LABEL = {
  indexeddb: 'IndexedDB（ブラウザ内）',
  localstorage: 'localStorage（予備）',
  none: '保存できません',
};

function setStatus(node, text, className) {
  node.replaceChildren();
  const span = createEl('span', className, text);
  node.append(span);
}

async function refreshStorageDialog() {
  if (!el.storageDialog.open) return;

  setStatus(el.statusBackend, BACKEND_LABEL[getBackend()] || '—', getBackend() === 'none' ? 'off' : 'ok');

  const status = await storageStatus();
  if (!status.supported) {
    setStatus(el.statusPersist, 'この環境では設定できません');
    el.persistButton.hidden = true;
  } else if (status.persisted) {
    setStatus(el.statusPersist, '有効（自動削除されません）', 'ok');
    el.persistButton.hidden = true;
  } else {
    setStatus(el.statusPersist, 'ブラウザに任せています', 'off');
    el.persistButton.hidden = false;
  }

  el.statusUsage.textContent =
    status.usage === null
      ? '—'
      : status.quota
        ? `${formatBytes(status.usage)} / ${formatBytes(status.quota)}`
        : formatBytes(status.usage);

  setStatus(
    el.statusBackup,
    backupAgeLabel(settings.lastBackupAt),
    isBackupStale(settings.lastBackupAt, entries.length) ? 'off' : 'ok',
  );

  if (!supportsFileBackup()) {
    el.autoBackupText.textContent =
      'このブラウザは対応していません（パソコンの Chrome / Edge で利用できます）。メニューの「バックアップを書き出す」をご利用ください。';
    el.autoBackupSet.hidden = true;
    el.autoBackupClear.hidden = true;
    return;
  }

  el.autoBackupSet.hidden = false;
  if (!backupHandle) {
    el.autoBackupText.textContent = '保存先ファイルを決めておくと、登録・編集のたびに自動で書き出します。';
    el.autoBackupSet.textContent = '保存先ファイルを選ぶ';
    el.autoBackupClear.hidden = true;
  } else if (backupNeedsPermission) {
    el.autoBackupText.textContent = `保存先：${backupHandle.name}（書き込みの許可が切れています）`;
    el.autoBackupSet.textContent = '許可しなおす';
    el.autoBackupClear.hidden = false;
  } else {
    el.autoBackupText.textContent = `保存先：${backupHandle.name}（変更のたびに自動で保存します）`;
    el.autoBackupSet.textContent = '保存先を変更';
    el.autoBackupClear.hidden = false;
  }
}

async function openStorageDialog() {
  el.storageDialog.showModal();
  await refreshStorageDialog();
}

async function requestPersistenceFromDialog() {
  const { supported, persisted } = await requestPersistence();
  persistenceRequested = true;
  if (!supported) showToast('この環境では設定できません');
  else if (persisted) showToast('データの永続化が有効になりました');
  else showToast('ブラウザに許可されませんでした。ホーム画面に追加すると有効になりやすくなります');
  await refreshStorageDialog();
}

async function reauthorizeBackup() {
  if (backupHandle && backupNeedsPermission) {
    if (await verifyBackupPermission(backupHandle, true)) {
      backupNeedsPermission = false;
      await runAutoBackup();
      showToast('自動バックアップを再開しました');
      await refreshStorageDialog();
      return;
    }
  }
  await setupAutoBackup();
}

/* ---------------- 表示 ---------------- */

function createEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderSummary(today) {
  const stats = summarize(entries, today, WARN_DAYS);

  const fillTotals = (target, list, emptyText) => {
    target.replaceChildren();
    if (list.length === 0) {
      target.append(createEl('span', null, emptyText));
      return;
    }
    const [first, ...rest] = list;
    target.append(document.createTextNode(formatNumber(first.points)));
    target.append(createEl('span', 'unit', first.unit));
    if (rest.length > 0) {
      const restText = rest.map((item) => `${formatNumber(item.points)} ${item.unit}`).join(' / ');
      target.append(createEl('span', 'more', restText));
    }
  };

  fillTotals(el.summaryTotal, stats.totals, '0');
  fillTotals(el.summarySoon, stats.expiringSoon, '0');

  el.summaryTotalSub.textContent =
    stats.expiredCount > 0
      ? `登録 ${stats.totalCount} 件（失効済み ${stats.expiredCount} 件を除く）`
      : `登録 ${stats.totalCount} 件`;
  el.summarySoonSub.textContent = `対象 ${stats.soonCount} 件`;

  const urgent = upcomingExpirations(entries, today, DANGER_DAYS);
  if (urgent.length > 0) {
    el.alertText.textContent = `${urgent.length}件のポイントが${DANGER_DAYS}日以内に失効します（最短：${urgent[0].site} ${expiryLabel(urgent[0], today)}）`;
    el.alert.hidden = false;
  } else {
    el.alert.hidden = true;
  }
}

function renderEntry(entry, today) {
  const status = statusOf(entry, today);
  const item = document.createElement('li');

  const card = createEl('button', `entry entry--${status}`);
  card.type = 'button';
  card.dataset.id = entry.id;
  card.setAttribute('aria-label', `${entry.site} ${formatNumber(entry.points)}${entry.unit} を編集`);

  const head = createEl('div', 'entry__head');
  head.append(createEl('span', 'entry__site', entry.site));
  if (entry.category) head.append(createEl('span', 'entry__category', entry.category));

  const points = createEl('div', 'entry__points');
  points.append(document.createTextNode(formatNumber(entry.points)));
  points.append(createEl('span', 'unit', entry.unit));

  const meta = createEl('div', 'entry__meta');
  const badge = createEl('span', 'entry__badge', status === 'none' ? STATUS_LABELS.none : expiryLabel(entry, today));
  meta.append(badge);
  if (entry.expiry) meta.append(createEl('span', null, `${formatDate(entry.expiry)} まで`));

  const updated = updatedLabel(entry.updatedAt, today);
  if (updated) {
    const updatedNode = createEl('time', 'entry__updated', updated);
    updatedNode.dateTime = toLocalISODate(entry.updatedAt);
    meta.append(updatedNode);
  }

  card.append(head, points, meta);
  if (entry.memo) card.append(createEl('p', 'entry__memo', entry.memo));
  item.append(card);

  if (entry.url && /^https?:\/\//i.test(entry.url)) {
    const link = createEl('a', 'entry__link', 'サイトを開く →');
    link.href = entry.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const linkRow = createEl('div', 'entry__meta');
    linkRow.style.padding = '4px 0 0 18px';
    linkRow.append(link);
    item.append(linkRow);
  }

  return item;
}

function renderList(today) {
  const filtered = filterEntries(
    entries,
    { query: el.search.value, status: settings.status, unit: settings.unit },
    today,
  );
  const sorted = sortEntries(filtered, settings.sort);

  el.list.replaceChildren(...sorted.map((entry) => renderEntry(entry, today)));

  const hasEntries = entries.length > 0;
  el.emptyState.hidden = hasEntries;
  el.resultCount.textContent = hasEntries
    ? sorted.length === entries.length
      ? `${entries.length} 件`
      : `${sorted.length} / ${entries.length} 件を表示中`
    : '';

  if (hasEntries && sorted.length === 0) {
    el.list.replaceChildren(
      createEl('li', 'empty-state__text', '条件に一致するポイントはありません'),
    );
  }
}

function renderFilters() {
  const units = [...new Set(entries.map((entry) => entry.unit))].sort((a, b) => a.localeCompare(b, 'ja'));
  const current = settings.unit;
  el.filterUnit.replaceChildren(createEl('option', null, 'すべて'));
  el.filterUnit.firstChild.value = 'all';
  for (const unit of units) {
    const option = createEl('option', null, unit);
    option.value = unit;
    el.filterUnit.append(option);
  }
  el.filterUnit.value = units.includes(current) ? current : 'all';
  if (el.filterUnit.value === 'all' && current !== 'all') updateSettings({ unit: 'all' });

  el.filterStatus.value = settings.status;
  el.sortSelect.value = settings.sort;
}

function renderSuggestions() {
  const fill = (target, values) => {
    target.replaceChildren();
    for (const value of values) {
      const option = document.createElement('option');
      option.value = value;
      target.append(option);
    }
  };
  fill(el.siteSuggestions, [...new Set(entries.map((e) => e.site))].sort((a, b) => a.localeCompare(b, 'ja')));
  fill(el.categorySuggestions, [...new Set(entries.map((e) => e.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja')));
  fill(el.unitSuggestions, [...new Set([...entries.map((e) => e.unit), ...UNITS])]);
}

function render() {
  const today = toISODate();
  renderSummary(today);
  renderFilters();
  renderList(today);
  renderSuggestions();
}

/* ---------------- トースト ---------------- */

function showToast(message, action) {
  clearTimeout(toastTimer);
  el.toast.replaceChildren(document.createTextNode(message));
  if (action) {
    const button = createEl('button', null, action.label);
    button.type = 'button';
    button.addEventListener('click', () => {
      el.toast.hidden = true;
      action.onClick();
    });
    el.toast.append(button);
  }
  el.toast.hidden = false;
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, action ? 10000 : 3200);
}

/* ---------------- 確認ダイアログ ---------------- */

function confirmAction(message, okLabel = '実行する') {
  return new Promise((resolve) => {
    el.confirmText.textContent = message;
    el.confirmOk.textContent = okLabel;
    const finish = (result) => {
      el.confirmDialog.close();
      el.confirmOk.removeEventListener('click', onOk);
      el.confirmCancel.removeEventListener('click', onCancel);
      el.confirmDialog.removeEventListener('cancel', onCancel);
      resolve(result);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    el.confirmOk.addEventListener('click', onOk);
    el.confirmCancel.addEventListener('click', onCancel);
    el.confirmDialog.addEventListener('cancel', onCancel);
    el.confirmDialog.showModal();
  });
}

/* ---------------- 登録・編集 ---------------- */

function clearErrors() {
  for (const node of el.form.querySelectorAll('[data-error]')) node.textContent = '';
}

function openDialog(entry) {
  clearErrors();
  el.form.reset();
  const isEdit = Boolean(entry);
  el.dialogTitle.textContent = isEdit ? 'ポイントを編集' : 'ポイントを登録';
  el.deleteButton.hidden = !isEdit;

  const values = entry || { unit: UNITS[0] };
  el.form.elements.id.value = values.id || '';
  el.form.elements.createdAt.value = values.createdAt || '';
  el.form.elements.site.value = values.site || '';
  el.form.elements.points.value = values.points !== undefined ? String(values.points) : '';
  el.form.elements.unit.value = values.unit || UNITS[0];
  el.form.elements.expiry.value = values.expiry || '';
  el.form.elements.category.value = values.category || '';
  el.form.elements.url.value = values.url || '';
  el.form.elements.memo.value = values.memo || '';
  el.noExpiry.checked = isEdit && !values.expiry;
  syncExpiryDisabled();

  el.dialog.showModal();
  if (!isEdit) setTimeout(() => el.form.elements.site.focus(), 50);
}

function syncExpiryDisabled() {
  const off = el.noExpiry.checked;
  el.expiryInput.disabled = off;
  el.expiryInput.style.opacity = off ? '.45' : '';
  for (const chip of el.form.querySelectorAll('#expiry-presets .chip')) chip.disabled = off;
  if (off) el.expiryInput.value = '';
}

/** 月を加算した日付を返す。月末を超える場合はその月の末日に丸める */
function addMonths(base, months) {
  const date = new Date(base.getFullYear(), base.getMonth(), 1);
  date.setMonth(date.getMonth() + months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(base.getDate(), lastDay));
  return date;
}

async function handleSubmit(event) {
  event.preventDefault();
  clearErrors();

  const data = Object.fromEntries(new FormData(el.form).entries());
  if (el.noExpiry.checked) data.expiry = '';

  const result = validateEntry(data);
  if (!result.ok) {
    for (const [field, message] of Object.entries(result.errors)) {
      const node = el.form.querySelector(`[data-error="${field}"]`);
      if (node) node.textContent = message;
    }
    const firstField = Object.keys(result.errors)[0];
    el.form.elements[firstField]?.focus();
    return;
  }

  const entry = result.entry;
  const index = entries.findIndex((item) => item.id === entry.id);
  if (index >= 0) {
    // 開いて閉じただけで最終更新日が動かないよう、中身が同じなら記録を据え置く
    if (isSameEntry(entries[index], entry)) entry.updatedAt = entries[index].updatedAt;
    entries[index] = entry;
  } else {
    entries.push(entry);
  }
  render();
  el.dialog.close();
  if (await persist()) showToast(index >= 0 ? '更新しました' : '登録しました');
}

async function deleteCurrent() {
  const id = el.form.elements.id.value;
  const target = entries.find((entry) => entry.id === id);
  if (!target) return;
  const ok = await confirmAction(`「${target.site}」の登録を削除します。よろしいですか？`, '削除する');
  if (!ok) return;

  const backup = [...entries];
  entries = entries.filter((entry) => entry.id !== id);
  render();
  el.dialog.close();
  await persist();
  showToast('削除しました', {
    label: '元に戻す',
    onClick: async () => {
      entries = backup;
      render();
      await persist();
      showToast('削除を取り消しました');
    },
  });
}

/* ---------------- バックアップ ---------------- */

function exportBackup() {
  if (entries.length === 0) {
    showToast('書き出すデータがありません');
    return;
  }
  const blob = new Blob([buildBackup(entries)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `point-wallet-${toISODate()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  updateSettings({ lastBackupAt: new Date().toISOString() });
  showToast('バックアップを書き出しました');
}

async function importBackup(file) {
  const text = await file.text();
  const parsed = parseBackup(text);
  if (!parsed.ok) {
    showToast(`読み込めませんでした：${parsed.error}`);
    return;
  }

  let merged;
  if (entries.length === 0) {
    merged = mergeEntries(entries, parsed.entries);
  } else {
    const replace = await confirmAction(
      `${parsed.entries.length}件を読み込みます。既存データと同じ登録は新しい方で上書きします（「キャンセル」で中止）。`,
      '読み込む',
    );
    if (!replace) return;
    merged = mergeEntries(entries, parsed.entries);
    if (merged.added === 0 && merged.updated === 0) {
      const asNew = await confirmAction('更新対象がありませんでした。すべて新規として追加しますか？', '追加する');
      if (asNew) merged = appendEntries(entries, parsed.entries);
    }
  }

  entries = merged.entries;
  render();
  await persist();
  showToast(`読み込み完了：追加 ${merged.added} 件 / 更新 ${merged.updated} 件`);
}

async function clearAll() {
  if (entries.length === 0) {
    showToast('削除するデータがありません');
    return;
  }
  const ok = await confirmAction(
    `登録済みの ${entries.length} 件をすべて削除します。この操作は取り消せません。`,
    'すべて削除',
  );
  if (!ok) return;
  entries = [];
  render();
  await persist();
  showToast('すべて削除しました');
}

async function addSampleData() {
  const today = new Date();
  const iso = (months) => toISODate(addMonths(today, months));
  const samples = [
    { site: '楽天ポイント', points: 3200, unit: 'ポイント', expiry: iso(1), category: 'ショッピング', memo: '期間限定ポイントを含む' },
    { site: 'Tポイント', points: 850, unit: 'ポイント', expiry: iso(6), category: '共通ポイント', memo: '' },
    { site: 'ANAマイル', points: 12500, unit: 'マイル', expiry: iso(18), category: '航空', memo: '特典航空券に交換予定' },
    { site: 'Amazonギフト残高', points: 1500, unit: '円', expiry: '', category: 'ショッピング', memo: '' },
  ];
  for (const sample of samples) {
    const result = validateEntry(sample);
    if (result.ok) entries.push(result.entry);
  }
  render();
  await persist();
  showToast('サンプルデータを追加しました');
}

/* ---------------- テーマ ---------------- */

const THEME_ORDER = ['auto', 'light', 'dark'];
const THEME_ICON = { auto: '◐', light: '☀', dark: '☾' };
const THEME_LABEL = { auto: '端末の設定に合わせる', light: 'ライトモード', dark: 'ダークモード' };

function applyTheme() {
  const theme = settings.theme || 'auto';
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  el.themeIcon.textContent = THEME_ICON[theme];
  el.themeToggle.title = `テーマ：${THEME_LABEL[theme]}`;
  el.themeToggle.setAttribute('aria-label', `テーマを切り替える（現在：${THEME_LABEL[theme]}）`);
}

function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(settings.theme || 'auto') + 1) % THEME_ORDER.length];
  updateSettings({ theme: next });
  applyTheme();
  showToast(`テーマ：${THEME_LABEL[next]}`);
}

/* ---------------- 通知（端末内・アプリ起動時） ---------------- */

const LAST_NOTIFIED_KEY = 'point-wallet:last-notified';

async function enableNotifications() {
  if (!('Notification' in window)) {
    showToast('このブラウザは通知に対応していません');
    return;
  }
  if (settings.notify) {
    updateSettings({ notify: false });
    syncNotifyLabel();
    showToast('失効前の通知をオフにしました');
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    showToast('通知が許可されませんでした');
    return;
  }
  updateSettings({ notify: true });
  syncNotifyLabel();
  showToast('アプリを開いたときに、失効が近いポイントをお知らせします');
  notifyUpcoming();
}

function notifyUpcoming() {
  if (!settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const today = toISODate();
  if (localStorage.getItem(LAST_NOTIFIED_KEY) === today) return;

  const urgent = upcomingExpirations(entries, today, DANGER_DAYS);
  if (urgent.length === 0) return;

  const first = urgent[0];
  const body =
    urgent.length === 1
      ? `${first.site}：${formatNumber(first.points)}${first.unit}（${expiryLabel(first, today)}）`
      : `${first.site} ほか ${urgent.length - 1} 件が ${DANGER_DAYS} 日以内に失効します`;
  try {
    new Notification('まもなく失効するポイントがあります', { body, icon: 'icons/icon-192.png', tag: 'point-wallet-expiry' });
    localStorage.setItem(LAST_NOTIFIED_KEY, today);
  } catch (err) {
    console.warn('通知を表示できませんでした', err);
  }
}

function syncNotifyLabel() {
  const button = el.menuPanel.querySelector('[data-action="notify"]');
  if (button) button.textContent = settings.notify ? '失効前の通知をオフにする' : '失効前の通知を有効にする';
}

/* ---------------- メニュー ---------------- */

function toggleMenu(force) {
  const open = force !== undefined ? force : el.menuPanel.hidden;
  el.menuPanel.hidden = !open;
  el.menuButton.setAttribute('aria-expanded', String(open));
}

const menuActions = {
  storage: openStorageDialog,
  export: exportBackup,
  import: () => el.importFile.click(),
  notify: enableNotifications,
  sample: addSampleData,
  clear: clearAll,
};

/* ---------------- イベント登録 ---------------- */

el.list.addEventListener('click', (event) => {
  const card = event.target.closest('.entry');
  if (!card) return;
  const entry = entries.find((item) => item.id === card.dataset.id);
  if (entry) openDialog(entry);
});

$('#add-button').addEventListener('click', () => openDialog(null));
el.emptyState.querySelector('[data-action="add"]').addEventListener('click', () => openDialog(null));

el.form.addEventListener('submit', handleSubmit);
el.deleteButton.addEventListener('click', deleteCurrent);
for (const button of el.dialog.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => el.dialog.close());
}
for (const button of el.storageDialog.querySelectorAll('[data-close-storage]')) {
  button.addEventListener('click', () => el.storageDialog.close());
}
el.persistButton.addEventListener('click', requestPersistenceFromDialog);
el.autoBackupSet.addEventListener('click', reauthorizeBackup);
el.autoBackupClear.addEventListener('click', removeAutoBackup);

el.noExpiry.addEventListener('change', syncExpiryDisabled);
$('#expiry-presets').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  el.noExpiry.checked = false;
  syncExpiryDisabled();
  el.expiryInput.value = toISODate(addMonths(new Date(), Number(chip.dataset.months)));
});

el.search.addEventListener('input', () => renderList(toISODate()));
el.filterStatus.addEventListener('change', () => {
  updateSettings({ status: el.filterStatus.value });
  renderList(toISODate());
});
el.filterUnit.addEventListener('change', () => {
  updateSettings({ unit: el.filterUnit.value });
  renderList(toISODate());
});
el.sortSelect.addEventListener('change', () => {
  updateSettings({ sort: el.sortSelect.value });
  renderList(toISODate());
});

el.themeToggle.addEventListener('click', cycleTheme);

el.menuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleMenu();
});
el.menuPanel.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  toggleMenu(false);
  menuActions[button.dataset.action]?.();
});
document.addEventListener('click', (event) => {
  if (!el.menuPanel.hidden && !event.target.closest('.menu-wrap')) toggleMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.menuPanel.hidden) toggleMenu(false);
});

el.importFile.addEventListener('change', async () => {
  const file = el.importFile.files?.[0];
  el.importFile.value = '';
  if (file) await importBackup(file);
});

// 日付をまたいだ場合に表示を更新する
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') render();
});

/* ---------------- 起動 ---------------- */

async function main() {
  applyTheme();
  syncNotifyLabel();

  entries = await loadEntries();
  render();
  document.body.dataset.ready = 'true';

  notifyUpcoming();
  await initAutoBackup();

  if (getBackend() === 'none') {
    showToast('このブラウザではデータを保存できません（プライベートモードの可能性があります）');
  } else if (backupNeedsPermission) {
    showToast('自動バックアップの許可が切れています', { label: '再設定', onClick: openStorageDialog });
  } else if (isBackupStale(settings.lastBackupAt, entries.length)) {
    showToast(`${BACKUP_STALE_DAYS}日以上バックアップしていません`, { label: '書き出す', onClick: exportBackup });
  }
}

main();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('sw.js');
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('新しいバージョンがあります', {
              label: '更新',
              onClick: () => {
                worker.postMessage({ type: 'SKIP_WAITING' });
              },
            });
          }
        });
      });
    } catch (err) {
      console.warn('Service Worker を登録できませんでした', err);
    }
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}
