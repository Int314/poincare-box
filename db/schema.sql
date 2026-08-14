-- ポアンカレの箱 — D1 スキーマ
--
-- 粒子配置そのものは保存しない (SEED と tick から毎回導出する)。
-- ここに置くのは集計結果だけなので、永久に動かしてもテーブルは
-- records 101 行 + daily 1行/日 に収まる。

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- k (左半分にいた粒子数) ごとの初出と累計回数。k=0..100 の最大 101 行。
CREATE TABLE IF NOT EXISTS records (
  k          INTEGER PRIMARY KEY,
  first_tick INTEGER NOT NULL,
  hit_count  INTEGER NOT NULL DEFAULT 0
);

-- 日次集計 (日境界は JST)。
CREATE TABLE IF NOT EXISTS daily (
  day           TEXT    PRIMARY KEY,   -- 'YYYY-MM-DD' (JST)
  max_k         INTEGER NOT NULL,
  max_tick      INTEGER NOT NULL,
  observations  INTEGER NOT NULL,
  entropy_drops INTEGER NOT NULL,      -- 前回観測よりエントロピーが下がった回数
  min_entropy   REAL    NOT NULL       -- その日の最小エントロピー (0..1)
);

CREATE INDEX IF NOT EXISTS idx_daily_max_k ON daily (max_k DESC);
