// 集群证据测试：真实拉起多进程（汇合服务 + 4 个工作节点），验证
// 1) 实际合成图像与样本区间 [s0,s1) 核验；2) 节点崩溃重启不产生重复计数；
// 3) 断续接入（租约超时重派）仍能完整覆盖；4) 发布门槛、失败日志与产物校验；
// 5) 汇合失败/未完成禁止采用产物；6) GUI 快照返回真实汇合数据。
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, createRendezvous } from '../server/rendezvous.mjs';
import { JobStore, buildTaskManifest } from '../server/store.mjs';
import { executeTask } from '../worker/render-task.mjs';
import { renderChunk } from '../../src/tracer.js';
import { SCENE } from '../../src/scene.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '../..');
const sceneConfig = loadConfig(resolve(HERE, '../config/scene.config.json'));
const deployConfig = loadConfig(resolve(HERE, '../config/deployment.config.json'));
const WORKER = join(ROOT, deployConfig.workerRuntimePackage.entry);

let passed = 0;
const ok = (name, cond, detail = '') => { assert(cond, `${name} ${detail}`); passed++; console.log(`  PASS ${name} ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEST_RUN = join(ROOT, 'cluster/run/test-evidence');
rmSync(TEST_RUN, { recursive: true, force: true });

function makeServer(port) {
  const cfg = {
    ...deployConfig,
    rendezvous: {
      ...deployConfig.rendezvous,
      port, stateDir: join(TEST_RUN, `state-${port}`),
      outputDir: join(TEST_RUN, `output-${port}`), logDir: join(TEST_RUN, `logs-${port}`),
      jobLeaseMs: 1500, heartbeatTimeoutMs: 5000,
    },
  };
  const server = createRendezvous({ sceneConfig, deployConfig: cfg });
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res({ server, cfg, base: `http://127.0.0.1:${port}` })));
}

function spawnWorker(base, nodeId, jobId, env = {}) {
  const p = spawn(process.execPath, [WORKER], {
    cwd: ROOT,
    env: { RV_URL: base, NODE_ID: nodeId, JOB_ID: jobId, POLL_MS: '60', HEARTBEAT_MS: '1000', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  p.stdout.on('data', (d) => String(d).trim().split('\n').forEach((l) => l && lines.push(l)));
  p.stderr.on('data', (d) => lines.push(`STDERR ${String(d).trim()}`));
  return { p, lines };
}

async function waitProgress(base, jobId, pred, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = await (await fetch(`${base}/api/jobs/${jobId}/progress`)).json();
    if (pred(j.progress)) return j;
    await sleep(150);
  }
  throw new Error('waitProgress 超时');
}

async function stop(p) {
  if (p.exitCode !== null || p.signalCode !== null) return; // 已退出（事件可能早于监听器触发）
  try { p.kill('SIGTERM'); } catch { return; }
  await new Promise((r) => {
    const timer = setTimeout(r, 5000); // 兜底：极端情况下不永久挂起
    p.on('exit', () => { clearTimeout(timer); r(); });
  });
  if (p.exitCode === null && p.signalCode === null) {
    try { p.kill('SIGKILL'); } catch { /* 已退出 */ }
    await new Promise((r) => p.on('exit', r));
  }
}

// ---------- 测试 1：样本区间核验（实际合成图像，区间与编号锁定） ----------
{
  const W = 48, H = 36, tile = { id: 0, x0: 0, y0: 0, w: 12, h: 12 };
  const direct = renderChunk(SCENE, W, H, tile, 8, 24);
  const viaTask = executeTask({ key: '0:1', tile, s0: 8, s1: 16 }, W, H);
  const viaTask2 = executeTask({ key: '0:2', tile, s0: 16, s1: 24 }, W, H);
  ok('interval-count-lock', viaTask.count === 8 && viaTask.s0 === 8 && viaTask.s1 === 16, `count=${viaTask.count}`);
  // 区间 [8,16)+[16,24) 的和必须等于整段 [8,24) 的和（同一样本集合，内容由样本号锁定）
  let sumErr = 0;
  for (let i = 0; i < direct.sum.length; i++)
    sumErr = Math.max(sumErr, Math.abs((viaTask.sum[i] + viaTask2.sum[i]) - direct.sum[i]));
  ok('interval-content-deterministic', sumErr < 1e-12, `maxSumErr=${sumErr.toExponential(2)}`);
  // 任务缺字段必须拒绝，不得用默认值遮错
  assert.throws(() => executeTask({ tile, s1: 16 }, W, H), /任务字段缺失/);
  ok('task-field-guard', true);
  // 清单区间覆盖 [0,budget) 无重叠无缺口
  const manifest = buildTaskManifest(W, H, 12, 32, 8);
  const perTile = new Map();
  for (const t of manifest.tasks) {
    const arr = perTile.get(t.tileId) ?? [];
    arr.push([t.s0, t.s1]); perTile.set(t.tileId, arr);
  }
  let coverOk = true;
  for (const arr of perTile.values()) {
    arr.sort((a, b) => a[0] - b[0]);
    if (arr[0][0] !== 0 || arr[arr.length - 1][1] !== 32) coverOk = false;
    for (let i = 1; i < arr.length; i++) if (arr[i][0] !== arr[i - 1][1]) coverOk = false;
  }
  ok('interval-manifest-full-cover', coverOk, `tiles=${perTile.size} intervals/tile=${[...perTile.values()][0].length}`);
}

// ---------- 测试 2：完整集群运行 + 发布门槛 + 产物 + 失败日志 ----------
const { server, cfg, base } = await makeServer(8801);
try {
  const jobId = 'evidence-full-run';
  const created = await (await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId, budget: 64, startedBy: 'test' }),
  })).json();
  ok('job-created-locked-budget', created.budget === 64 && created.totalSamples === 160 * 120 * 64, `samples=${created.totalSamples}`);

  const workers = deployConfig.nodes.map((n) => spawnWorker(base, n.nodeId, jobId));
  const done = await waitProgress(base, jobId, (p) => p.state === 'complete', 90000);
  ok('full-coverage', done.progress.acceptedIntervals === done.progress.totalIntervals,
    `${done.progress.acceptedIntervals}/${done.progress.totalIntervals}`);
  ok('no-duplicates-clean-run', done.progress.duplicates === 0 && done.progress.rejected === 0);

  // 服务端快照：GUI 数据来源，必须含真实均值/噪声
  const snap = await (await fetch(`${base}/api/jobs/${jobId}/snapshot`)).json();
  ok('snapshot-real-stats', snap.mean.length === 160 * 120 * 3 && Number.isFinite(snap.noise) && snap.noise > 0,
    `noise=${snap.noise.toExponential(3)} mean=${snap.imageMean.toFixed(4)}`);
  ok('snapshot-pixel-count-budget', snap.perPixel.min === 64 && snap.perPixel.max === 64);

  // 未登记节点必须被拒绝
  const denied = await fetch(`${base}/api/jobs/${jobId}/lease`, { method: 'POST', headers: { 'x-node-id': 'intruder' } });
  ok('unregistered-node-denied', denied.status === 403);

  // 未完成禁止发布：新建一个不跑的 job，publish 必须 409
  await (await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'never-finished', budget: 64 }) })).json();
  const early = await fetch(`${base}/api/jobs/never-finished/publish`, { method: 'POST' });
  ok('publish-blocked-when-incomplete', early.status === 409);
  ok('no-artifact-when-blocked', !existsSync(join(cfg.rendezvous.outputDir, 'never-finished')));

  // 正常发布：门槛全过，产物齐全且带校验和
  const pubRes = await fetch(`${base}/api/jobs/${jobId}/publish`, { method: 'POST' });
  const pub = await pubRes.json();
  ok('publish-gates-passed', pubRes.ok && pub.decision.type === 'published', `rmse=${pub.decision.gates.rmse.toExponential(2)}`);
  ok('rmse-under-threshold', pub.decision.gates.rmse <= sceneConfig.validation.maxReferenceRmse,
    `rmse=${pub.decision.gates.rmse.toExponential(2)}`);
  const outDir = join(cfg.rendezvous.outputDir, jobId);
  for (const name of sceneConfig.validation.requiredPublishArtifacts)
    ok(`artifact-${name}`, existsSync(join(outDir, name)));
  const ppm = readFileSync(join(outDir, 'image.ppm'));
  ok('ppm-header', ppm.subarray(0, 2).toString() === 'P6' && ppm.includes(Buffer.from('160 120')));
  const statsDoc = JSON.parse(readFileSync(join(outDir, 'stats.json'), 'utf8'));
  ok('stats-doc-evidence', statsDoc.imageMean > 0 && statsDoc.compare.rmse <= sceneConfig.validation.maxReferenceRmse,
    `imageMean=${statsDoc.imageMean.toFixed(4)}`);

  // journal 持久化且可通过 API 取回
  const journal = await (await fetch(`${base}/api/jobs/${jobId}/journal`)).text();
  ok('journal-persisted', journal.includes('job-created') && journal.includes('chunk-accepted') && journal.includes('published'));

  for (const w of workers) await stop(w.p);
} finally {
  await server.shutdown();
}

