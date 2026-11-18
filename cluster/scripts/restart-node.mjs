#!/usr/bin/env node
// 单节点重启脚本：停止指定工作节点（或全部），再按部署配置重新拉起，复用同一 JOB_ID。
// 用于验证：节点重启后从事件日志状态继续，已接受区间不会被重复计数。
// 用法: node cluster/scripts/restart-node.mjs node-2   |  --all
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, openSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '../..');
const deploy = JSON.parse(readFileSync(join(ROOT, 'cluster/config/deployment.config.json'), 'utf8'));
const PID_DIR = join(ROOT, 'cluster/run/pids');
const LOG_DIR = join(ROOT, 'cluster/run/logs');
const jobFile = join(ROOT, 'cluster/run/current-job.json');

const arg = process.argv[2];
const targets = arg === '--all'
  ? deploy.nodes.map((n) => n.nodeId)
  : deploy.nodes.filter((n) => n.nodeId === arg).map((n) => n.nodeId);
if (targets.length === 0) { console.error(`未知节点: ${arg}`); process.exit(2); }
if (!existsSync(jobFile)) { console.error('缺少 current-job.json，请先启动集群'); process.exit(2); }
const { jobId, baseUrl } = JSON.parse(readFileSync(jobFile, 'utf8'));

function stopNode(nodeId) {
  const f = join(PID_DIR, `${nodeId}.pid`);
  if (!existsSync(f)) return null;
  const pid = Number(readFileSync(f, 'utf8').trim());
  try { process.kill(pid, 'SIGTERM'); } catch { return null; }
  return new Promise((res) => {
    const iv = setInterval(() => {
      try { process.kill(pid, 0); } catch { clearInterval(iv); res(pid); }
    }, 60);
    setTimeout(() => { clearInterval(iv); try { process.kill(pid, 'SIGKILL'); } catch {} res(pid); }, 5000);
  });
}

function startNode(nodeId) {
  const out = openSync(join(LOG_DIR, `${nodeId}.log`), 'a');
  const child = spawn(process.execPath, [join(ROOT, deploy.workerRuntimePackage.entry)], {
    cwd: ROOT,
    env: {
      ...process.env,
      RV_URL: baseUrl, NODE_ID: nodeId, JOB_ID: jobId,
      PID_FILE: join(PID_DIR, `${nodeId}.pid`),
      POLL_MS: String(deploy.worker.pollIntervalMs),
      HEARTBEAT_MS: String(deploy.worker.heartbeatIntervalMs),
    },
    stdio: ['ignore', out, out], detached: true,
  });
  child.unref();
  writeFileSync(join(PID_DIR, `${nodeId}.pid`), String(child.pid));
  child.on('exit', (code) => console.log(JSON.stringify({ evt: 'worker-exited', nodeId, code })));
  return child.pid;
}

for (const nodeId of targets) {
  const oldPid = await stopNode(nodeId);
  await new Promise((r) => setTimeout(r, 300));
  const newPid = startNode(nodeId);
  console.log(JSON.stringify({ evt: 'node-restarted', nodeId, oldPid, newPid, jobId }));
}
