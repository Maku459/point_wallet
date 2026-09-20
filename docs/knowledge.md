# 知見

このリポジトリを触るときに知っておくと事故らないことをまとめる。
セッション開始時に `CLAUDE.md` から自動で読み込まれる。

- 書くもの … 繰り返し効く設計の約束、二度踏みたくない落とし穴、
  「なぜそうなっているか」が分からないと壊してしまう箇所
- 書かないもの … アプリの仕様（→ `README.md`）、いつ何をしたかの記録（→ `docs/worklog.md`）、
  1 回きりの作業手順

分量が増えたら README へ移すか、古くなった項目を消す。増やし続けない。

## 全体像

- ビルドもバンドラも依存パッケージも無い。素の ES モジュールをブラウザが直接読む
  （`package.json` の `"type": "module"`、依存は `devDependencies` も含めてゼロ）
- サーバーもアカウントも無い。データは端末のブラウザ内だけにある
- 保存は IndexedDB が主、localStorage が複製。どちらかが欠けても動く
- 詳しい仕様・ファイルの役割・公開手順は `README.md`。ここでは繰り返さない

**依存パッケージを足さない。** 「ビルド不要・依存ゼロ」はこのアプリの前提で、
`npm test`（Node の標準テストランナー）も `npm start`（`tools/serve.js`）も
それに乗っている。ライブラリが要るように感じたら、まず素の API で書けないかを見る。

## 単一の情報源にまとめてある

足したいものがあるとき、まずここを見る。分岐を各所に散らかさない。

| 増やしたいもの | 触るファイル |
| --- | --- |
| 単位の候補・状態のラベル・しきい値（7日／30日／14日） | `js/core.js` の `UNITS` / `STATUS_LABELS` / `WARN_DAYS` / `DANGER_DAYS` / `BACKUP_STALE_DAYS` |
| 入力の検証と正規化 | `js/core.js` の `validateEntry`（`sanitizeEntry` もこれを通る） |
| 並び替えの種類 | `js/core.js` の `sortEntries` の `comparators` |
| 保存先・永続化要求・自動バックアップ先の保持 | `js/db.js` |
| 保存／読み出し／バックアップの組み立て | `js/store.js` |
| 画面の組み立てと操作 | `js/app.js` |
| オフライン時に配る資材 | `sw.js` の `PRECACHE` |

`js/core.js` は **DOM に触らない**。ブラウザと Node のテストが同じコードを読むので、
`document` や `localStorage` を使った時点でテストが落ちる。画面まわりは `js/app.js` に置く。

## 日付は「ローカルタイムの YYYY-MM-DD」で扱う

有効期限は日付だけを持つ（時刻は持たない）。**`new Date("2026-09-20")` を使わないこと。**
この形は UTC の 0 時として解釈されるので、日本時間では前日の 9:00 になり、
「あと◯日」や失効判定が 1 日ずれる。

- 文字列 → Date は `parseISODate`（`new Date(y, m-1, d)` でローカルの 0 時を作る）。
  `2026-02-31` のような存在しない日付も、作った Date と読み戻した値を突き合わせて弾く
- Date → 文字列は `toISODate`（`toISOString().slice(0,10)` ではない。同じ理由でずれる）
- 残り日数は `daysUntil` が 0 時どうしの差を `Math.round` する。**切り捨てにしない**
  （夏時間のある地域で 1 時間ずれると 1 日ずれる）
- 「今日」は引数で受け取る（既定が `toISODate()`）。テストが任意の日付で判定を確かめられる

## 外から入ってきたデータは必ず `sanitizeEntry` を通す

バックアップ JSON も、localStorage / IndexedDB から読み戻した行も、人が手で書き換えられる。
読み出す側が毎回 `sanitizeEntry`（中身は `validateEntry`）を通し、通らない行は落とす。
`loadEntries` / `readLocalEntries` / `parseBackup` はすべてそうしてある。

- **`sanitizeEntry` は `updatedAt` だけ元の値を残す。** `validateEntry` は保存時刻として
  `updatedAt` を必ず今の時刻で入れ直すので、素通しすると取り込んだ全件が「いま更新された」
  ことになり、`mergeEntries` の新旧判定（`updatedAt` の文字列比較）が常に取り込み側の勝ちになる
- したがって **`updatedAt` は `toISOString()` の形で持つ**。辞書順の比較で新旧が決まるので、
  ローカル表記の文字列を混ぜると比較が壊れる
- 旧形式のバックアップ（配列がそのまま入っている JSON）と、`site` ではなく `name` で
  書かれた行も受ける。取り込み口を増やすときはここに合わせる

## 保存は「二重持ち・片方が落ちても続ける」

- 主は IndexedDB（`js/db.js`）、同じ内容を localStorage へ複製する（`js/store.js`）
- **保存は毎回まるごと置き換える**（`replaceAll` が 1 つのトランザクションで
  `clear()` → `put()`）。差分更新ではないので、保存する配列は常に全件を渡す
- `saveEntries` は **どちらか一方が成功すれば成功**として返す。localStorage は容量が
  小さく、件数が増えると複製だけ失敗することがあるが、それで保存を失敗扱いにしない
- 実際に使えている保存先は `getBackend()` が持つ（`'indexeddb' | 'localstorage' | 'none'`）。
  画面の「データの保存状態」はこれを出している
