# ポアンカレの箱

密閉された箱の中の100個の粒子が、全部左半分に集まる瞬間を待ち続けるサイト。ポアンカレの回帰定理（＝熱力学第二法則は統計的な法則にすぎず、エントロピーの自発的減少は禁止されていない）を可視化する。期待待ち時間は約 1.2×10²⁴ 年。本番: https://poincare-box.int314code.workers.dev

**真実源は [docs/spec.md](docs/spec.md)（アーキテクチャ・データモデルも §4〜5）。特に「凍結条項」を読まずにコードを触らないこと。**

## 絶対に守ること

- `public/core.js` の `SEED` / `N` / `TICK_MS` / `EPOCH_MS` / ハッシュ入力形式 / ハッシュ関数 / ビット取り出し順は**変更禁止**。粒子配置は保存されておらず毎回導出されるので、これらを変えると過去の記録がすべて書き換わる。バグを見つけても修正ではなく「実験のやり直し」として扱う（docs/spec.md §2）。
- 判定を物理シミュレーションに置き換える案は**実測で却下済み**（docs/spec.md §2）。再提案しない。
- 「ポアンカレ予想」と混同したコピーを書かない（別物）。

## 約束事

- ビルドなし・フレームワークなし（素の ES Modules + Canvas）。`public/core.js` は Worker とブラウザの両方が import する唯一の実装で、静的配信もされる（第三者が検証できる）
- `public/og.png` は `npm run og`（`tools/make-og.mjs`。実在 tick の配置を描く。macOS + Chrome 必須）の生成物。手で描かない。固定 tick なので普段は再生成不要
- 索引対象は `/` のみ（`public/robots.txt` / `public/sitemap.xml`）

## 検証・運用

- `npm run verify` は必ず変更前後で走らせる（SHA-256 一致と決定論を検証）
- ローカルプレビューはワークスペース直下の `.claude/launch.json` の `poincare-dev`
- デプロイは手動（`npm run deploy`）。CI（`.github/workflows/test.yml`）は push / PR で `wrangler deploy --dry-run` → `node tools/verify.mjs 50000` を実行し、凍結条項を壊す変更をマージ前に落とす
