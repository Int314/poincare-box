/**
 * ポアンカレの箱 — フロントエンド
 *
 * 粒子配置はサーバーに問い合わせず、core.js でブラウザ自身が計算します。
 * サーバーに聞くのは集計 (総観測回数・最高記録・壁) だけです。
 */
import { N, TICK_MS, EPOCH_MS, leftCount, configAt, tickAt, tickToMs, entropy, tailOdds } from './core.js';

// ─── 表示ユーティリティ ─────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const SUP = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
const sup = (n) => String(n).split('').map((c) => SUP[+c] ?? c).join('');
const nf = (n) => Number(n).toLocaleString('ja-JP');

/** 1/1,117 や 1/1.27×10³⁰ の形に整える */
function formatOdds(odds) {
  if (!Number.isFinite(odds)) return '—';
  if (odds < 1e7) return `1/${nf(Math.round(odds))}`;
  const e = Math.floor(Math.log10(odds));
  return `1/${(odds / 10 ** e).toFixed(2)}×10${sup(e)}`;
}

const JST = { timeZone: 'Asia/Tokyo' };
const fmtDateTime = (ms) =>
  new Intl.DateTimeFormat('ja-JP', {
    ...JST, year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(ms));
const fmtDate = (ms) =>
  new Intl.DateTimeFormat('ja-JP', { ...JST, year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(ms));

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ─── 箱と粒子 ──────────────────────────────────────────────────

const canvas = $('box');
const ctx = canvas.getContext('2d');

/** 論理座標系。バッキングストアの実サイズとは独立に、常にこの寸法で描く。 */
const BOX_W = 900;
const BOX_H = 420;
const R = 4.2;
const PAD = R + 6;

/** 表示幅と devicePixelRatio に合わせてバッキングストアを張り直す */
function fitCanvas(el, logicalW, logicalH) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = el.getBoundingClientRect().width;
  if (!w) return false;
  const bw = Math.round(w * dpr);
  const bh = Math.round((bw * logicalH) / logicalW);
  if (el.width === bw && el.height === bh) return true;
  el.width = bw;
  el.height = bh;
  return true;
}

/** @type {{x:number,y:number,vx:number,vy:number,sx:number,sy:number,tx:number,ty:number,side:number}[]} */
const particles = Array.from({ length: N }, () => ({
  x: PAD + Math.random() * (BOX_W - PAD * 2),
  y: PAD + Math.random() * (BOX_H - PAD * 2),
  vx: 0, vy: 0, sx: 0, sy: 0, tx: 0, ty: 0, side: 0,
}));

const randomVelocity = (p) => {
  const a = Math.random() * Math.PI * 2;
  const s = 0.25 + Math.random() * 0.35;
  p.vx = Math.cos(a) * s;
  p.vy = Math.sin(a) * s;
};
particles.forEach(randomVelocity);

/**
 * 配置ビットから各粒子の整列位置を決める。
 * 左右それぞれの半分に、個数に応じたグリッドを組んで中央に配置する。
 * @param {Uint8Array} bits
 */
function assignTargets(bits) {
  const counts = [0, 0];
  for (let i = 0; i < N; i++) counts[bits[i]]++;

  const halfW = BOX_W / 2;
  const grids = [null, null];
  for (const side of [0, 1]) {
    const c = counts[side];
    if (c === 0) { grids[side] = { cols: 1, rows: 1, cw: 0, ch: 0, x0: 0, y0: 0 }; continue; }
    const innerW = halfW - PAD * 2;
    const innerH = BOX_H - PAD * 2;
    const cols = Math.max(1, Math.min(c, Math.round(Math.sqrt((c * innerW) / innerH))));
    const rows = Math.ceil(c / cols);
    const cw = Math.min(innerW / cols, 26);
    const ch = Math.min(innerH / rows, 26);
    const gw = cols * cw;
    const gh = rows * ch;
    grids[side] = {
      cols, rows, cw, ch,
      x0: (side === 1 ? 0 : halfW) + (halfW - gw) / 2 + cw / 2,
      y0: (BOX_H - gh) / 2 + ch / 2,
    };
  }

  const used = [0, 0];
  for (let i = 0; i < N; i++) {
    const side = bits[i];           // 1 = 左
    const g = grids[side];
    const n = used[side]++;
    const col = n % g.cols;
    const row = (n / g.cols) | 0;
    const p = particles[i];
    p.side = side;
    p.sx = p.x; p.sy = p.y;
    p.tx = g.x0 + col * g.cw;
    p.ty = g.y0 + row * g.ch;
  }
}

// ─── 観測の状態機械 ─────────────────────────────────────────────

const SETTLE_MS = 900;
const HOLD_MS = 2600;

const view = {
  mode: 'live',       // 'live' | 'timemachine'
  tick: null,
  bits: new Uint8Array(N),
  k: 0,
  phase: 'free',      // 'free' | 'settle' | 'hold'
  phaseStart: 0,
  frozen: false,      // タイムマシン時は整列したまま止める
};

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * 指定 tick を観測して表示に反映する。
 * @param {number} tick
 * @param {{ animate?: boolean, freeze?: boolean }} [opts]
 */
function observe(tick, { animate = true, freeze = false } = {}) {
  view.tick = tick;
  configAt(tick, view.bits);
  view.k = leftCount(tick);
  view.frozen = freeze;

  assignTargets(view.bits);
  view.phase = 'settle';
  view.phaseStart = performance.now();
  if (!animate) {
    for (const p of particles) { p.x = p.tx; p.y = p.ty; }
    view.phase = freeze ? 'hold' : 'free';
  }

  $('left-count').textContent = view.k;
  $('right-count').textContent = N - view.k;
  $('observed-at').textContent = `${fmtDateTime(tickToMs(tick))} の観測 · tick ${nf(tick)} · エントロピー ${entropy(view.k).toFixed(4)}`;

  if (!animate) flash();
}

/** 観測が確定した瞬間の閃光。整列し終わったタイミングで焚く。 */
function flash() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const el = $('flash');
  el.classList.remove('on');
  void el.offsetWidth;
  el.classList.add('on');
}

