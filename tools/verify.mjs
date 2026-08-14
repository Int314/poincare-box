#!/usr/bin/env node
/**
 * ポアンカレの箱 — 検証ツール
 *
 * 1. 同期版 SHA-256 が node:crypto と完全一致することを確認
 * 2. 決定論性 (同じ tick は何度引いても同じ) を確認
 * 3. 指定 tick 数を走査して記録の伸びと突破した壁を実測
 *
 *   node tools/verify.mjs            # 既定 551,241 tick
 *   node tools/verify.mjs 1051200    # 1年ぶん
 *
 * このスクリプトは公開用の検証ツールでもある。第三者が
 * public/core.js を落として同じ結果になることを確かめられる。
 */
import { createHash } from 'node:crypto';
import {
  SEED, N, TICK_MS, EPOCH_MS, WALLS, EXPECTED_WAIT_YEARS,
  leftCount, configAt, tickToMs, dayKey, entropy, tailOdds,
} from '../public/core.js';

const fmt = (n) => n.toLocaleString('en-US');
const at = (tick) => new Date(tickToMs(tick)).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
let failures = 0;

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

// ── 1. node:crypto との一致 ────────────────────────────────────
console.log('■ SHA-256 実装の一致検証 (vs node:crypto)');
{
  let mismatched = 0;
  const probes = [0, 1, 2, 7, 42, 999, 12345, 551241, 1051200, 99999999];
  for (let t = 0; t < 20000; t++) probes.push(t);

  for (const t of probes) {
    const digest = createHash('sha256').update(`${SEED}:${t}`).digest();
    // 先頭 100 ビットを参照実装で取り出す
    let refK = 0;
    for (let i = 0; i < 12; i++) {
      for (let b = 7; b >= 0; b--) refK += (digest[i] >> b) & 1;
    }
    for (let b = 7; b >= 4; b--) refK += (digest[12] >> b) & 1;

    if (leftCount(t) !== refK) mismatched++;

    // 配置そのものも突き合わせる
    const bits = configAt(t);
    for (let i = 0; i < N; i++) {
      const byte = digest[i >> 3];
      const refBit = (byte >> (7 - (i & 7))) & 1;
      if (bits[i] !== refBit) { mismatched++; break; }
    }
  }
  check(`${fmt(probes.length)} tick を照合`, mismatched === 0,
    mismatched === 0 ? '全一致' : `${mismatched} 件不一致`);
}

// ── 2. 決定論性 ────────────────────────────────────────────────
console.log('\n■ 決定論性');
for (const t of [0, 12345, 551241]) {
  const runs = [leftCount(t), leftCount(t), leftCount(t)];
  const same = runs.every((v) => v === runs[0]);
  check(`tick ${fmt(t)} (${at(t)})`, same, `左 ${runs[0]} 個 ×3回`);
}
{
  const a = Array.from(configAt(300000)).join('');
  const b = Array.from(configAt(300000)).join('');
  check('tick 300,000 の配置が再実行で一致', a === b);
  console.log('    ' + a.slice(0, 50).replace(/1/g, '◀').replace(/0/g, '▶') + ' …');
}

// ── 3. 壁のはしご ──────────────────────────────────────────────
console.log('\n■ 確率の壁');
for (const w of WALLS) {
  console.log(`  10^${String(w.exponent).padStart(2)} の壁 → 左に ${w.k} 個  (実際は 1/${fmt(Math.round(w.odds))})`);
}
check('最上段が本命 (全粒子が左) と一致', WALLS[WALLS.length - 1].k === N);

// ── 4. 走査 ────────────────────────────────────────────────────
const TOTAL = Number(process.argv[2] ?? 551_241);
console.log(`\n■ ${fmt(TOTAL)} tick の走査`);
const marks = new Map([
  [2880, '1日'], [20160, '1週間'], [86400, '1ヶ月'],
  [259200, '3ヶ月'], [1051200, '1年'], [TOTAL, `全体 (${fmt(TOTAL)})`],
]);

let best = 0, bestTick = 0, drops = 0, prevS = entropy(leftCount(-1));
const firstSeen = new Map();
const t0 = performance.now();

for (let t = 0; t < TOTAL; t++) {
  const k = leftCount(t);
  const s = entropy(k);
  if (s < prevS) drops++;
  prevS = s;
  if (!firstSeen.has(k)) firstSeen.set(k, t);
  if (k > best) { best = k; bestTick = t; }
  if (marks.has(t + 1)) {
    console.log(`  ${marks.get(t + 1).padEnd(22)} 最高記録 左に ${best} 個  (初出 ${at(bestTick)} / ${dayKey(bestTick)} JST)`);
  }
}
const elapsed = performance.now() - t0;

console.log('\n■ 突破した壁');
let cleared = 0;
for (const w of WALLS) {
  const ok = best >= w.k;
  if (ok) cleared++;
  const when = ok ? dayKey(firstSeen.get([...firstSeen.keys()].filter((k) => k >= w.k).sort((a, b) => a - b)[0])) : '—';
  console.log(`  ${ok ? '★' : '☆'} 1/${fmt(Math.round(w.odds)).padStart(34)} の壁 (左に ${w.k} 個)  ${when}`);
}
console.log(`  → ${cleared} / ${WALLS.length}`);

console.log('\n■ 統計');
console.log(`  総観測回数           ${fmt(TOTAL)} 回`);
console.log(`  最高記録             左に ${best} 個  (1/${fmt(Math.round(tailOdds(best)))})`);
console.log(`  エントロピー減少回数   ${fmt(drops)} 回 (${(drops / TOTAL * 100).toFixed(1)}%)`);
console.log(`  本命の期待待ち時間     ${EXPECTED_WAIT_YEARS.toExponential(2)} 年 (宇宙年齢の ${(EXPECTED_WAIT_YEARS / 1.38e10).toExponential(1)} 倍)`);

console.log('\n■ 性能');
console.log(`  ${fmt(TOTAL)} tick の走査        ${elapsed.toFixed(0)} ms`);
console.log(`  1日 (2,880 tick) の追いつき  ${(elapsed / TOTAL * 2880).toFixed(1)} ms`);
console.log(`  1年 (1,051,200 tick) 相当    ${(elapsed / TOTAL * 1051200 / 1000).toFixed(2)} 秒`);

console.log(`\n■ 凍結パラメータ`);
console.log(`  SEED=${SEED}  N=${N}  TICK_MS=${TICK_MS}  EPOCH=${new Date(EPOCH_MS).toISOString()}`);

if (failures > 0) {
  console.error(`\n✗ ${failures} 件の検証に失敗しました`);
  process.exit(1);
}
console.log('\n✓ すべての検証に成功しました');
