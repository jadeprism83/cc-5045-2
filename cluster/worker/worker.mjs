// 采样工作节点常驻进程：向汇合服务登记、周期心跳、认领租约、执行渲染、回传结果。
// 环境变量缺失直接退出，绝不使用默认地址/自动编号掩盖配置错误。
// 支持故障注入：CRASH_BEFORE_KEY 执行到指定 key 前退出（模拟节点崩溃，由重启脚本拉起），
// DROP_EVERY 丢弃每第 N 个结果（模拟区间遗失，等待补采）。
import { hostname } from 'node:os';
import { rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeTask } from './render-task.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PID_FILE = process.env.PID_FILE ?? resolve(HERE, '../run/pids', `${process.env.NODE_ID ?? 'unknown'}.pid`);
function removePidFile() { try { rmSync(PID_FILE, { force: true }); } catch { /* 无 PID 文件（如测试直起） */ } }

const VERSION = 'worker-package-v1';

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(JSON.stringify({ evt: 'worker-config-error', reason: `缺少必需环境变量 ${name}，禁止使用默认值`, name }));
    process.exit(2);
  }
  return v;
}

const RV_URL = requiredEnv('RV_URL').replace(/\/$/, '');
const NODE_ID = requiredEnv('NODE_ID');
const JOB_ID = process.env.JOB_ID ?? null;
const POLL_MS = Number(process.env.POLL_MS ?? 120);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 3000);
const CRASH_BEFORE_KEY = process.env.CRASH_BEFORE_KEY ?? null;
const DROP_EVERY = Number(process.env.DROP_EVERY ?? 0);
// 连续空转（无任务可认领）超过该次数才退出。默认 0 = 永不空转退出，节点常驻待命，
// 由 stop-cluster / restart-node 显式管理生命周期；测试可用小值加速回收。
const MAX_IDLE_POLLS = Number(process.env.MAX_IDLE_POLLS ?? 0);

const log = (evt, extra = {}) => console.log(JSON.stringify({ evt, nodeId: NODE_ID, pid: process.pid, at: new Date().toISOString(), ...extra }));

async function api(path, options = {}) {
  const res = await fetch(`${RV_URL}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-node-id': NODE_ID, ...(options.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

let produced = 0;
let idlePolls = 0;
let stopping = false;

async function heartbeatLoop() {
  while (!stopping) {
    try {
      await api('/api/nodes/heartbeat', { method: 'POST', body: JSON.stringify({ pid: process.pid, hostname: hostname(), version: VERSION }) });
    } catch (err) {
      log('heartbeat-failed', { error: String(err?.message ?? err) });
    }
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS));
  }
}

function maybeInjectCrash(task) {
  if (CRASH_BEFORE_KEY && task.key === CRASH_BEFORE_KEY) {
    log('fault-crash', { key: task.key });
    process.exit(91);
  }
}

function maybeDropResult(task) {
  if (DROP_EVERY > 0) {
    produced++;
    if (produced % DROP_EVERY === 0) {
      log('fault-drop-result', { key: task.key, seq: produced });
      return true;
    }
  }
  return false;
}

async function submitWithRetry(jobId, payload, attempt = 0) {
  try {
    const { status, body } = await api(`/api/jobs/${jobId}/result`, { method: 'POST', body: JSON.stringify(payload) });
    if (status === 200) return body;
    if (status === 422 && body.reason === 'validation-failed') {
      log('result-rejected', { key: payload.key, errors: body.errors });
      return body;
    }
    if (status === 422 || status === 403) return body;
    throw new Error(`HTTP ${status}`);
  } catch (err) {
    if (attempt >= 8) throw err;
    const backoff = 250 * 2 ** attempt;
    log('result-retry', { key: payload.key, attempt, backoffMs: backoff, error: String(err?.message ?? err) });
    await new Promise((r) => setTimeout(r, backoff));
    return submitWithRetry(jobId, payload, attempt + 1);
  }
}

async function workLoop() {
  if (!JOB_ID) { log('no-job-env', { reason: '未设置 JOB_ID，节点仅维持心跳后退出' }); return; }
  while (!stopping) {
    let leased;
    try {
      leased = await api(`/api/jobs/${JOB_ID}/lease`, { method: 'POST', body: '{}' });
    } catch (err) {
      log('lease-failed', { error: String(err?.message ?? err) });
      await new Promise((r) => setTimeout(r, POLL_MS * 4));
      continue;
    }
    if (leased.status !== 200) { log('lease-denied', { status: leased.status, body: leased.body }); await new Promise((r) => setTimeout(r, POLL_MS * 4)); continue; }
    const { task, W, H, state } = leased.body;
    if (!task) {
      idlePolls++;
      if (state && state !== 'running') log('job-drained', { state });
      // 默认常驻待命（MAX_IDLE_POLLS=0）：任务完成后节点保持在线，由停止/重启脚本管理生命周期；
      // 仅当显式设置 MAX_IDLE_POLLS 时才在连续空转后退出（测试加速回收用）
      if (MAX_IDLE_POLLS && idlePolls >= MAX_IDLE_POLLS) { log('idle-exit', { idlePolls, state: state ?? 'running' }); break; }
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    idlePolls = 0;
    maybeInjectCrash(task);
    let payload;
    try {
      payload = executeTask(task, W, H);
    } catch (err) {
      log('execute-failed', { key: task.key, error: String(err?.message ?? err) });
      await new Promise((r) => setTimeout(r, POLL_MS * 2));
      continue;
    }
    if (maybeDropResult(task)) { await new Promise((r) => setTimeout(r, POLL_MS)); continue; }
    const out = await submitWithRetry(JOB_ID, payload);
    log(out.status === 'duplicate' ? 'duplicate-rejected' : 'result-accepted', { key: task.key, status: out.status });
  }
}

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  log('worker-signal', { sig });
  removePidFile();
  // 直接退出：轮询循环可能正 await fetch/sleep，不依赖其协作式停止
  process.exit(0);
});
process.on('exit', removePidFile);

log('worker-start', { rvUrl: RV_URL, jobId: JOB_ID, fault: { crashBeforeKey: CRASH_BEFORE_KEY, dropEvery: DROP_EVERY } });
const hb = heartbeatLoop();
await workLoop();
stopping = true;
removePidFile();
log('worker-exit', { produced });
process.exit(0);
