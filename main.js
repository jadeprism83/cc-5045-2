// 界面驱动：任务面板 → 调度器 → 汇合内核 → 渐进图像 / 局部进展 / 噪声曲线。
// 控件状态由汇合内核状态机驱动；失败（重试/遗失/重复）全部反馈回汇合统计。
import { Scheduler } from './src/scheduler.js';

const W = 160, H = 120, TILE = 20;
const $ = (id) => document.getElementById(id);
const els = {
  budget: $('budgetSelect'), chunk: $('chunkSelect'), workers: $('workerSelect'), seed: $('seedInput'),
  faultRetry: $('faultRetry'), faultLoss: $('faultLoss'), faultShuffle: $('faultShuffle'),
  exposure: $('exposureRange'),
  start: $('startBtn'), pause: $('pauseBtn'), heal: $('healBtn'), ref: $('refBtn'), reset: $('resetBtn'),
  badge: $('stateBadge'), progressFill: $('progressFill'), progressText: $('progressText'),
  render: $('renderCanvas'), heat: $('heatCanvas'), noise: $('noiseCanvas'),
  statAccepted: $('statAccepted'), statPerPixel: $('statPerPixel'), statCoverage: $('statCoverage'),
  statNoise: $('statNoise'), statDup: $('statDup'), statRetry: $('statRetry'), statLost: $('statLost'),
  statRmse: $('statRmse'), statMaxAbs: $('statMaxAbs'),
  log: $('log'),
};

const rctx = els.render.getContext('2d');
const hctx = els.heat.getContext('2d');
const nctx = els.noise.getContext('2d');

let runId = 0;
let sched = null;
let pool = null;
let refMean = null;
let lastCfg = null;
let noiseHistory = [];
let drawPending = false;

class WorkerPool {
  constructor(url, n) {
    this.idle = [];
    this.queue = [];
    this.workers = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(url, { type: 'module' });
      w.current = null;
      w.onmessage = (e) => {
        const job = w.current;
        w.current = null;
        this.idle.push(w);
        job.resolve(e.data);
        this._pump();
      };
      w.onerror = (e) => {
        const job = w.current;
        w.current = null;
        this.idle.push(w);
        job.reject(e.message || 'worker error');
        this._pump();
      };
      this.workers.push(w);
      this.idle.push(w);
    }
  }
  run(task) {
    return new Promise((resolve, reject) => { this.queue.push({ task, resolve, reject }); this._pump(); });
  }
  _pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const job = this.queue.shift();
      w.current = job;
      w.postMessage({ tile: job.task.tile, s0: job.task.s0, s1: job.task.s1, W, H });
    }
  }
  terminate() { for (const w of this.workers) w.terminate(); }
}

function logLine(html) {
  const li = document.createElement('li');
  li.innerHTML = html;
  els.log.prepend(li);
  while (els.log.children.length > 40) els.log.lastChild.remove();
}

function tonemap(c, exposure) {
  const y = 1 - Math.exp(-c * exposure);
  return Math.round(255 * Math.pow(Math.min(Math.max(y, 0), 1), 1 / 2.2));
}

function drawRender() {
  if (!sched) return;
  const exposure = parseFloat(els.exposure.value);
  const img = rctx.createImageData(W, H);
  const mean = sched.merger.mean;
  const count = sched.merger.count;
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (count[i] === 0) { img.data[o + 3] = 255; continue; }
    img.data[o] = tonemap(mean[i * 3], exposure);
    img.data[o + 1] = tonemap(mean[i * 3 + 1], exposure);
    img.data[o + 2] = tonemap(mean[i * 3 + 2], exposure);
    img.data[o + 3] = 255;
  }
  rctx.putImageData(img, 0, 0);
}

function drawHeat() {
  if (!sched) return;
  const m = sched.merger;
  const lostTiles = new Set(sched.lost.map((t) => t.tileId));
  const img = hctx.createImageData(8, 6);
  for (const t of sched.tiles) {
    let s = 0;
    for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) s += m.count[(t.y0 + y) * W + t.x0 + x];
    const avg = s / (t.w * t.h);
    const f = Math.min(1, avg / sched.budget);
    const o = (t.y0 / TILE * 8 + t.x0 / TILE) * 4;
    let r = Math.round(20 + 30 * f), g = Math.round(25 + 200 * f), b = Math.round(30 + 60 * f);
    if (lostTiles.has(t.id)) { r = 220; g = 120; b = 40; }
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
  hctx.putImageData(img, 0, 0);
}