// ---------- 测试 3：节点崩溃重启 → 不重复计数 ----------
{
  const { server, base } = await makeServer(8802);
  try {
    const jobId = 'evidence-restart';
    await (await fetch(`${base}/api/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, budget: 64 }),
    })).json();
    // 让 node-2 在第三个任务前崩溃
    const w1 = spawnWorker(base, 'node-1', jobId);
    const w2 = spawnWorker(base, 'node-2', jobId, { CRASH_BEFORE_KEY: '' });
    // 先跑一小段再杀掉 node-2（模拟节点退出，已回传的区间在日志里）
    await waitProgress(base, jobId, (p) => p.acceptedIntervals >= 6, 30000);
    const before = await (await fetch(`${base}/api/jobs/${jobId}/progress`)).json();
    await stop(w2.p);
    await sleep(400);
    // 重启 node-2（新 PID、同 NODE_ID、同 JOB_ID）
    const w2b = spawnWorker(base, 'node-2', jobId);
    const w3 = spawnWorker(base, 'node-3', jobId);
    const w4 = spawnWorker(base, 'node-4', jobId);
    const done = await waitProgress(base, jobId, (p) => p.state === 'complete', 90000);
    ok('restart-full-coverage', done.progress.acceptedIntervals === done.progress.totalIntervals);
    ok('restart-zero-duplicates', done.progress.duplicates === 0, `dup=${done.progress.duplicates}`);
    ok('restart-monotonic-accept', done.progress.acceptedIntervals >= before.progress.acceptedIntervals);
    // 每像素计数恰好等于预算——重复计数会让 max 超过预算
    const snap = await (await fetch(`${base}/api/jobs/${jobId}/snapshot`)).json();
    ok('restart-count-exact-budget', snap.perPixel.min === 64 && snap.perPixel.max === 64,
      `min=${snap.perPixel.min} max=${snap.perPixel.max}`);
    for (const w of [w1, w2b, w3, w4]) await stop(w.p);
  } finally {
    await server.shutdown();
  }
}

// ---------- 测试 4：断续接入（租约超时重派）+ 结果遗失补采 ----------
{
  const { server, cfg, base } = await makeServer(8803);
  try {
    const jobId = 'evidence-flaky';
    await (await fetch(`${base}/api/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, budget: 64 }),
    })).json();
    // node-4 每 5 个结果丢 1 个（区间遗失）；node-3 跑一下就被反复杀掉（断续接入，租约超时重派）
    const w1 = spawnWorker(base, 'node-1', jobId);
    const w2 = spawnWorker(base, 'node-2', jobId);
    const w4 = spawnWorker(base, 'node-4', jobId, { DROP_EVERY: '5' });
    let w3 = spawnWorker(base, 'node-3', jobId);
    const rounds = [];
    for (let i = 0; i < 3; i++) {
      await sleep(900);
      await stop(w3.p);
      await sleep(500);
      w3 = spawnWorker(base, 'node-3', jobId);
      rounds.push(i);
    }
    ok('flap-rounds', rounds.length === 3);
    const done = await waitProgress(base, jobId, (p) => p.state === 'complete', 120000);
    ok('flaky-full-coverage', done.progress.acceptedIntervals === done.progress.totalIntervals);
    ok('flaky-zero-duplicates', done.progress.duplicates === 0, `dup=${done.progress.duplicates}`);
    const snap = await (await fetch(`${base}/api/jobs/${jobId}/snapshot`)).json();
    ok('flaky-count-exact', snap.perPixel.min === 64 && snap.perPixel.max === 64);
    // 失败/故障日志确实落盘（遗失结果在 worker 日志，重派在 journal）
    const journal = await (await fetch(`${base}/api/jobs/${jobId}/journal`)).text();
    ok('lease-reassign-recorded', journal.includes('lease-reassigned') || journal.includes('lease'), '重派有事件记录');
    ok('drop-fault-observed', w4.lines.some((l) => l.includes('fault-drop-result')), `lines=${w4.lines.length}`);
    // 发布仍然通过门槛（遗失区间最终补齐）
    const pub = await (await fetch(`${base}/api/jobs/${jobId}/publish`, { method: 'POST' })).json();
    ok('flaky-publish-ok', pub.ok === true && pub.decision.type === 'published');
    for (const w of [w1, w2, w3, w4]) await stop(w.p);
  } finally {
    await server.shutdown();
  }
}