function step(now) {
  if (view.phase === 'settle') {
    const t = Math.min(1, (now - view.phaseStart) / SETTLE_MS);
    const e = easeInOut(t);
    for (const p of particles) {
      p.x = p.sx + (p.tx - p.sx) * e;
      p.y = p.sy + (p.ty - p.sy) * e;
    }
    if (t >= 1) {
      // 整列し終わった瞬間が「観測の確定」。ここで初めて左右の色が割れる。
      view.phase = 'hold';
      view.phaseStart = now;
      flash();
    }
  } else if (view.phase === 'hold') {
    if (!view.frozen && now - view.phaseStart >= HOLD_MS) {
      view.phase = 'free';
      particles.forEach(randomVelocity);
    }
  } else {
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < PAD) { p.x = PAD; p.vx = Math.abs(p.vx); }
      if (p.x > BOX_W - PAD) { p.x = BOX_W - PAD; p.vx = -Math.abs(p.vx); }
      if (p.y < PAD) { p.y = PAD; p.vy = Math.abs(p.vy); }
      if (p.y > BOX_H - PAD) { p.y = BOX_H - PAD; p.vy = -Math.abs(p.vy); }
    }
  }
}

function draw() {
  const left = css('--left');
  const right = css('--right');

  fitCanvas(canvas, BOX_W, BOX_H);
  const s = canvas.width / BOX_W;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.clearRect(0, 0, BOX_W, BOX_H);

  // 仕切り線
  ctx.strokeStyle = '#232c38';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(BOX_W / 2, 0);
  ctx.lineTo(BOX_W / 2, BOX_H);
  ctx.stroke();
  ctx.setLineDash([]);

  // 観測が確定している間だけ左半分をうっすら塗って「寄っている」ことを見せる。
  // settle 中は塗らない（移動中の粒子が仕切りをまたぐので誤読しやすい）。
  const settled = view.phase === 'hold';
  if (settled) {
    ctx.fillStyle = 'rgba(125, 211, 252, 0.035)';
    ctx.fillRect(0, 0, BOX_W / 2, BOX_H);
  }

  for (let i = 0; i < N; i++) {
    const p = particles[i];
    ctx.beginPath();
    ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
    ctx.fillStyle = settled ? (p.side === 1 ? left : right) : '#4b5a6b';
    ctx.fill();
  }
}

