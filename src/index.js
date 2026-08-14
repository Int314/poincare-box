/**
 * ポアンカレの箱 — Cloudflare Worker
 *
 * - GET /api/state  現在の状態 + 統計 (アクセス時に未集計ぶんを追いつかせる)
 * - GET /api/at     任意 tick の配置 (DB を触らない純粋計算。タイムマシン用)
 * - それ以外        静的アセット
 * - scheduled       日次 Cron。誰も見に来なくても集計を進める
 */
import {
  N, TICK_MS, EPOCH_MS, SEED, WALLS, EXPECTED_WAIT_YEARS,
  leftCount, configAt, tickAt, tickToMs, dayKey, entropy, tailOdds,
} from '../public/core.js';

/** 1 回の呼び出しで走査する上限 tick 数 (約2年ぶん)。暴走と CPU 超過の保険 */
const MAX_SCAN = 2_100_000;

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...init.headers },
  });

// ─── 追いつき集計 ───────────────────────────────────────────────

/**
 * last_tick の次から現在 tick までを走査し、records / daily を更新する。
 * 配置は導出できるので、途中で落ちても last_tick を進めなければ再実行で復旧する。
 * @param {{ DB: D1Database }} env
 * @returns {Promise<{ from: number, to: number, scanned: number }>}
 */
async function catchUp(env) {
  const now = tickAt();
  if (now < 0) return { from: 0, to: -1, scanned: 0 }; // EPOCH 前

  // daily の絞り込み範囲を知るための先読み。値そのものは信用しない。
  const probe = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind('last_tick').first();
  const probeFrom = Math.max(0, (probe ? Number(probe.value) : -1) + 1);

  // last_tick と集計は必ず同一トランザクションで読む。別々に読むと、その隙間に
  // 他のリクエストが書き戻したぶんの上にもう一度同じ tick を加算してしまい、
  // 絶対値で書き戻しても二重カウントが固定化する。
  // last_tick は単調増加なので、先読みの probeFrom で絞った daily は必要な範囲を必ず含む。
  const [metaRows, recordRows, dailyRows] = await env.DB.batch([
    env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind('last_tick'),
    env.DB.prepare('SELECT k, first_tick, hit_count FROM records'),
    env.DB.prepare('SELECT * FROM daily WHERE day >= ?').bind(dayKey(probeFrom)),
  ]);

  const last = metaRows.results.length ? Number(metaRows.results[0].value) : -1;
  if (last >= now) return { from: last + 1, to: last, scanned: 0 };

  const from = last + 1;
  const to = Math.min(now, from + MAX_SCAN - 1);

  /** @type {Map<number, {first_tick: number, hit_count: number}>} */
  const records = new Map(recordRows.results.map((r) => [r.k, { first_tick: r.first_tick, hit_count: r.hit_count }]));
  /** @type {Map<string, any>} */
  const days = new Map(dailyRows.results.map((r) => [r.day, { ...r }]));
  const touchedDays = new Set();

  // 直前 tick のエントロピー (エントロピー減少の判定に必要)
  let prevS = entropy(leftCount(from - 1));

  for (let t = from; t <= to; t++) {
    const k = leftCount(t);
    const s = entropy(k);

    const rec = records.get(k);
    if (rec) rec.hit_count++;
    else records.set(k, { first_tick: t, hit_count: 1 });

    const day = dayKey(t);
    touchedDays.add(day);
    let d = days.get(day);
    if (!d) {
      d = { day, max_k: k, max_tick: t, observations: 0, entropy_drops: 0, min_entropy: s };
      days.set(day, d);
    }
    d.observations++;
    if (k > d.max_k) { d.max_k = k; d.max_tick = t; }
    if (s < d.min_entropy) d.min_entropy = s;
    if (s < prevS) d.entropy_drops++;

    prevS = s;
  }

  // 書き戻し。records は新規に見た k と hit_count が動いた k だけ。
  const stmts = [];
  const upsertRecord = env.DB.prepare(
    'INSERT INTO records (k, first_tick, hit_count) VALUES (?, ?, ?) ' +
    'ON CONFLICT(k) DO UPDATE SET hit_count = excluded.hit_count'
  );
  for (const [k, r] of records) {
    const before = recordRows.results.find((x) => x.k === k);
    if (!before || before.hit_count !== r.hit_count) {
      stmts.push(upsertRecord.bind(k, r.first_tick, r.hit_count));
    }
  }

  const upsertDaily = env.DB.prepare(
    'INSERT INTO daily (day, max_k, max_tick, observations, entropy_drops, min_entropy) ' +
    'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET ' +
    'max_k = excluded.max_k, max_tick = excluded.max_tick, observations = excluded.observations, ' +
    'entropy_drops = excluded.entropy_drops, min_entropy = excluded.min_entropy'
  );
  for (const day of touchedDays) {
    const d = days.get(day);
    stmts.push(upsertDaily.bind(d.day, d.max_k, d.max_tick, d.observations, d.entropy_drops, d.min_entropy));
  }

  stmts.push(
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('last_tick', ?) " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(String(to))
  );

  await env.DB.batch(stmts);
  return { from, to, scanned: to - from + 1 };
}