- `js/db.js` の関数は**どれも失敗しうる**（プライベートブラウジング、容量不足、
  別タブがバージョン変更中）。呼ぶ側は必ず catch して、使えないなりに動く道を残す

## localStorage からの移行は一度きり

旧バージョン（localStorage だけ）のデータは初回起動時に IndexedDB へ移す。
移したことは IndexedDB の `meta` ストアに印（`legacyMigrated`）として残し、**以降は
IndexedDB を唯一の正とする**。

毎回 localStorage を見に行って差分を足す作りにしないこと。**削除した登録が次回起動で
復活する**（localStorage の複製は消しても、そちらを正とみなした瞬間に戻ってくる）。
複製はあくまで復旧用で、読み出しの入口ではない。

## 自動バックアップ先の「ハンドル」は IndexedDB にしか置けない

File System Access API の `FileSystemFileHandle` は構造化複製で IndexedDB へ入るが、
**JSON にはできないので localStorage には置けない**。IndexedDB が使えない環境では
自動バックアップも使えない、という依存関係がある。

- **権限は切れる。** ブラウザを閉じると書き込み許可が失われるので、書く前に毎回
  `verifyBackupPermission` で確かめる。`requestPermission`（`prompt = true`）は
  **ユーザー操作の最中しか通らない**ので、自動保存の裏側からは呼ばない。
  画面には「許可しなおす」ボタンを出して、押されたときに求める
- 対応しているのはパソコンの Chrome / Edge だけ。`supportsFileBackup()` で分岐する

## 画面には文字として差し込む

サイト名・カテゴリ・メモはユーザーが自由に書ける。`js/app.js` は `textContent` /
`replaceChildren` / `createTextNode` だけで描き、**HTML 文字列を組み立てない**。
`innerHTML` を使い始めると、メモに書いたタグがその場で有効になる。

## 失効済みは合計に入れない

`summarize` は失効済みを合計から外し、件数だけ `expiredCount` で返す。
「持っている量」を見せる欄なので、使えないポイントを足すと意味が変わる。
絞り込みの `status: 'active'` も「失効済み以外すべて」で、有効期限の有無は問わない。

期限なしのポイントは並び替えで**常に末尾**へ置く（`sortEntries` の `byExpiry`）。
期限の近い順に見る画面なので、期限が無いものを先頭に混ぜない。

## Service Worker

- **`js/` や `css/` を変えたら `sw.js` の `VERSION` を上げる。** 資材はキャッシュ優先
  （裏で取り直す stale-while-revalidate）なので、上げないと利用者には古いままが出る。
  上げるとキャッシュ名ごと入れ替わり、更新通知も出る
- **ファイルを増やしたら `PRECACHE` にも足す。** 足し忘れてもオンラインなら動くので
  気づきにくく、オフラインのときだけ壊れる
- `install` は資材を 1 つずつ `catch` して足す。`cache.addAll` だと 1 つ失敗した時点で
  インストール全体が失敗し、オフライン対応が丸ごと効かなくなる
- **パスは全部相対（`./`）。** GitHub Pages はサブディレクトリ配信
  （`https://<user>.github.io/point_wallet/`）なので、`/` 始まりに変えると全部外れる。
  `manifest.webmanifest` の `start_url` / `scope` も同じ理由で `.`
- ページ遷移だけネットワーク優先。取れなければキャッシュした `index.html` を返す

## 通知はアプリを開いたときだけ

サーバーを持たないので push は行わない。`notifyUpcoming()` が起動時に見て、
7 日以内（`DANGER_DAYS`）に失効するものがあれば出す。

- **1 日 1 回に絞る**（localStorage の `point-wallet:last-notified` に日付を入れる）。
  起動のたびに出すと通知が鬱陶しくなって切られる
- `Notification.requestPermission()` は**ユーザー操作の中で呼ぶ**。起動直後に呼んでも
  ブラウザが黙って拒否する（メニューの「失効前の通知を有効にする」から呼んでいる）
- `tag` を固定しているので、同じ端末で重ねて出しても 1 件に畳まれる

## テスト

```bash
npm test     # node --test。依存なし、ビルドなし
npm start    # http://localhost:8000。Service Worker は file:// では動かない
```

- 見ているのは `js/core.js`（日付計算・状態判定・検証・集計・並び替え）と
  `js/store.js`（バックアップの組み立て・取り込み・統合）。**どちらも DOM を使わない**
- `js/store.js` のテストは `js/db.js` を通らない部分（`buildBackup` / `parseBackup` /
  `mergeEntries` / `appendEntries`）だけを見る。IndexedDB は Node に無いので、
  保存経路のテストを足したくなったら先に切り分け方を考える
- CI（`.github/workflows/ci.yml`）は全ブランチの push と PR で `npm test` を流すだけ。
  画面まわりは自動テストが無いので、UI を触ったら `npm start` で実際に開いて確かめる

## 公開（GitHub Pages）

`main` への push で `.github/workflows/pages.yml` が走る。PWA としてホーム画面に
追加するには HTTPS が要るので、動作確認も公開後の URL で行う（`localhost` は例外的に
Service Worker が動くが、`navigator.storage.persist()` の挙動などは配信環境で変わる）。
