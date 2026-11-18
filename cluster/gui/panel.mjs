// 出图任务面板逻辑：所有按钮直接调用采样汇合 HTTP API。
// 图像、噪声曲线、均值曲线全部来自 /api/jobs/:id/snapshot 的真实汇合状态，
// 不存在固定数据或本地模拟；服务不可用时明确显示离线。
const $ = (id) => document.getElementById(id);
const els = {
  budget: $('budgetSelect'), jobId: $('jobIdInput'),
  start: $('startBtn'), publish: $('publishBtn'), refresh: $('refreshBtn'),
  badge: $('stateBadge'), fill: $('progressFill'), progressText: $('progressText'),
  nodes: $('nodeList'),
  render: $('renderCanvas'), noise: $('noiseCanvas'), mean: $('meanCanvas'),
  stIntervals: $('stIntervals'), stSamples: $('stSamples'), stPerPixel: $('stPerPixel'),
  stMean: $('stMean'), stChannels: $('stChannels'), stNoise: $('stNoise'),
  stDup: $('stDup'), stRejected: $('stRejected'), stPublish: $('stPublish'),
  log: $('log'),
};
const rctx = els.render.getContext('2d');
const nctx = els.noise.getContext('2d');
const mctx = els.mean.getContext('2d');

let currentJob = null;
let noiseHist = [];
let meanHist = [];
let lastAccepted = -1;

function logLine(html, cls = '') {
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = html;
  els.log.prepend(li);
  while (els.log.children.length > 50) els.log.lastChild.remove();
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { body, status: res.status });
  return body;
}

function tonemap(c, exposure = 1.1) {
  const y = 1 - Math.exp(-c * exposure);
  return Math.round(255 * Math.pow(Math.min(Math.max(y, 0), 1), 1 / 2.2));
}

function drawImage(snap) {
  const { W, H, mean, count } = snap;
  const img = rctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (count[i] === 0) { img.data[o + 3] = 255; continue; }
    img.data[o] = tonemap(mean[i * 3]);
    img.data[o + 1] = tonemap(mean[i * 3 + 1]);
    img.data[o + 2] = tonemap(mean[i * 3 + 2]);
    img.data[o + 3] = 255;
  }
  rctx.putImageData(img, 0, 0);
}

function drawSeries(canvas, ctx, hist, color, refLine = null) {
  const cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);
  if (hist.length < 2) {
    ctx.fillStyle = '#8a90a0';
    ctx.fillText('等待汇合数据…', 10, ch / 2);
    return;
  }
  const maxX = hist[hist.length - 1][0] || 1;
  const maxY = Math.max(...hist.map((p) => p[1])) * 1.15 || 1;
  const X = (v) => 8 + (v / maxX) * (cw - 16);
  const Y = (v) => ch - 18 - (v / maxY) * (ch - 30);
  ctx.strokeStyle = '#2a2e37';
  ctx.beginPath(); ctx.moveTo(8, ch - 18); ctx.lineTo(cw - 8, ch - 18); ctx.stroke();
  if (refLine) {
    ctx.strokeStyle = '#3a3f4c';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    const [x0, y0] = hist[0];
    for (let x = x0 || 1; x <= maxX; x *= 1.05) ctx.lineTo(X(x), Y(y0 * Math.sqrt(x0 / x)));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  hist.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = '#8a90a0';
  ctx.fillText(`当前 ${hist[hist.length - 1][1].toExponential(2)}`, 10, 14);
}

async function refreshNodes() {
  try {
    const { configured, observed } = await api('/api/nodes');
    els.nodes.innerHTML = configured.map((id) => {
      const n = observed.find((o) => o.nodeId === id);
      const on = n?.online;
      return `<div class="${on ? 'on' : 'off'}">${on ? '●' : '○'} ${id}` +
        (n ? ` <span style="color:#6a7080">hb=${n.heartbeats} ${n.lastSeenAgoMs}ms ago</span>` : ' <span style="color:#6a7080">未观测</span>') + '</div>';
    }).join('');
  } catch { els.nodes.textContent = '汇合服务不可达'; }
}