function loop(now) {
  if (view.mode === 'live') {
    const t = tickAt();
    if (t >= 0 && t !== view.tick) observe(t);
  }
  step(now);
  draw();
  if (sparkDirty && lastState && renderSpark(base64ToBytes(lastState.today.series))) {
    sparkDirty = false;
  }
  requestAnimationFrame(loop);
}

// ─── カウントダウン ─────────────────────────────────────────────

function tickCountdown() {
  const now = Date.now();
  if (now < EPOCH_MS) {
    $('countdown').textContent = '開始前';
    return;
  }
  const remain = TICK_MS - ((now - EPOCH_MS) % TICK_MS);
  const s = Math.ceil(remain / 1000);
  $('countdown').textContent = `${String((s / 60) | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ─── 統計の描画 ────────────────────────────────────────────────

/** 直近の /api/state。リサイズ時のスパークライン再描画に使う。 */
let lastState = null;
/** スパークラインの再描画要求。レイアウト未確定なら描けるまで毎フレーム再試行する。 */
let sparkDirty = false;

function renderState(s) {
  lastState = s;
  $('total-obs').innerHTML = `${nf(s.total.observations)}<span class="unit">回</span>`;
  if (s.total.bestK) {
    $('best').innerHTML =
      `左に ${s.total.bestK}<span class="unit">個</span>` +
      `<span class="when">初出 ${fmtDate(s.total.bestAtMs)}</span>`;
    $('best-odds').textContent = formatOdds(s.total.bestOdds);
  }
  const cleared = s.walls.filter((w) => w.cleared).length;
  $('walls-count').innerHTML = `${cleared} <span class="unit">/ ${s.walls.length}</span>`;

  // 本日
  $('today-date').textContent = s.today.day;
  $('today-obs').textContent = nf(s.today.observations);
  $('today-max').innerHTML = s.today.maxK
    ? `左に ${s.today.maxK}<span class="unit">個</span><span class="when">${fmtDateTime(s.today.maxAtMs).split(' ').pop()}</span>`
    : '—';
  $('today-entropy').textContent = s.today.minEntropy != null ? s.today.minEntropy.toFixed(4) : '—';
  $('today-drops').innerHTML = `${nf(s.today.entropyDrops)}<span class="unit">回</span>`;

  renderWalls(s.walls);
  sparkDirty = true;

  const text =
    `ポアンカレの箱：${nf(s.total.observations)}回の観測で、最高記録は左に${s.total.bestK}個。` +
    `${formatOdds(s.total.bestOdds)} の壁を突破しました。` +
    `100個すべてが左半分に集まる日を待っています。`;
  $('xpost').href =
    `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(location.origin + location.pathname)}`;
}

function renderWalls(walls) {
  const ol = $('walls');
  ol.innerHTML = '';
  for (const w of walls) {
    const li = document.createElement('li');
    li.className = (w.cleared ? 'cleared ' : '') + (w.k === N ? 'goal' : '');
    li.innerHTML =
      `<span class="mark">${w.cleared ? '★' : '☆'}</span>` +
      `<span class="odds">${formatOdds(w.odds)}</span>` +
      `<span class="need">左に ${w.k} 個</span>`;
    ol.appendChild(li);
  }
}

const base64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** 50 からの偏りを上下の棒で描く。上（青）が左寄り、下（灰）が右寄り。 */
const SPARK_W = 1200;
const SPARK_H = 90;

/**
 * @param {Uint8Array} series
 * @returns {boolean} 描画できたか（レイアウト未確定で幅0のときは false）
 */
function renderSpark(series) {
  const c = $('spark');
  const g = c.getContext('2d');
  if (!fitCanvas(c, SPARK_W, SPARK_H)) return false;
  const s = c.width / SPARK_W;
  g.setTransform(s, 0, 0, s, 0, 0);
  const w = SPARK_W;
  const h = SPARK_H;
  const mid = h / 2;
  g.clearRect(0, 0, w, h);

  let peak = 1;
  for (const k of series) peak = Math.max(peak, Math.abs(k - 50));
  const scale = (mid - 4) / peak;

  g.strokeStyle = '#1e2530';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, mid);
  g.lineTo(w, mid);
  g.stroke();

  if (!series.length) return true;

  const bw = Math.max(1, w / 2880);      // 1日ぶんの幅で固定 → 進行度が見える
  const left = css('--left');
  let maxK = 0, maxX = 0;

  for (let i = 0; i < series.length; i++) {
    const d = series[i] - 50;
    const x = i * bw;
    const len = Math.abs(d) * scale;
    g.fillStyle = d >= 0 ? 'rgba(125,211,252,0.55)' : 'rgba(100,116,139,0.5)';
    g.fillRect(x, d >= 0 ? mid - len : mid, Math.max(bw, 0.6), Math.max(len, 0.6));
    if (series[i] > maxK) { maxK = series[i]; maxX = x; }
  }

  // 本日の最高記録に印
  if (maxK > 50) {
    g.fillStyle = left;
    g.fillRect(maxX - 0.5, mid - (maxK - 50) * scale - 3, 2, (maxK - 50) * scale + 3);
  }
  return true;
}

// ─── タイムマシン ──────────────────────────────────────────────

function toLocalInputValue(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 19);
}

function enterTimeMachine(tick) {
  const max = tickAt();
  tick = Math.max(0, Math.min(Math.floor(tick), max));
  view.mode = 'timemachine';
  observe(tick, { animate: true, freeze: true });
  $('tm-status').textContent =
    `過去の瞬間を再現しています（${formatOdds(tailOdds(leftCount(tick)))} の配置）。この計算はあなたのブラウザで行われました。`;
  $('tm-input').value = toLocalInputValue(tickToMs(tick));
  const u = new URL(location.href);
  u.searchParams.set('t', String(tick));
  history.replaceState(null, '', u);
}

function exitTimeMachine() {
  view.mode = 'live';
  view.frozen = false;
  $('tm-status').textContent = '';
  const u = new URL(location.href);
  u.searchParams.delete('t');
  history.replaceState(null, '', u);
  const t = tickAt();
  if (t >= 0) observe(t);
}

$('tm-go').addEventListener('click', () => {
  const v = $('tm-input').value;
  if (!v) return;
  const ms = Date.parse(`${v}+09:00`);
  if (Number.isNaN(ms)) return;
  const tick = Math.floor((ms - EPOCH_MS) / TICK_MS);
  if (tick < 0) {
    $('tm-status').textContent = '実験開始（2026年8月13日 09:00 JST）より前は存在しません。';
    return;
  }
  enterTimeMachine(tick);
});

$('tm-now').addEventListener('click', exitTimeMachine);

// ─── 起動 ──────────────────────────────────────────────────────

async function refresh() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (res.ok) renderState(await res.json());
  } catch (err) {
    console.error('state fetch failed', err);
  }
}

const startTick = tickAt();
const urlTick = new URL(location.href).searchParams.get('t');

$('tm-input').max = toLocalInputValue(tickToMs(Math.max(0, startTick)));
$('tm-input').min = toLocalInputValue(EPOCH_MS);

if (urlTick !== null && Number.isFinite(Number(urlTick))) {
  enterTimeMachine(Number(urlTick));
} else if (startTick >= 0) {
  observe(startTick, { animate: false });
} else {
  $('observed-at').textContent = '実験はまもなく開始されます。';
}

requestAnimationFrame(loop);
tickCountdown();
setInterval(tickCountdown, 250);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { sparkDirty = true; }, 150);
});

refresh();
setInterval(refresh, 60_000);
