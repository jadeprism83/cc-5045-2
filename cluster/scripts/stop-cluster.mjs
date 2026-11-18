#!/usr/bin/env node
// 集群停止脚本：按 PID 文件优雅停止全部工作节点，再停止汇合服务。
// PID 失效（节点已自行退出/崩溃）只记录不报错，保证重复执行幂等。
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '../..');
const deploy = JSON.parse(readFileSync(join(ROOT, 'cluster/config/deployment.config.json'), 'utf8'));
const PID_DIR = join(ROOT, 'cluster/run/pids');

function pidFile(name) { return join(PID_DIR, `${name}.pid`); }
function alivePid(name) {
  const f = pidFile(name);
  if (!existsSync(f)) return null;
  const pid = Number(readFileSync(f, 'utf8').trim());
  try { process.kill(pid, 0); return pid; } catch { return null; }
}
function stop(name, waitMs = 4000) {
  const pid = alivePid(name);
  if (!pid) { console.log(JSON.stringify({ evt: 'stop-skip', name, reason: '无存活 PID' })); rmSync(pidFile(name), { force: true }); return; }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + waitMs;
  const wait = () => new Promise((resolveWait) => {
    const iv = setInterval(() => {
      try { process.kill(pid, 0); } catch { clearInterval(iv); resolveWait(true); return; }
      if (Date.now() > deadline) { clearInterval(iv); resolveWait(false); }
    }, 80);
  });
  return wait().then((clean) => {
    if (!clean) {
      console.log(JSON.stringify({ evt: 'stop-force-kill', name, pid }));
      process.kill(pid, 'SIGKILL');
    }
    rmSync(pidFile(name), { force: true });
    console.log(JSON.stringify({ evt: 'stopped', name, pid, clean }));
  });
}

for (const node of deploy.nodes) await stop(node.nodeId);
await stop('rendezvous', 6000);
console.log(JSON.stringify({ evt: 'cluster-stopped' }));
