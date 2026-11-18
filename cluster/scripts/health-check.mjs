#!/usr/bin/env node
// 集群健康检查：比对部署配置中的节点与汇合服务观测到的心跳，
// 检查 PID 存活性、汇合进度与发布状态。以退出码表达结果（0 健康，1 异常）。
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '../..');
const deploy = JSON.parse(readFileSync(join(ROOT, 'cluster/config/deployment.config.json'), 'utf8'));
const PID_DIR = join(ROOT, 'cluster/run/pids');
const baseUrl = process.env.RV_URL ?? `http://${deploy.rendezvous.host}:${deploy.rendezvous.port}`;
const jobFile = join(ROOT, 'cluster/run/current-job.json');

function pidAlive(name) {
  const f = join(PID_DIR, `${name}.pid`);
  if (!existsSync(f)) return { hasPidFile: false, alive: false };
  const pid = Number(readFileSync(f, 'utf8').trim());
  try { process.kill(pid, 0); return { hasPidFile: true, alive: true, pid }; } catch { return { hasPidFile: true, alive: false, pid }; }
}

const report = { checkedAt: new Date().toISOString(), rendezvous: null, nodes: [], job: null, healthy: true, problems: [] };
try {
  const hz = await (await fetch(`${baseUrl}/healthz`)).json();
  report.rendezvous = { reachable: true, ...hz };
} catch (err) {
  report.rendezvous = { reachable: false, error: String(err?.message ?? err) };
  report.healthy = false;
  report.problems.push('汇合服务不可达');
}

const observed = report.rendezvous?.reachable ? report.rendezvous.nodes : [];
for (const expected of deploy.nodes) {
  const local = pidAlive(expected.nodeId);
  const obs = observed.find((n) => n.nodeId === expected.nodeId);
  const entry = {
    nodeId: expected.nodeId, pid: local,
    online: obs?.online ?? false, lastSeenAgoMs: obs?.lastSeenAgoMs ?? null, heartbeats: obs?.heartbeats ?? 0,
  };
  if (!local.alive) { report.healthy = false; report.problems.push(`${expected.nodeId} 本地进程不存活`); }
  if (!entry.online) { report.healthy = false; report.problems.push(`${expected.nodeId} 心跳离线`); }
  report.nodes.push(entry);
}

if (existsSync(jobFile)) {
  const { jobId } = JSON.parse(readFileSync(jobFile, 'utf8'));
  try {
    const { progress, publish } = await (await fetch(`${baseUrl}/api/jobs/${jobId}/progress`)).json();
    report.job = { jobId, progress, publish };
    if (progress.state === 'running' && progress.pending > 0 && progress.acceptedIntervals === 0) {
      report.healthy = false; report.problems.push('任务运行中但尚无任何区间被接受');
    }
  } catch (err) {
    report.healthy = false;
    report.problems.push(`任务进度查询失败: ${String(err?.message ?? err)}`);
  }
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.healthy ? 0 : 1);
