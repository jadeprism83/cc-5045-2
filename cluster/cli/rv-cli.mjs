#!/usr/bin/env node
// 采样汇合辅助命令行（图形入口才是主界面，见 cluster/gui/panel.html 与 docs/operations.md）。
// 子命令: create | progress | nodes | publish | journal
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '../..');
const deploy = JSON.parse(readFileSync(join(ROOT, 'cluster/config/deployment.config.json'), 'utf8'));
const scene = JSON.parse(readFileSync(join(ROOT, 'cluster/config/scene.config.json'), 'utf8'));
const baseUrl = process.env.RV_URL ?? `http://${deploy.rendezvous.host}:${deploy.rendezvous.port}`;

const [cmd, ...args] = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.findIndex((a) => a === `--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
};

async function main() {
  if (cmd === 'create') {
    const budget = Number(flag('budget', scene.sequenceAllocation.defaultBudget));
    const jobId = flag('job-id', `job-cli-${Date.now()}`);
    const res = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, budget, startedBy: 'cli' }),
    });
    console.log(JSON.stringify(await res.json(), null, 2));
    if (!res.ok) process.exit(1);
    return;
  }
  if (cmd === 'progress') {
    const jobId = args[0];
    if (!jobId) throw new Error('用法: progress <jobId>');
    const res = await fetch(`${baseUrl}/api/jobs/${jobId}/progress`);
    console.log(JSON.stringify(await res.json(), null, 2));
    if (!res.ok) process.exit(1);
    return;
  }
  if (cmd === 'nodes') {
    const res = await fetch(`${baseUrl}/api/nodes`);
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }
  if (cmd === 'publish') {
    const jobId = args[0];
    if (!jobId) throw new Error('用法: publish <jobId>');
    const res = await fetch(`${baseUrl}/api/jobs/${jobId}/publish`, { method: 'POST' });
    console.log(JSON.stringify(await res.json(), null, 2));
    if (!res.ok) process.exit(1);
    return;
  }
  if (cmd === 'journal') {
    const jobId = args[0];
    if (!jobId) throw new Error('用法: journal <jobId>');
    const res = await fetch(`${baseUrl}/api/jobs/${jobId}/journal`);
    process.stdout.write(await res.text());
    return;
  }
  console.error(`未知子命令: ${cmd}\n可用: create | progress | nodes | publish | journal\n图形入口: ${baseUrl}/gui/panel.html`);
  process.exit(2);
}
main().catch((err) => { console.error(String(err?.message ?? err)); process.exit(1); });
