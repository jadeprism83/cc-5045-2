// 无头验证：确定性随机数、加权汇合、去重、顺序不变性、
// 单进程 vs 多进程同一样本集合、故障注入（重试/遗失/乱序）下的覆盖率与噪声。
import assert from 'node:assert';
import { randIndex } from '../src/rng.js';
import { SCENE } from '../src/scene.js';
import { renderChunk } from '../src/tracer.js';
import { Merger } from '../src/merger.js';
import { Scheduler } from '../src/scheduler.js';

const TOL = 1e-9;
let passed = 0;
function ok(name, cond, detail = '') {
  assert(cond, `${name} ${detail}`);
  passed++;
  console.log(`  PASS ${name} ${detail}`);
}

// 1. 随机数由稳定索引驱动
{
  const a = randIndex(100, 5, 3);
  ok('rng-deterministic', randIndex(100, 5, 3) === a);
  ok('rng-sample-distinct', randIndex(100, 6, 3) !== a && randIndex(100, 5, 4) !== a && randIndex(101, 5, 3) !== a);
  const vals = new Set();
  for (let s = 0; s < 4096; s++) vals.add(randIndex(7, s, 0));
  ok('rng-no-reuse-4096', vals.size === 4096, `unique=${vals.size}`);
}

// 2. 加权合并：不同采样数的均值不得等权相加
{
  const m = new Merger(1, 1);
  const tile = { x0: 0, y0: 0, w: 1, h: 1 };
  // 区间A: 4 个样本，值全为 1 → sum=4；区间B: 8 个样本，值全为 3 → sum=24
  m.addChunk('A', tile, 4, new Float64Array([4, 4, 4]), new Float64Array(3));
  m.addChunk('B', tile, 8, new Float64Array([24, 24, 24]), new Float64Array(3));
  const pooled = (4 * 1 + 8 * 3) / 12; // 2.3333
  ok('weighted-mean', Math.abs(m.mean[0] - pooled) < 1e-12, `mean=${m.mean[0]} pooled=${pooled}`);
  ok('not-equal-weight', Math.abs(m.mean[0] - 2) > 1e-6, '等权相加会给 2，被正确拒绝');
  // 合并方差 = 直接对 12 个值计算的 M2
  const direct = 4 * (1 - pooled) ** 2 + 8 * (3 - pooled) ** 2;
  ok('welford-parallel', Math.abs(m.M2[0] - direct) < 1e-9, `M2=${m.M2[0]} direct=${direct}`);
}

// 3. 重复回传只计入一次
{
  const m = new Merger(1, 1);
  const tile = { x0: 0, y0: 0, w: 1, h: 1 };
  m.addChunk('A', tile, 4, new Float64Array([4, 4, 4]), new Float64Array(3));
  const again = m.addChunk('A', tile, 4, new Float64Array([4, 4, 4]), new Float64Array(3));
  ok('dedup-rejected', again === false && m.duplicates === 1);
  ok('dedup-count-once', m.count[0] === 4 && m.acceptedSamples === 4, `count=${m.count[0]}`);
}

// 4. 合并顺序不影响结果（浮点容差内）
{
  const mk = (seed) => {
    const chunks = [];
    let x = seed;
    for (let i = 0; i < 8; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      chunks.push({ key: `k${i}`, n: 3 + (x % 5), v: (x % 1000) / 100 });
    }
    return chunks;
  };
  const chunks = mk(42);
  const run = (order) => {
    const m = new Merger(1, 1);
    const tile = { x0: 0, y0: 0, w: 1, h: 1 };
    for (const i of order) {
      const c = chunks[i];
      m.addChunk(c.key, tile, c.n, new Float64Array([c.v * c.n, 0, 0]), new Float64Array(3));
    }
    return m;
  };
  const fwd = run([0, 1, 2, 3, 4, 5, 6, 7]);
  const rev = run([7, 6, 5, 4, 3, 2, 1, 0]);
  ok('order-invariant-mean', Math.abs(fwd.mean[0] - rev.mean[0]) < 1e-12, `d=${Math.abs(fwd.mean[0] - rev.mean[0])}`);
}

// 5. 路径追踪：单进程同一样本集合 vs 多进程（含故障注入）
{
  const W = 48, H = 36, tileSize = 12, budget = 24, chunk = 6;
  const tiles = [];
  for (let y0 = 0; y0 < H; y0 += tileSize)
    for (let x0 = 0; x0 < W; x0 += tileSize)
      tiles.push({ x0, y0, w: Math.min(tileSize, W - x0), h: Math.min(tileSize, H - y0) });

  // 单进程参考：每瓦片一个完整区间 [0,budget)，顺序合并
  const ref = new Merger(W, H);
  for (const t of tiles) {
    const r = renderChunk(SCENE, W, H, t, 0, budget);
    ref.addChunk(`ref:${t.x0}:${t.y0}`, t, r.count, r.sum, r.M2);
  }

  // 多进程：区间切分 + 重试 + 遗失 + 乱序
  const sched = new Scheduler({
    W, H, tileSize, budget, chunkSize: chunk, concurrency: 4,
    execute: (task) => renderChunk(SCENE, W, H, task.tile, task.s0, task.s1),
    faults: { retry: true, loss: true, shuffle: true, seed: 20261117 },
    onEvent: () => {},
  });
  sched.start();
  await new Promise((res) => {
    const iv = setInterval(() => {
      if (sched.state === 'incomplete' || sched.state === 'complete') { clearInterval(iv); res(); }
    }, 5);
  });
  ok('loss-detected', sched.state === 'incomplete' && sched.lost.length > 0, `lost=${sched.lost.length}`);
  const covBefore = sched.coverage();
  ok('coverage-deficit', covBefore.acceptedIntervals + sched.lost.length === covBefore.totalIntervals,
     `${covBefore.acceptedIntervals}+${sched.lost.length}/${covBefore.totalIntervals}`);
  const ppBefore = sched.merger.perPixel();
  ok('partial-count-visible', ppBefore.min < budget, `min=${ppBefore.min} max=${ppBefore.max}`);

  sched.heal();
  await new Promise((res) => {
    const iv = setInterval(() => { if (sched.state === 'complete') { clearInterval(iv); res(); } }, 5);
  });
  const pp = sched.merger.perPixel();
  ok('full-coverage', pp.min === budget && pp.max === budget, `min=${pp.min} max=${pp.max}`);
  ok('duplicates-happened', sched.merger.duplicates > 0, `dup=${sched.merger.duplicates}`);
  ok('retries-happened', sched.retries > 0, `retries=${sched.retries}`);

  const cmp = sched.merger.compare(ref.mean);
  ok('single-vs-multi-rmse', cmp.rmse < TOL, `RMSE=${cmp.rmse.toExponential(3)} maxAbs=${cmp.maxAbs.toExponential(3)}`);
  console.log(`  INFO 多进程噪声估计=${sched.merger.noise().toExponential(3)} 参考噪声=${ref.noise().toExponential(3)}`);
  console.log(`  INFO 浮点累加顺序差异: RMSE=${cmp.rmse.toExponential(3)}，远小于噪声 ${sched.merger.noise().toExponential(3)}`);
}

console.log(`\n全部 ${passed} 项验证通过`);