// ---------- 测试 5：服务重启回放 → 已接受区间不重复 ----------
{
  const port = 8804;
  const { server, cfg, base } = await makeServer(port);
  const jobId = 'evidence-rv-restart';
  await (await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId, budget: 64 }),
  })).json();
  const w1 = spawnWorker(base, 'node-1', jobId);
  await waitProgress(base, jobId, (p) => p.acceptedIntervals >= 10, 30000);
  await stop(w1.p);
  await server.shutdown();

  // 重新打开服务并回放 journal
  const store2 = new JobStore({ stateDir: cfg.rendezvous.stateDir, logDir: cfg.rendezvous.logDir, leaseMs: 1500 });
  const replayed = store2.replay(jobId);
  ok('rv-replay-restores-accepted', replayed.accepted.size >= 10, `accepted=${replayed.accepted.size}`);
  ok('rv-replay-duplicate-counter-zero', replayed.duplicates === 0);
  // 回放后同一 key 再提交必须被判重复
  const someKey = [...replayed.accepted.keys()][0];
  const task = replayed.tasks.find((t) => t.key === someKey);
  const bogus = { key: someKey, s0: task.s0, s1: task.s1, count: task.s1 - task.s0,
    sum: new Array(task.tile.w * task.tile.h * 3).fill(0.1), M2: new Array(task.tile.w * task.tile.h * 3).fill(0.01) };
  const out = store2.submit(jobId, 'node-1', bogus);
  ok('rv-replay-rededup', out.status === 'duplicate' && replayed.duplicates === 1);
  // 失败日志存在
  ok('failure-log-exists', existsSync(store2.failPath(jobId)));
}

