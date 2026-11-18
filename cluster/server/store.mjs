// 采样汇合状态存储：append-only 事件日志 + 内存物化。
// 服务重启时回放 journal，已接受区间不重算、租约重建，节点重启不会造成重复计数。
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, appendFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function taskKey(tileId, intervalId) { return `${tileId}:${intervalId}`; }

export function buildTaskManifest(W, H, tileSize, budget, chunkSize) {
  const tiles = [];
  let tileId = 0;
  for (let y0 = 0; y0 < H; y0 += tileSize)
    for (let x0 = 0; x0 < W; x0 += tileSize)
      tiles.push({ id: tileId++, x0, y0, w: Math.min(tileSize, W - x0), h: Math.min(tileSize, H - y0) });
  const intervals = [];
  let intervalId = 0;
  for (let s0 = 0; s0 < budget; s0 += chunkSize)
    intervals.push({ id: intervalId++, s0, s1: Math.min(s0 + chunkSize, budget) });
  const tasks = [];
  for (const iv of intervals)
    for (const t of tiles)
      tasks.push({
        key: taskKey(t.id, iv.id), tileId: t.id, intervalId: iv.id,
        s0: iv.s0, s1: iv.s1, tile: { id: t.id, x0: t.x0, y0: t.y0, w: t.w, h: t.h },
      });
  return { tiles, intervals, tasks, totalSamples: W * H * budget };
}

export class JobStore {
  constructor({ stateDir, logDir, leaseMs = 30000 }) {
    this.stateDir = stateDir;
    this.logDir = logDir;
    this.leaseMs = leaseMs;
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    this.jobs = new Map();
    this.nodes = new Map();
  }

  jobPath(jobId) { return join(this.stateDir, `job-${jobId}.journal.jsonl`); }
  failPath(jobId) { return join(this.logDir, `job-${jobId}.failures.log`); }

  recordFailure(jobId, entry) {
    appendFileSync(this.failPath(jobId), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  }

  createJob({ jobId, budget, chunkSize, W, H, tileSize, sceneId, policy, startedBy }) {
    const manifest = buildTaskManifest(W, H, tileSize, budget, chunkSize);
    const job = {
      jobId, sceneId, policy, budget, chunkSize, W, H, tileSize,
      startedBy,
      state: 'running',
      createdAt: new Date().toISOString(),
      tasks: manifest.tasks,
      tiles: manifest.tiles,
      totalSamples: manifest.totalSamples,
      accepted: new Map(),
      duplicates: 0,
      rejected: 0,
      leaseByKey: new Map(),
      results: new Map(),
      finishedAt: null,
      publish: null,
    };
    this.jobs.set(jobId, job);
    const file = this.jobPath(jobId);
    writeFileSync(file, '');
    this._append(job, { type: 'job-created', budget, chunkSize, W, H, tileSize, sceneId, policy, startedBy, totalSamples: job.totalSamples, taskCount: job.tasks.length });
    return job;
  }

  _append(job, event) {
    event.ts = Date.now();
    appendFileSync(this.jobPath(job.jobId), JSON.stringify(event) + '\n');
  }

  // 重放日志恢复：接受过的区间重建，未完成的旧租约全部失效可重新认领
  replay(jobId) {
    const file = this.jobPath(jobId);
    if (!existsSync(file)) return null;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    const head = JSON.parse(lines[0]);
    const manifest = buildTaskManifest(head.W, head.H, head.tileSize, head.budget, head.chunkSize);
    const job = {
      jobId, sceneId: head.sceneId, policy: head.policy,
      budget: head.budget, chunkSize: head.chunkSize, W: head.W, H: head.H, tileSize: head.tileSize,
      startedBy: head.startedBy,
      state: 'running', createdAt: new Date(head.ts).toISOString(),
      tasks: manifest.tasks, tiles: manifest.tiles, totalSamples: head.totalSamples,
      accepted: new Map(), duplicates: 0, rejected: 0,
      leaseByKey: new Map(), results: new Map(),
      finishedAt: null, publish: null,
    };
    for (const line of lines.slice(1)) {
      const e = JSON.parse(line);
      if (e.type === 'chunk-accepted') {
        job.accepted.set(e.key, { key: e.key, nodeId: e.nodeId, n: e.n, checksum: e.checksum, at: e.ts });
      } else if (e.type === 'duplicate-rejected') {
        job.duplicates++;
      } else if (e.type === 'result-rejected') {
        job.rejected++;
      } else if (e.type === 'job-finished') {
        job.state = e.state; job.finishedAt = new Date(e.ts).toISOString();
      } else if (e.type === 'published' || e.type === 'publish-rejected') {
        job.publish = e;
      }
    }
    this.jobs.set(jobId, job);
    return job;
  }

  listJobs() { return [...this.jobs.values()]; }
  getJob(jobId) { return this.jobs.get(jobId) ?? null; }

  heartbeat(nodeId, meta = {}) {
    const now = Date.now();
    const node = this.nodes.get(nodeId) ?? {
      nodeId, firstSeen: now, heartbeats: 0, jobsRun: new Set(), lastJobId: null,
    };
    node.lastSeen = now;
    node.heartbeats++;
    node.pid = meta.pid ?? node.pid;
    node.hostname = meta.hostname ?? node.hostname;
    node.version = meta.version ?? node.version;
    this.nodes.set(nodeId, node);
    return node;
  }

  health(now = Date.now(), timeoutMs = 15000) {
    const out = [];
    for (const node of this.nodes.values()) {
      out.push({
        nodeId: node.nodeId, online: now - node.lastSeen <= timeoutMs,
        lastSeenAgoMs: now - node.lastSeen, heartbeats: node.heartbeats,
        pid: node.pid, hostname: node.hostname, version: node.version,
      });
    }
    return out;
  }

  // 认领任务：跳过已接受；过期租约可被其他节点（或重启后的同一节点）重新认领
  lease(jobId, nodeId, now = Date.now()) {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== 'running') return null;
    let reassigned = null;
    for (const t of job.tasks) {
      if (job.accepted.has(t.key)) continue;
      const lease = job.leaseByKey.get(t.key);
      if (!lease) {
        const granted = { key: t.key, nodeId, at: now, attempts: 1 };
        job.leaseByKey.set(t.key, granted);
        this._append(job, { type: 'lease', key: t.key, nodeId });
        return { task: t, lease: granted, reassigned: false };
      }
      if (now - lease.at > this.leaseMs && !reassigned) reassigned = { t, lease };
    }
    if (reassigned) {
      const granted = { key: reassigned.t.key, nodeId, at: now, attempts: reassigned.lease.attempts + 1 };
      job.leaseByKey.set(reassigned.t.key, granted);
      this._append(job, { type: 'lease-reassigned', key: reassigned.t.key, from: reassigned.lease.nodeId, to: nodeId, attempts: granted.attempts });
      return { task: reassigned.t, lease: granted, reassigned: true };
    }
    return null;
  }