function drawNoise() {
  const cw = els.noise.width, ch = els.noise.height;
  nctx.clearRect(0, 0, cw, ch);
  if (noiseHistory.length < 2 || !sched) return;
  const maxX = sched.totalSamples;
  const maxY = Math.max(...noiseHistory.map((p) => p[1])) * 1.1;
  const X = (v) => 8 + (v / maxX) * (cw - 16);
  const Y = (v) => ch - 14 - (v / maxY) * (ch - 26);
  // 1/sqrt(N) 参考线（锚定首个观测点）
  const [x0, y0] = noiseHistory[0];
  nctx.strokeStyle = '#3a3f4c';
  nctx.beginPath();
  for (let x = x0; x <= maxX; x *= 1.05) nctx.lineTo(X(x), Y(y0 * Math.sqrt(x0 / x)));
  nctx.stroke();
  nctx.strokeStyle = '#7fb4ff';
  nctx.beginPath();
  noiseHistory.forEach(([x, y], i) => (i ? nctx.lineTo(X(x), Y(y)) : nctx.moveTo(X(x), Y(y))));
  nctx.stroke();
  nctx.fillStyle = '#8a90a0';
  nctx.fillText(`灰线: 1/√N 参考`, 10, 14);
}

function refreshStats() {
  if (!sched) return;
  const m = sched.merger;
  const cov = sched.coverage();
  const pp = m.perPixel();
  els.statAccepted.textContent = `${m.acceptedSamples.toLocaleString()} / ${cov.totalSamples.toLocaleString()}`;
  els.statPerPixel.textContent = m.acceptedSamples ? `${pp.min} / ${pp.max}` : '—';
  els.statCoverage.textContent = `${cov.acceptedIntervals} / ${cov.totalIntervals} 区间`;
  els.statNoise.textContent = m.acceptedSamples ? m.noise().toExponential(3) : '—';
  els.statDup.textContent = m.duplicates;
  els.statRetry.textContent = sched.retries;
  els.statLost.textContent = sched.lost.length;
  els.statLost.className = sched.lost.length ? 'warn' : '';
  els.progressFill.style.width = `${(100 * m.acceptedSamples) / cov.totalSamples}%`;
  els.progressText.textContent = `覆盖率 ${((100 * m.acceptedSamples) / cov.totalSamples).toFixed(1)}% · 状态 ${stateText(sched.state)}`;
  if (refMean && m.acceptedSamples) {
    const cmp = m.compare(refMean);
    els.statRmse.textContent = cmp.rmse.toExponential(3);
    els.statMaxAbs.textContent = cmp.maxAbs.toExponential(3);
  }
}

function stateText(s) {
  return { idle: '空闲', running: '运行中', paused: '已暂停', incomplete: '有区间遗失', complete: '完成' }[s] || s;
}

// 控件由汇合内核状态驱动
function refreshControls() {
  const s = sched ? sched.state : 'idle';
  els.badge.textContent = stateText(s);
  els.badge.className = s;
  const busy = s === 'running' || s === 'paused';
  for (const el of [els.budget, els.chunk, els.workers, els.seed, els.faultRetry, els.faultLoss, els.faultShuffle]) el.disabled = busy;
  els.start.disabled = s !== 'idle';
  els.pause.disabled = !busy;
  els.pause.textContent = s === 'paused' ? '继续' : '暂停';
  els.heal.disabled = s !== 'incomplete';
  els.reset.disabled = s === 'idle';
  els.ref.disabled = busy || !sched || !sched.merger.acceptedSamples;
}

function scheduleDraw() {
  if (drawPending) return;
  drawPending = true;
  setTimeout(() => {
    drawPending = false;
    drawRender(); drawHeat(); drawNoise(); refreshStats();
  }, 120);
}