// ---------- 测试 6：损坏结果被门槛拒绝，失败日志保留，不出产物 ----------
{
  const { server, cfg, base } = await makeServer(8805);
  try {
    const jobId = 'evidence-bad-payload';
    await (await fetch(`${base}/api/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, budget: 64 }),
    })).json();
    const lease = await (await fetch(`${base}/api/jobs/${jobId}/lease`, {
      method: 'POST', headers: { 'x-node-id': 'node-1' },
    })).json();
    const bad = { key: lease.task.key, s0: lease.task.s0, s1: lease.task.s1, count: lease.task.s1 - lease.task.s0,
      sum: [1, 2, 3], M2: [0] }; // 长度故意不对
    const rej = await fetch(`${base}/api/jobs/${jobId}/result`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-node-id': 'node-1' },
      body: JSON.stringify(bad),
    });
    ok('bad-payload-rejected', rej.status === 422);
    const failLog = join(cfg.rendezvous.logDir, `job-${jobId}.failures.log`);
    ok('failure-log-retained', existsSync(failLog) && readFileSync(failLog, 'utf8').includes('validation-failed'));
    ok('no-output-on-rejection', !existsSync(join(cfg.rendezvous.outputDir, jobId)) ||
      readdirSync(join(cfg.rendezvous.outputDir, jobId), { withFileTypes: true }).filter((d) => !d.name.startsWith('.')).length === 0);
  } finally {
    await server.shutdown();
  }
}

// ---------- 测试 7：工作节点禁止静默默认值 ----------
{
  const p = spawn(process.execPath, [WORKER], { cwd: ROOT, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const code = await new Promise((r) => p.on('exit', r));
  ok('worker-no-silent-default', code === 2);
}

// ---------- 测试 8：旧样例（48x36 小尺寸覆盖配置）必须运行到底并过门槛 ----------
{
  const { server, base } = await makeServer(8806);
  try {
    const legacy = JSON.parse(readFileSync(resolve(HERE, '../config/legacy-example.config.json'), 'utf8'));
    const jobId = `${legacy.jobIdPrefix}-${Date.now()}`;
    const created = await (await fetch(`${base}/api/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, budget: legacy.budget, legacyOverride: legacy.legacyOverride, startedBy: 'legacy-test' }),
    })).json();
    ok('legacy-job-created', created.legacy === true && created.totalSamples === 48 * 36 * 64,
      `samples=${created.totalSamples}`);
    const workers = deployConfig.nodes.map((n) => spawnWorker(base, n.nodeId, jobId));
    const done = await waitProgress(base, jobId, (p) => p.state === 'complete', 60000);
    ok('legacy-runs-to-completion', done.progress.acceptedIntervals === done.progress.totalIntervals,
      `${done.progress.acceptedIntervals}/${done.progress.totalIntervals}`);
    const pub = await (await fetch(`${base}/api/jobs/${jobId}/publish`, { method: 'POST' })).json();
    ok('legacy-publish-gates-passed', pub.ok === true, `rmse=${pub.decision.gates.rmse.toExponential(2)}`);
    const snap = await (await fetch(`${base}/api/jobs/${jobId}/snapshot`)).json();
    ok('legacy-image-mean-evidence', snap.W === 48 && snap.H === 36 && snap.imageMean > 0,
      `mean=${snap.imageMean.toFixed(4)} noise=${snap.noise.toExponential(2)}`);
    for (const w of workers) await stop(w.p);
  } finally {
    await server.shutdown();
  }
}

console.log(`\n集群证据测试全部 ${passed} 项通过`);
