/**
 * ポアンカレの箱 — 凍結コア
 *
 * ============================================================================
 *  ⚠️  このファイルの内容は変更禁止です。
 *
 *  粒子配置は保存されず、SEED と tick から毎回導出されます。
 *  したがって以下のいずれかを変更すると「過去の歴史」がすべて書き換わり、
 *  記録された最高記録・初出日時・突破した壁がすべて無意味になります。
 *
 *    - SEED / N / TICK_MS / EPOCH_MS の値
 *    - ハッシュ入力の文字列形式  `${SEED}:${tick}`
 *    - ハッシュ関数 (SHA-256) とビットの取り出し順
 *
 *  バグを見つけた場合でも、修正ではなく「実験のやり直し」として
 *  SEED を変え、過去の記録を破棄することを明示してください。
 *  詳細は SPEC.md の「凍結条項」を参照。
 * ============================================================================
 *
 * このファイルは Worker とブラウザの両方から import される唯一の実装です。
 * 静的アセットとしてそのまま配信されるので、第三者が同じコードで
 * 全履歴を再現・検証できます。
 */

// ─── 凍結パラメータ ─────────────────────────────────────────────

/** 乱数種。変更 = 実験のやり直し */
export const SEED = 'poincare-box-v1';

/** 粒子数。N=100 で全粒子が左に集まる確率は 2^-100 ≒ 1/1.27e30 */
export const N = 100;

/** 観測間隔 (ms) */
export const TICK_MS = 30_000;

/** 実験開始時刻 2026-08-13T00:00:00Z */
export const EPOCH_MS = Date.UTC(2026, 7, 13, 0, 0, 0);

// ─── SHA-256 (単一ブロック同期版) ────────────────────────────────
// 入力は常に 56 バイト未満 (`poincare-box-v1:<tick>`) なので 1 ブロックで足りる。
// 同期実装にしてあるのは、ブラウザで数千 tick を一括再現するときに
// crypto.subtle の await 連打を避けるため。

const RK = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const W = new Uint32Array(64);
const BLOCK = new Uint8Array(64);
/** 出力用 h0..h7 を使い回す (シングルスレッド前提) */
const H = new Uint32Array(8);

/**
 * 56 バイト未満の ASCII 文字列を SHA-256 して h0..h7 を返す。
 * 返り値は内部バッファの使い回しなので、次の呼び出しまでに読み切ること。
 * @param {string} ascii
 * @returns {Uint32Array} 長さ 8
 */
function sha256Short(ascii) {
  const len = ascii.length;
  if (len >= 56) throw new Error(`sha256Short: input too long (${len})`);

  BLOCK.fill(0);
  for (let i = 0; i < len; i++) BLOCK[i] = ascii.charCodeAt(i) & 0x7f;
  BLOCK[len] = 0x80;
  const bitLen = len * 8;
  BLOCK[62] = (bitLen >>> 8) & 0xff;
  BLOCK[63] = bitLen & 0xff;

  for (let i = 0; i < 16; i++) {
    const o = i * 4;
    W[i] = ((BLOCK[o] << 24) | (BLOCK[o + 1] << 16) | (BLOCK[o + 2] << 8) | BLOCK[o + 3]) >>> 0;
  }
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15];
    const b = W[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
  }

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + RK[i] + W[i]) >>> 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0;
    d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }

  H[0] = (h0 + a) >>> 0; H[1] = (h1 + b) >>> 0; H[2] = (h2 + c) >>> 0; H[3] = (h3 + d) >>> 0;
  H[4] = (h4 + e) >>> 0; H[5] = (h5 + f) >>> 0; H[6] = (h6 + g) >>> 0; H[7] = (h7 + h) >>> 0;
  return H;
}

/** @param {number} x @returns {number} 立っているビット数 */
function popcount32(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24);
}

// ─── 粒子配置の導出 ─────────────────────────────────────────────
// 先頭 100 ビット = h0(32) + h1(32) + h2(32) + h3 の上位 4 ビット
// ビットが 1 の粒子が左半分にいる。