  validatePayload(job, task, payload) {
    const errors = [];
    if (!payload || typeof payload !== 'object') return ['payload 不是对象'];
    if (payload.key !== task.key) errors.push(`key 不匹配: payload=${payload.key} task=${task.key}`);
    const n = task.s1 - task.s0;
    if (payload.count !== n) errors.push(`count 不等于区间样本数: ${payload.count} != ${n}`);
    const npx = task.tile.w * task.tile.h;
    for (const field of ['sum', 'M2']) {
      if (!Array.isArray(payload[field]) || payload[field].length !== npx * 3)
        errors.push(`${field} 长度应为 ${npx * 3}`);
      else if (!payload[field].every((v) => Number.isFinite(v))) errors.push(`${field} 含非有限值`);
    }
    if (payload.s0 !== task.s0 || payload.s1 !== task.s1) errors.push('样本区间 s0/s1 与任务不符');
    return errors;
  }

  // 提交结果：校验门槛 + 去重。重复 key 绝不二次计数。
  submit(jobId, nodeId, payload, now = Date.now()) {
    const job = this.jobs.get(jobId);
    if (!job) return { status: 'no-job' };
    const task = job.tasks.find((t) => t.key === payload?.key);
    if (!task) {
      const entry = { nodeId, key: payload?.key ?? null, reason: 'unknown-key' };
      this.recordFailure(jobId, entry);
      this._append(job, { type: 'result-rejected', ...entry });
      job.rejected++;
      return { status: 'rejected', reason: entry.reason };
    }
    if (job.accepted.has(task.key)) {
      job.duplicates++;
      this._append(job, { type: 'duplicate-rejected', key: task.key, nodeId });
      this.recordFailure(jobId, { nodeId, key: task.key, reason: 'duplicate' });
      return { status: 'duplicate' };
    }
    const errors = this.validatePayload(job, task, payload);
    if (errors.length) {
      job.rejected++;
      const entry = { nodeId, key: task.key, reason: 'validation-failed', errors };
      this._append(job, { type: 'result-rejected', ...entry });
      this.recordFailure(jobId, entry);
      return { status: 'rejected', reason: 'validation-failed', errors };
    }
    const checksumInput = JSON.stringify([task.key, payload.count, payload.sum, payload.M2]);
    const checksum = createHash('sha256').update(checksumInput).digest('hex');
    job.accepted.set(task.key, { key: task.key, nodeId, n: payload.count, checksum, at: now });
    job.results.set(task.key, { task, count: payload.count, sum: payload.sum, M2: payload.M2, checksum, nodeId });
    this._append(job, { type: 'chunk-accepted', key: task.key, nodeId, n: payload.count, checksum });
    return { status: 'accepted', checksum };
  }

  progress(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const acceptedSamples = [...job.accepted.values()].reduce((a, e) => {
      const t = job.tasks.find((x) => x.key === e.key);
      return a + e.n * t.tile.w * t.tile.h;
    }, 0);
    return {
      jobId: job.jobId, state: job.state,
      acceptedIntervals: job.accepted.size, totalIntervals: job.tasks.length,
      acceptedSamples, totalSamples: job.totalSamples,
      duplicates: job.duplicates, rejected: job.rejected,
      pending: job.tasks.length - job.accepted.size,
      coverage: job.accepted.size / job.tasks.length,
    };
  }

  finishIfComplete(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== 'running') return job.state;
    const pending = job.tasks.filter((t) => !job.accepted.has(t.key));
    if (pending.length === 0) {
      job.state = 'complete';
      job.finishedAt = new Date().toISOString();
      this._append(job, { type: 'job-finished', state: 'complete' });
    }
    return job.state;
  }

  markPublished(jobId, event) {
    const job = this.jobs.get(jobId);
    job.publish = event;
    this._append(job, event);
  }
}