function makeScheduler(id, cfg) {
  return new Scheduler({
    W, H, tileSize: TILE,
    budget: cfg.budget, chunkSize: cfg.chunk, concurrency: cfg.workers,
    execute: (task) => pool.run(task),
    faults: cfg.faults,
    onEvent: (e) => {
      if (id !== runId) return;
      if (e.type === 'chunk') {
        const m = sched.merger;
        noiseHistory.push([m.acceptedSamples, m.noise()]);
        scheduleDraw();
      } else if (e.type === 'duplicate') {
        logLine(`重复回传被拒绝 <b>${e.key}</b>（累计 ${e.duplicates}）`);
        scheduleDraw();
      } else if (e.type === 'retry-crash') {
        logLine(`任务崩溃，重派 <b>${e.key}</b>`);
      } else if (e.type === 'retry-dup') {
        logLine(`重复执行 <b>${e.key}</b>，后到结果将被拒绝`);
      } else if (e.type === 'lost') {
        logLine(`<span class="warn">区间遗失</span> <b>${e.key}</b>，等待补采`);
        scheduleDraw();
      } else if (e.type === 'heal') {
        logLine(`补采 ${e.count} 个遗失区间`);
      } else if (e.type === 'error') {
        logLine(`<span class="warn">执行失败</span> ${e.key}: ${e.message}`);
      } else if (e.type === 'state') {
        refreshControls();
        refreshStats();
        if (e.state === 'incomplete') logLine(`<span class="warn">存在遗失区间</span>，覆盖率不足，可点击"补采缺失区间"`);
        if (e.state === 'complete') logLine(`<b>汇合完成</b>，已接受 ${sched.merger.acceptedSamples.toLocaleString()} 个样本`);
        drawRender(); drawHeat(); drawNoise();
      }
    },
  });
}

function readConfig() {
  return {
    budget: parseInt(els.budget.value, 10),
    chunk: parseInt(els.chunk.value, 10),
    workers: parseInt(els.workers.value, 10),
    faults: {
      retry: els.faultRetry.checked, loss: els.faultLoss.checked, shuffle: els.faultShuffle.checked,
      seed: parseInt(els.seed.value, 10) || 1,
    },
  };
}

els.start.onclick = () => {
  runId++;
  const cfg = readConfig();
  lastCfg = cfg;
  refMean = null;
  els.statRmse.textContent = '—'; els.statMaxAbs.textContent = '—';
  pool = new WorkerPool('./src/worker.js', cfg.workers);
  noiseHistory = [];
  sched = makeScheduler(runId, cfg);
  logLine(`开始渲染：预算 ${cfg.budget}spp，区间 ${cfg.chunk}，工作进程 ${cfg.workers}` +
    (cfg.faults.retry || cfg.faults.loss || cfg.faults.shuffle ? '（故障注入开启）' : ''));
  refreshControls();
  sched.start();
};

els.pause.onclick = () => {
  if (!sched) return;
  if (sched.state === 'running') sched.pause(); else sched.resume();
  refreshControls();
};

els.heal.onclick = () => { if (sched) sched.heal(); };

els.reset.onclick = () => {
  runId++;
  if (pool) pool.terminate();
  pool = null; sched = null; noiseHistory = []; refMean = null; lastCfg = null;
  for (const c of [rctx, hctx]) { c.clearRect(0, 0, c.canvas.width, c.canvas.height); }
  nctx.clearRect(0, 0, els.noise.width, els.noise.height);
  for (const el of [els.statAccepted, els.statPerPixel, els.statCoverage, els.statNoise,
                    els.statRmse, els.statMaxAbs, els.progressText]) el.textContent = '—';
  els.statDup.textContent = '0'; els.statRetry.textContent = '0'; els.statLost.textContent = '0';
  els.statLost.className = '';
  els.progressFill.style.width = '0';
  refreshControls();
  logLine('已重置');
};

els.ref.onclick = () => {
  if (!sched || !sched.merger.acceptedSamples || !lastCfg) { logLine('请先完成一次渲染再运行参考对比'); return; }
  runId++;
  const id = runId;
  const mainMerger = sched.merger;
  const mainSched = sched;
  pool = new WorkerPool('./src/worker.js', 1);
  logLine('运行单进程参考（同一样本集合，1 个工作进程，无故障注入）…');
  const refSched = new Scheduler({
    W, H, tileSize: TILE, budget: lastCfg.budget, chunkSize: lastCfg.chunk, concurrency: 1,
    execute: (task) => pool.run(task), faults: {},
    onEvent: (e) => {
      if (id !== runId) return;
      if (e.type === 'state' && e.state === 'complete') {
        refMean = refSched.merger.mean.slice();
        sched = mainSched;
        const cmp = mainMerger.compare(refMean);
        els.statRmse.textContent = cmp.rmse.toExponential(3);
        els.statMaxAbs.textContent = cmp.maxAbs.toExponential(3);
        logLine(`参考完成：RMSE=<b>${cmp.rmse.toExponential(3)}</b>，最大差=${cmp.maxAbs.toExponential(3)}（噪声 ${mainMerger.noise().toExponential(3)}，差异仅来自浮点累加顺序）`);
        refreshControls();
      }
    },
  });
  sched = refSched; // 让进度条显示参考进度
  refreshControls();
  refSched.start();
};

els.exposure.oninput = () => drawRender();
refreshControls();