/**
 * tick t で左半分にいる粒子の数。
 * @param {number} tick
 * @returns {number} 0..100
 */
export function leftCount(tick) {
  const h = sha256Short(`${SEED}:${tick}`);
  return popcount32(h[0]) + popcount32(h[1]) + popcount32(h[2]) + popcount32(h[3] >>> 28);
}

/**
 * tick t の粒子配置。1 = 左半分, 0 = 右半分。
 * @param {number} tick
 * @param {Uint8Array} [out] 長さ N の書き込み先 (省略時は新規確保)
 * @returns {Uint8Array} 長さ N
 */
export function configAt(tick, out) {
  const h = sha256Short(`${SEED}:${tick}`);
  const bits = out ?? new Uint8Array(N);
  let i = 0;
  for (let w = 0; w < 3; w++) {
    const word = h[w];
    for (let b = 31; b >= 0; b--) bits[i++] = (word >>> b) & 1;
  }
  const tail = h[3];
  for (let b = 31; b >= 28; b--) bits[i++] = (tail >>> b) & 1;
  return bits;
}

// ─── 時刻 ⇄ tick ───────────────────────────────────────────────

/** @param {number} [nowMs] @returns {number} 現在の tick (EPOCH 以前は負) */
export const tickAt = (nowMs = Date.now()) => Math.floor((nowMs - EPOCH_MS) / TICK_MS);

/** @param {number} tick @returns {number} その tick が観測された時刻 (ms) */
export const tickToMs = (tick) => EPOCH_MS + tick * TICK_MS;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * tick が属する日 (JST) の 'YYYY-MM-DD'。
 * @param {number} tick
 * @returns {string}
 */
export function dayKey(tick) {
  return new Date(tickToMs(tick) + JST_OFFSET_MS).toISOString().slice(0, 10);
}

// ─── エントロピー ──────────────────────────────────────────────
// ボルツマン: S = k_B ln W, W = C(N, k)
// k=N/2 (最も乱雑) を 1.0、k=0 または N (完全に整列) を 0 に正規化。

/** lnC[k] = ln C(N, k) */
const LN_C = (() => {
  const t = new Float64Array(N + 1);
  let s = 0;
  for (let k = 1; k <= N; k++) {
    s += Math.log(N - k + 1) - Math.log(k);
    t[k] = s;
  }
  return t;
})();

const LN_C_MAX = LN_C[N >> 1];

/** @param {number} k @returns {number} 0..1 の正規化エントロピー */
export const entropy = (k) => LN_C[k] / LN_C_MAX;

/**
 * 左に k 個以上集まる確率 P(X >= k)。
 * @param {number} k
 * @returns {number}
 */
export function tailProbability(k) {
  const ln2N = N * Math.LN2;
  let p = 0;
  for (let i = k; i <= N; i++) p += Math.exp(LN_C[i] - ln2N);
  return p;
}

/** @param {number} k @returns {number} 1/P(X>=k)。「◯分の1の壁」の分母 */
export const tailOdds = (k) => 1 / tailProbability(k);

// ─── 確率の壁 ──────────────────────────────────────────────────
// 10^2 から本命 (2^100 ≒ 1.27e30) まで 11 段のはしご。
// 各段について「その希少度に到達する最小の k」を求める。
//
// 注: この配列は表示用であり、凍結対象ではない。records には k がそのまま
// 記録されるので、はしごの刻みを変えても過去の記録は失われない。

const WALL_EXPONENTS = [2, 3, 4, 5, 6, 7, 9, 12, 16, 21, 30];

/** @type {{exponent: number, k: number, odds: number}[]} */
export const WALLS = WALL_EXPONENTS.map((exponent) => {
  const target = Math.pow(10, exponent);
  let k = N;
  for (let i = N >> 1; i <= N; i++) {
    if (tailOdds(i) >= target) { k = i; break; }
  }
  return { exponent, k, odds: tailOdds(k) };
});

/** 本命 (全粒子が左) の期待待ち時間 (年) */
export const EXPECTED_WAIT_YEARS = (Math.pow(2, N) * TICK_MS) / 1000 / (365.2425 * 86400);
