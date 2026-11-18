// 服务端最终汇合：回放全部已接受区间，复用浏览器端同一套加权 Welford 合并内核，
// 再执行发布门槛校验。门槛不过只写失败日志，绝不出产物。
import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync, renameSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Merger } from '../../src/merger.js';
import { renderChunk } from '../../src/tracer.js';
import { SCENE } from '../../src/scene.js';

export function aggregateJob(job) {
  const merger = new Merger(job.W, job.H);
  const ordered = [...job.results.values()].sort((a, b) => a.task.tileId - b.task.tileId || a.task.intervalId - b.task.intervalId);
  for (const r of ordered) merger.addChunk(r.task.key, r.task.tile, r.count, Float64Array.from(r.sum), Float64Array.from(r.M2));
  return merger;
}

export function runReference(job) {
  // 单进程参考：同一场景、同一计数器随机数、完整区间 [0,budget)
  const ref = new Merger(job.W, job.H);
  for (const t of job.tiles) {
    const tile = { x0: t.x0, y0: t.y0, w: t.w, h: t.h };
    const r = renderChunk(SCENE, job.W, job.H, tile, 0, job.budget);
    ref.addChunk(`ref:${t.id}`, tile, r.count, r.sum, r.M2);
  }
  return ref;
}

export function imageStats(merger) {
  const W = merger.W, H = merger.H;
  const perPixel = merger.perPixel();
  let sumMean = [0, 0, 0], sumSq = [0, 0, 0], npx = 0;
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) {
      const v = merger.mean[i * 3 + c];
      sumMean[c] += v; sumSq[c] += v * v;
    }
    npx++;
  }
  const channelMean = sumMean.map((s) => s / npx);
  const channelStd = sumSq.map((s, c) => Math.sqrt(Math.max(0, s / npx - channelMean[c] ** 2)));
  return { perPixel, channelMean, channelStd, imageMean: channelMean.reduce((a, b) => a + b, 0) / 3, noise: merger.noise() };
}

function tonemapByte(c, exposure = 1.1) {
  const y = 1 - Math.exp(-c * exposure);
  return Math.round(255 * Math.pow(Math.min(Math.max(y, 0), 1), 1 / 2.2));
}

export function writePPM(path, merger, exposure = 1.1) {
  const W = merger.W, H = merger.H;
  const header = Buffer.from(`P6\n${W} ${H}\n255\n`);
  const body = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    body[i * 3] = tonemapByte(merger.mean[i * 3], exposure);
    body[i * 3 + 1] = tonemapByte(merger.mean[i * 3 + 1], exposure);
    body[i * 3 + 2] = tonemapByte(merger.mean[i * 3 + 2], exposure);
  }
  writeFileSync(path, Buffer.concat([header, body]));
}

// 发布门槛：覆盖、去重、参考 RMSE、统计完整性，任一不过即拒绝发布
export function publishJob({ job, merger, config, outputDir, logDir }) {
  mkdirSync(outputDir, { recursive: true });
  const gate = config.validation;
  const failures = [];
  const stats = imageStats(merger);
  const perPixel = stats.perPixel;

  if (job.accepted.size !== job.tasks.length)
    failures.push(`区间覆盖不足: ${job.accepted.size}/${job.tasks.length}`);
  if (gate.perPixelCountMustEqualBudget && (perPixel.min !== job.budget || perPixel.max !== job.budget))
    failures.push(`每像素计数不等于预算: min=${perPixel.min} max=${perPixel.max} budget=${job.budget}`);
  if (merger.duplicates > 0 || job.duplicates > 0)
    failures.push(`存在重复计数: merger=${merger.duplicates} job=${job.duplicates}`);
  if (!Number.isFinite(stats.noise) || stats.noise <= 0)
    failures.push(`噪声估计非法: ${stats.noise}`);

  const ref = runReference(job);
  const cmp = merger.compare(ref.mean);
  if (!(cmp.rmse <= gate.maxReferenceRmse))
    failures.push(`参考 RMSE 超门槛: ${cmp.rmse.toExponential(3)} > ${gate.maxReferenceRmse}`);
  const refStats = imageStats(ref);
  const meanDelta = Math.abs(stats.imageMean - refStats.imageMean);
  if (!(meanDelta <= gate.imageMeanChannelTolerance))
    failures.push(`图像均值偏差超门槛: ${meanDelta} > ${gate.imageMeanChannelTolerance}`);

  const decision = {
    type: failures.length ? 'publish-rejected' : 'published',
    jobId: job.jobId, at: new Date().toISOString(),
    gates: {
      intervals: `${job.accepted.size}/${job.tasks.length}`,
      perPixelMinMax: [perPixel.min, perPixel.max],
      budget: job.budget,
      duplicates: job.duplicates,
      rmse: cmp.rmse, maxReferenceRmse: gate.maxReferenceRmse,
      imageMean: stats.imageMean, referenceImageMean: refStats.imageMean, meanDelta,
      noise: stats.noise,
    },
    failures,
  };

  const failLog = join(logDir, `job-${job.jobId}.failures.log`);
  if (failures.length) {
    appendFileSync(failLog, JSON.stringify(decision) + '\n');
    return { ok: false, decision, stats: { ...stats, reference: refStats, compare: cmp } };
  }

  const finalDir = join(outputDir, job.jobId);
  const staging = join(outputDir, `.staging-${job.jobId}`);
  mkdirSync(staging, { recursive: true });
  writePPM(join(staging, 'image.ppm'), merger);
  const statsDoc = {
    jobId: job.jobId, sceneId: job.sceneId, policy: job.policy,
    W: job.W, H: job.H, budget: job.budget, chunkSize: job.chunkSize,
    acceptedIntervals: job.accepted.size, totalIntervals: job.tasks.length,
    acceptedSamples: job.accepted.size * 0,
    ...stats, reference: refStats, compare: cmp,
    publishedAt: new Date().toISOString(),
  };
  statsDoc.acceptedSamples = job.totalSamples;
  writeFileSync(join(staging, 'stats.json'), JSON.stringify(statsDoc, null, 2));
  const journalSrc = join(config._stateDir, `job-${job.jobId}.journal.jsonl`);
  const journalDst = join(staging, 'journal.jsonl');
  writeFileSync(journalDst, existsSync(journalSrc) ? readFileSync(journalSrc) : '');

  const checks = [];
  for (const name of gate.requiredPublishArtifacts.filter((n) => n !== 'checksums.sha256')) {
    const p = join(staging, name);
    if (!existsSync(p)) failures.push(`缺少产物: ${name}`);
    else checks.push(`${createHash('sha256').update(readFileSync(p)).digest('hex')}  ${name}`);
  }
  if (failures.length) {
    appendFileSync(failLog, JSON.stringify({ ...decision, failures }) + '\n');
    return { ok: false, decision: { ...decision, failures }, stats: { ...stats, reference: refStats, compare: cmp } };
  }
  writeFileSync(join(staging, 'checksums.sha256'), checks.join('\n') + '\n');
  renameSync(staging, finalDir);
  return { ok: true, decision, outputDir: finalDir, stats: statsDoc };
}
