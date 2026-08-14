# ポアンカレの箱 — Claude Code 向けコンテキスト

## 概要

密閉された箱の中の100個の粒子が、全部左半分に集まる瞬間を待ち続けるサイト。ポアンカレの回帰定理（＝熱力学第二法則は統計的な法則にすぎず、エントロピーの自発的減少は禁止されていない）を可視化する。期待待ち時間は約 1.2×10²⁴ 年。

**真実源は [SPEC.md](SPEC.md)。特に「凍結条項」を読まずにコードを触らないこと。**

## 絶対に守ること

`public/core.js` の `SEED` / `N` / `TICK_MS` / `EPOCH_MS` / ハッシュ入力形式 / ハッシュ関数 / ビット取り出し順は**変更禁止**。粒子配置は保存されておらず毎回導出されるので、これらを変えると過去の記録がすべて書き換わる。バグを見つけても修正ではなく「実験のやり直し」として扱う。詳細は SPEC.md §2。

## スタック

- Cloudflare Workers (Static Assets) + D1 + Cron Trigger（日次 00:17 JST）
- ビルドなし。素の ES Modules + Canvas。フレームワークなし
- `public/core.js` は Worker とブラウザの両方が import する唯一の実装（静的配信もされる＝第三者が検証できる）

## ディレクトリ

```
public/core.js    凍結コア（SEED・同期版 SHA-256・configAt/leftCount/entropy/WALLS）
public/index.html 画面
public/app.js     Canvas 描画・観測演出・タイムマシン。配置はブラウザ側で計算する
public/style.css
public/og.png     OG 画像（tools/make-og.mjs の生成物。手で描かない）
src/index.js      Worker。/api/state（追いつき集計）・/api/at（純粋計算）・scheduled
db/schema.sql     meta / records / daily。集計だけを持つ
tools/verify.mjs  検証ツール（node:crypto 一致確認＋走査シミュレーション）
tools/make-og.mjs OG 画像ジェネレータ（実在 tick の配置を描く。macOS + Chrome 必須）
```

## コマンド

```bash
npm run verify   # 必ず変更前後で走らせる。SHA-256 一致と決定論を検証
npm run og       # public/og.png を再生成（固定 tick なので普段は不要）
npm run dev      # wrangler dev
npm run db:local # ローカル D1 にスキーマ適用
npm run deploy
```

ローカルプレビューはワークスペース直下の `.claude/launch.json` の `poincare-dev` を使う。

## デプロイ前の手順

1. `npx wrangler d1 create poincare-box-db`
2. 払い出された ID を `wrangler.jsonc` の `database_id` に差し替え
3. `npm run db:remote`
4. `npm run deploy`

## 一時ファイル

調査スクリプト・スクショは `tmp/` に置く（`.gitignore` 済み）。ワークスペース直下には絶対に置かない。
