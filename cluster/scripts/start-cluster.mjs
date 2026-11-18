#!/usr/bin/env node
// 集群启动脚本：先拉起采样汇合服务并等待 /healthz，再按部署配置逐个拉起工作节点。
// 所有 PID 写入 cluster/run/pids，日志写入 cluster/run/logs，供停止与健康检查使用。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, openSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '../..');
const deploy = JSON.parse(readFileSync(join(ROOT, 'cluster/config/deployment.config.json'), 'utf8'));
const scene = JSON.parse(readFileSync(join(ROOT, 'cluster/config/scene.config.json'), 'utf8'));

const RUN = join(ROOT, 'cluster/run');
const PID_DIR = join(RUN, 'pids');
const LOG_DIR = join(RUN, 'logs');
mkdirSync(PID_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

const { host, port } = deploy.rendezvous;
const baseUrl = `http://${host}:${port}`;

function pidFile(name) { return join(PID_DIR, `${name}.pid`); }
function logFile(name) { return join(LOG_DIR, `${name}.log`); }
function readPid(name) {
  const f = pidFile(name);
  if (!existsSync(f)) return null;
  const pid = Number(readFileSync(f, 'utf8').trim());
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

async function waitHealthy(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return await res.json();
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('汇合服务健康检查超时');
}

const jobId = process.env.JOB_ID ?? `job-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
const budget = Number(process.env.BUDGET ?? scene.sequenceAllocation.defaultBudget);

if (readPid('rendezvous')) {
  console.error(JSON.stringify({ evt: 'start-abort', reason: '汇合服务已在运行' }));
  process.exit(1);
}

const rvOut = openSync(logFile('rendezvous'), 'a');
const rv = spawn(process.execPath, [join(ROOT, 'cluster/server/rendezvous.mjs')], {
  cwd: ROOT, env: { ...process.env, RV_HOST: host, RV_PORT: String(port) },
  stdio: ['ignore', rvOut, rvOut], detached: true,
});
rv.unref();
writeFileSync(pidFile('rendezvous'), String(rv.pid));
rv.on('exit', (code) => console.log(JSON.stringify({ evt: 'rendezvous-exited', code })));

await waitHealthy();
const create = await fetch(`${baseUrl}/api/jobs`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jobId, budget, startedBy: 'cluster-start' }),
});
if (!create.ok) { console.error(await create.text()); process.exit(1); }
const jobInfo = await create.json();
writeFileSync(join(RUN, 'current-job.json'), JSON.stringify({ jobId, baseUrl, budget, startedAt: new Date().toISOString() }, null, 2));

const fault = {
  CRASH_BEFORE_KEY: process.env.CRASH_BEFORE_KEY ?? '',
  DROP_EVERY: process.env.DROP_EVERY ?? '',
};
const children = [];
for (const node of deploy.nodes) {
  const env = {
    ...process.env,
    RV_URL: baseUrl, NODE_ID: node.nodeId, JOB_ID: jobId,
    PID_FILE: pidFile(node.nodeId),
    POLL_MS: String(deploy.worker.pollIntervalMs),
    HEARTBEAT_MS: String(deploy.worker.heartbeatIntervalMs),
  };
  if (fault.CRASH_BEFORE_KEY) env.CRASH_BEFORE_KEY = fault.CRASH_BEFORE_KEY;
  if (fault.DROP_EVERY) env.DROP_EVERY = fault.DROP_EVERY;
  const out = openSync(logFile(node.nodeId), 'a');
  const child = spawn(process.execPath, [join(ROOT, deploy.workerRuntimePackage.entry)], {
    cwd: ROOT, env, stdio: ['ignore', out, out], detached: true,
  });
  child.unref();
  writeFileSync(pidFile(node.nodeId), String(child.pid));
  child.on('exit', (code) => console.log(JSON.stringify({ evt: 'worker-exited', nodeId: node.nodeId, code })));
  children.push({ nodeId: node.nodeId, child });
}

console.log(JSON.stringify({
  evt: 'cluster-started', baseUrl, jobId, budget,
  workers: children.map((c) => ({ nodeId: c.nodeId, pid: c.child.pid })),
  gui: `${baseUrl}/gui/panel.html`,
}));
