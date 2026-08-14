/**
 * OG 画像ジェネレータ。public/core.js と同じ導出で実在の tick の配置を描く。
 * 中間ファイルは tmp/ に置き、成果物だけ public/og.png に出す。
 *
 *   npm run og
 *
 * ヘッドレス Chrome で撮って sips で 1200×630 に落とすので、macOS + Chrome が必要。
 * 描画内容は固定 tick なので、記録が更新されても再生成は不要。
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SEED = 'poincare-box-v1', N = 100, TICK = 3147;

// core.js と同じ: 先頭100ビット、1 が左
const digest = createHash('sha256').update(`${SEED}:${TICK}`).digest();
const bits = [];
for (let i = 0; i < N; i++) bits.push((digest[i >> 3] >> (7 - (i & 7))) & 1);
const k = bits.reduce((a, b) => a + b, 0);
console.log(`tick ${TICK}: 左に ${k} 個 / 右に ${N - k} 個`);

const W = 1200, H = 630;
const BX = 80, BY = 210, BW = W - 160, BH = 300;

// 左右それぞれにグリッドを組む（サイト の assignTargets と同じ考え方）
function grid(count, x0, halfW) {
  const pad = 18, iw = halfW - pad * 2, ih = BH - pad * 2;
  const cols = Math.max(1, Math.min(count, Math.round(Math.sqrt((count * iw) / ih))));
  const rows = Math.ceil(count / cols);
  const cw = Math.min(iw / cols, 30), ch = Math.min(ih / rows, 30);
  return { cols, cw, ch, ox: x0 + (halfW - cols * cw) / 2 + cw / 2, oy: BY + (BH - rows * ch) / 2 + ch / 2 };
}
const gl = grid(k, BX, BW / 2), gr = grid(N - k, BX + BW / 2, BW / 2);
const pts = [];
let li = 0, ri = 0;
for (const b of bits) {
  const g = b ? gl : gr, n = b ? li++ : ri++;
  pts.push({ x: g.ox + (n % g.cols) * g.cw, y: g.oy + Math.floor(n / g.cols) * g.ch, left: b });
}

const dots = pts.map((p) =>
  `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5.5" fill="${p.left ? '#7dd3fc' : '#64748b'}"/>`).join('');

writeFileSync('tmp/og.html', `<!doctype html><meta charset="utf-8">
<style>
html,body{margin:0;padding:0;width:${W}px;height:${H}px;overflow:hidden}
body{background:#0a0c10;font-family:ui-sans-serif,system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;font-feature-settings:"palt"}
.t{position:absolute;top:74px;left:0;width:100%;text-align:center;color:#e6edf3;font-size:60px;font-weight:600;letter-spacing:.07em}
.s{position:absolute;top:158px;left:0;width:100%;text-align:center;color:#8b98a8;font-size:25px}
.f{position:absolute;top:548px;left:0;width:100%;text-align:center;color:#5b6673;font-size:24px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.f b{color:#7dd3fc;font-weight:400}
</style>
<div class="t">ポアンカレの箱</div>
<div class="s">100個の粒子が全部左半分に集まる日まで</div>
<svg width="${W}" height="${H}" style="position:absolute;top:0;left:0">
  <rect x="${BX}" y="${BY}" width="${BW}" height="${BH}" rx="12" fill="#070910" stroke="#232c38" stroke-width="1.5"/>
  <rect x="${BX}" y="${BY}" width="${BW / 2}" height="${BH}" rx="12" fill="#7dd3fc" opacity="0.035"/>
  <line x1="${BX + BW / 2}" y1="${BY}" x2="${BX + BW / 2}" y2="${BY + BH}" stroke="#232c38" stroke-width="1.5" stroke-dasharray="5 8"/>
  ${dots}
</svg>
<div class="f">期待待ち時間 <b>1.2×10²⁴</b> 年 — 宇宙年齢の約8.7兆倍</div>`);

execFileSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
  `--window-size=${W},${H}`, '--screenshot=tmp/og@2x.png', 'tmp/og.html',
], { stdio: 'ignore' });
execFileSync('sips', ['-z', String(H), String(W), 'tmp/og@2x.png', '--out', 'public/og.png'], { stdio: 'ignore' });
console.log('public/og.png を生成しました');
