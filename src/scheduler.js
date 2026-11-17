// 采样调度器：把每像素样本编号区间 [s0,s1) × 像素瓦片 切分为任务，
// 分发给执行器（浏览器中为 Web Worker 池，测试中可为同步函数）。
// 故障注入：任务重试（崩溃重派 / 重复执行）、区间遗失、回传顺序打乱。
// 所有失败都会反馈回汇合内核：遗失区间不进统计、重试重复回传被拒绝计数、
// 覆盖率下降可通过 heal() 补采缺失区间恢复。
import { Merger } from './merger.js';
import { makeStream } from './rng.js';

export function buildTiles(W, H, size) {
  const tiles = [];
  let id = 0;
  for (let y0 = 0; y0 < H; y0 += size)
    for (let x0 = 0; x0 < W; x0 += size)
      tiles.push({ id: id++, x0, y0, w: Math.min(size, W - x0), h: Math.min(size, H - y0) });
  return tiles;
}

export function buildIntervals(budget, chunk) {
  const iv = [];
  let id = 0;
  for (let s0 = 0; s0 < budget; s0 += chunk) iv.push({ id: id++, s0, s1: Math.min(s0 + chunk, budget) });
  return iv;
}

export class Scheduler {
  constructor({ W, H, tileSize = 20, budget = 128, chunkSize = 16, concurrency = 4,
                execute, faults = {}, onEvent = () => {} }) {
    this.W = W; this.H = H;
    this.budget = budget; this.chunkSize = chunkSize;
    this.concurrency = concurrency;
    this.execute = execute;
    this.faults = faults;
    this.onEvent = onEvent;
    this.tiles = buildTiles(W, H, tileSize);
    this.intervals = buildIntervals(budget, chunkSize);
    this.tasks = [];
    for (const iv of this.intervals)
      for (const t of this.tiles)
        this.tasks.push({ key: `${t.id}:${iv.id}`, tileId: t.id, intervalId: iv.id, s0: iv.s0, s1: iv.s1, tile: t });
    this.merger = new Merger(W, H);
    this.rand = makeStream(faults.seed ?? 1234);
    this.pending = [...this.tasks];
    this.inFlight = 0;
    this.buffer = [];
    this.lost = [];
    this.retries = 0;
    this.state = 'idle';
  }

  get totalSamples() { return this.W * this.H * this.budget; }

  start() { this.state = 'running'; this._emit('state'); this._pump(); }
  pause() { if (this.state === 'running') { this.state = 'paused'; this._emit('state'); } }
  resume() { if (this.state === 'paused') { this.state = 'running'; this._emit('state'); this._pump(); } }

  heal() {
    if (this.state !== 'incomplete' || this.lost.length === 0) return;
    const n = this.lost.length;
    this.pending.push(...this.lost.splice(0));
    this.onEvent({ type: 'heal', count: n });
    this.state = 'running';
    this._emit('state');
    this._pump();
  }

  coverage() {
    return {
      acceptedIntervals: this.merger.seen.size,
      totalIntervals: this.tasks.length,
      lostPending: this.lost.length,
      acceptedSamples: this.merger.acceptedSamples,
      totalSamples: this.totalSamples,
    };
  }

  _emit(type) { this.onEvent({ type, state: this.state }); }

  _pump() {
    while (this.state === 'running' && this.inFlight < this.concurrency && this.pending.length > 0) {
      this._dispatch(this.pending.shift());
    }
    this._maybeDone();
  }

  _dispatch(t) {
    if (this.faults.retry && this.rand() < 0.08) {
      // 崩溃重试：本次不执行，重新排队（样本区间不变，内容不变）
      this.retries++;
      this.onEvent({ type: 'retry-crash', key: t.key });
      this.pending.push(t);
      return;
    }
    if (this.faults.retry && this.rand() < 0.08) {
      // 重复执行：两个执行者算同一区间，后到结果必须被汇合内核拒绝
      this.retries++;
      this.onEvent({ type: 'retry-dup', key: t.key });
      this._run(t);
      this._run(t);
      return;
    }
    this._run(t);
  }

  _run(t) {
    this.inFlight++;
    Promise.resolve()
      .then(() => this.execute(t))
      .then((res) => { this.inFlight--; this._onResult(t, res); this._pump(); })
      .catch((err) => {
        this.inFlight--;
        this.retries++;
        this.onEvent({ type: 'error', key: t.key, message: String(err) });
        this.pending.push(t);
        this._pump();
      });
  }

  _onResult(t, res) {
    if (this.faults.loss && this.rand() < 0.12 && !this.merger.seen.has(t.key)) {
      // 区间遗失：结果被丢弃，不进入汇合统计，等待补采
      this.lost.push(t);
      this.onEvent({ type: 'lost', key: t.key });
      return;
    }
    if (this.faults.shuffle) {
      this.buffer.push({ t, res });
      while (this.buffer.length > 0 && (this.buffer.length >= 3 || (this.pending.length === 0 && this.inFlight === 0))) {
        const i = Math.floor(this.rand() * this.buffer.length);
        const { t: bt, res: br } = this.buffer.splice(i, 1)[0];
        this._deliver(bt, br);
      }
      return;
    }
    this._deliver(t, res);
  }

  _deliver(t, res) {
    const ok = this.merger.addChunk(t.key, t.tile, res.count, res.sum, res.M2);
    if (ok) {
      // 重复执行的另一份到达：该区间实际并未遗失，从遗失清单移除
      const i = this.lost.findIndex((x) => x.key === t.key);
      if (i >= 0) this.lost.splice(i, 1);
      this.onEvent({ type: 'chunk', key: t.key, acceptedSamples: this.merger.acceptedSamples });
    } else this.onEvent({ type: 'duplicate', key: t.key, duplicates: this.merger.duplicates });
  }

  _maybeDone() {
    if ((this.state !== 'running' && this.state !== 'paused') || this.pending.length > 0 || this.inFlight > 0) return;
    while (this.buffer.length > 0) {
      const { t, res } = this.buffer.splice(Math.floor(this.rand() * this.buffer.length), 1)[0];
      this._deliver(t, res);
    }
    this.state = this.lost.length > 0 ? 'incomplete' : 'complete';
    this._emit('state');
  }
}