async function tick() {
  if (!currentJob) { await refreshNodes(); return; }
  try {
    const [snap, nodes] = await Promise.all([
      api(`/api/jobs/${currentJob}/snapshot`),
      api('/api/nodes').catch(() => null),
    ]);
    els.badge.textContent = { running: '运行中', complete: '完成', paused: '暂停' }[snap.state] || snap.state;
    els.badge.className = snap.state;
    const p = snap.progress;
    const pct = (100 * p.acceptedSamples) / p.totalSamples;
    els.fill.style.width = `${pct}%`;
    els.progressText.textContent = `覆盖率 ${pct.toFixed(1)}% · ${p.acceptedIntervals}/${p.totalIntervals} 区间`;
    els.stIntervals.textContent = `${p.acceptedIntervals} / ${p.totalIntervals}`;
    els.stSamples.textContent = `${p.acceptedSamples.toLocaleString()} / ${p.totalSamples.toLocaleString()}`;
    els.stPerPixel.textContent = `${snap.perPixel.min} / ${snap.perPixel.max}`;
    els.stMean.textContent = snap.imageMean.toExponential(4);
    els.stChannels.textContent = snap.channelMean.map((v) => v.toFixed(3)).join(' / ');
    els.stNoise.textContent = Number.isFinite(snap.noise) ? snap.noise.toExponential(3) : '—';
    els.stDup.textContent = p.duplicates;
    els.stRejected.textContent = p.rejected;
    els.stPublish.textContent = snap.publish ? (snap.publish.type === 'published' ? `已发布 → ${snap.publish.jobId}` : '门槛拒绝') : '未发布';
    els.publish.disabled = snap.state !== 'complete' || snap.publish?.type === 'published';
    els.start.disabled = snap.state === 'running';

    drawImage(snap);
    if (p.acceptedSamples !== lastAccepted) {
      lastAccepted = p.acceptedSamples;
      if (Number.isFinite(snap.noise)) noiseHist.push([p.acceptedSamples, snap.noise]);
      meanHist.push([p.acceptedSamples, snap.imageMean]);
      if (noiseHist.length > 200) noiseHist.shift();
      if (meanHist.length > 200) meanHist.shift();
      drawSeries(els.noise, nctx, noiseHist, '#7fb4ff', true);
      drawSeries(els.mean, mctx, meanHist, '#6fd08f', false);
    }
    if (nodes) {
      els.nodes.innerHTML = nodes.configured.map((id) => {
        const n = nodes.observed.find((o) => o.nodeId === id);
        const on = n?.online;
        return `<div class="${on ? 'on' : 'off'}">${on ? '●' : '○'} ${id}` +
          (n ? ` <span style="color:#6a7080">hb=${n.heartbeats} ${n.lastSeenAgoMs}ms ago</span>` : ' <span style="color:#6a7080">未观测</span>') + '</div>';
      }).join('');
    }
    if (snap.state === 'complete' && !els.badge.dataset.logged) {
      els.badge.dataset.logged = '1';
      logLine(`<b>汇合完成</b>：${p.totalIntervals} 区间全部接受，重复拒绝 ${p.duplicates}`, 'ok');
    }
  } catch (err) {
    els.badge.textContent = '离线';
    els.badge.className = 'offline';
    logLine(`<span class="warn">刷新失败</span> ${err.message}`);
  }
}

els.start.onclick = async () => {
  try {
    const jobId = els.jobId.value.trim() || `job-gui-${Date.now()}`;
    const budget = Number(els.budget.value);
    await api('/api/jobs', { method: 'POST', body: JSON.stringify({ jobId, budget, startedBy: 'gui-panel' }) });
    currentJob = jobId;
    noiseHist = []; meanHist = []; lastAccepted = -1;
    els.badge.dataset.logged = '';
    logLine(`<b>创建采样任务</b> ${jobId}，预算 ${budget}spp（工作节点认领后开始出图）`);
    await tick();
  } catch (err) { logLine(`<span class="warn">创建失败</span> ${err.message}`); }
};

els.publish.onclick = async () => {
  try {
    const out = await api(`/api/jobs/${currentJob}/publish`, { method: 'POST' });
    logLine(`<b>发布成功</b>，产物目录 <b>${out.outputDir}</b>，RMSE=${out.stats.compare.rmse.toExponential(2)}`, 'ok');
  } catch (err) {
    const d = err.body?.decision;
    logLine(`<span class="warn">发布被门槛拒绝</span>：${(d?.failures || [err.message]).join('；')}`);
  }
  await tick();
};

els.refresh.onclick = tick;
setInterval(tick, 1000);
refreshNodes().then(async () => {
  try {
    const hz = await api('/healthz');
    if (hz.jobs.length) { currentJob = hz.jobs[hz.jobs.length - 1]; els.jobId.value = currentJob; }
  } catch { /* 离线时由 tick 显示 */ }
  tick();
});