// ─── 状態の組み立て ─────────────────────────────────────────────

/** Uint8Array を base64 に (フロントで Uint8Array に戻して使う) */
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * @param {{ DB: D1Database }} env
 */
async function buildState(env) {
  const tick = tickAt();
  const today = dayKey(tick);

  const [best, todayRow, totalRow] = await Promise.all([
    env.DB.prepare('SELECT k, first_tick FROM records ORDER BY k DESC LIMIT 1').first(),
    env.DB.prepare('SELECT * FROM daily WHERE day = ?').bind(today).first(),
    env.DB.prepare('SELECT SUM(observations) AS n, SUM(entropy_drops) AS drops FROM daily').first(),
  ]);

  // 今日ぶんの k 系列 (スパークライン用)。1 バイト 1 観測。
  const dayStartMs = Date.parse(`${today}T00:00:00+09:00`);
  const dayStartTick = Math.max(0, Math.ceil((dayStartMs - EPOCH_MS) / TICK_MS));
  const series = new Uint8Array(Math.max(0, tick - dayStartTick + 1));
  for (let i = 0; i < series.length; i++) series[i] = leftCount(dayStartTick + i);

  const bestK = best ? best.k : 0;

  return {
    n: N,
    seed: SEED,
    tickMs: TICK_MS,
    epochMs: EPOCH_MS,
    tick,
    tickAtMs: tickToMs(tick),
    nextTickAtMs: tickToMs(tick + 1),
    current: {
      k: leftCount(tick),
      bits: toBase64(configAt(tick)),
      entropy: entropy(leftCount(tick)),
    },
    total: {
      observations: totalRow?.n ?? 0,
      entropyDrops: totalRow?.drops ?? 0,
      bestK,
      bestTick: best ? best.first_tick : null,
      bestAtMs: best ? tickToMs(best.first_tick) : null,
      bestOdds: bestK ? tailOdds(bestK) : null,
      expectedWaitYears: EXPECTED_WAIT_YEARS,
    },
    today: {
      day: today,
      maxK: todayRow?.max_k ?? null,
      maxTick: todayRow?.max_tick ?? null,
      maxAtMs: todayRow ? tickToMs(todayRow.max_tick) : null,
      observations: todayRow?.observations ?? 0,
      entropyDrops: todayRow?.entropy_drops ?? 0,
      minEntropy: todayRow?.min_entropy ?? null,
      seriesFromTick: dayStartTick,
      series: toBase64(series),
    },
    walls: WALLS.map((w) => ({
      exponent: w.exponent,
      k: w.k,
      odds: w.odds,
      cleared: bestK >= w.k,
    })),
  };
}

// ─── エントリポイント ───────────────────────────────────────────

export default {
  /**
   * @param {Request} request
   * @param {{ DB: D1Database, ASSETS: Fetcher }} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/state') {
      try {
        await catchUp(env);
      } catch (err) {
        // 集計が失敗しても現在の箱は見せる (次の Cron で追いつく)
        console.error('catchUp failed:', err);
      }
      return json(await buildState(env));
    }

    // タイムマシン: 任意の瞬間を再現する。DB を一切触らない純粋計算。
    if (url.pathname === '/api/at') {
      const raw = url.searchParams.get('tick') ?? url.searchParams.get('t');
      const at = url.searchParams.get('at');
      const now = tickAt();
      let tick;
      let explicit = true;
      if (raw !== null) tick = Number(raw);
      else if (at !== null) tick = Math.floor((Date.parse(at) - EPOCH_MS) / TICK_MS);
      else { tick = now; explicit = false; }

      if (!Number.isFinite(tick)) return json({ error: 'invalid tick' }, { status: 400 });
      const requested = Math.floor(tick);
      tick = Math.max(0, Math.min(requested, now));

      // 明示指定かつクランプされなかった場合だけ、URL に対する純粋関数になるので永久キャッシュしてよい。
      // 未指定・未来指定・負値指定は「現在」に丸められるため、キャッシュすると古い現在が固定されてしまう。
      const pinned = explicit && requested === tick;

      const k = leftCount(tick);
      return json({
        tick,
        atMs: tickToMs(tick),
        day: dayKey(tick),
        k,
        bits: toBase64(configAt(tick)),
        entropy: entropy(k),
        odds: tailOdds(k),
      }, { headers: { 'cache-control': pinned ? 'public, max-age=31536000, immutable' : 'no-store' } });
    }

    return env.ASSETS.fetch(request);
  },

  /** 日次 Cron。誰も見に来なくても集計を進める。 */
  async scheduled(event, env, ctx) {
    const result = await catchUp(env);
    console.log(`catchUp: ${result.scanned} ticks (${result.from}..${result.to})`);
  },
};
