// 采样汇合服务（rendezvous）：节点登记/心跳、任务租约、结果校验去重、
// 事件日志持久化与重启恢复、完成后按门槛发布。所有接口返回 JSON。
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobStore } from './store.mjs';
import { aggregateJob, publishJob, imageStats } from './aggregate.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css' };

export function loadConfig(path) {
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  return cfg;
}

export function createRendezvous({ sceneConfig, deployConfig }) {
  const rv = deployConfig.rendezvous;
  const resolvePath = (p) => (p.startsWith('/') ? p : resolve(REPO_ROOT, p));
  const stateDir = resolvePath(rv.stateDir);
  const outputDir = resolvePath(rv.outputDir);
  const logDir = resolvePath(rv.logDir);
  const store = new JobStore({ stateDir, logDir, leaseMs: rv.jobLeaseMs });
  const allowedNodes = new Set(deployConfig.nodes.map((n) => n.nodeId));

  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(body);
  };
  const readBody = (req) => new Promise((resolveBody, rejectBody) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64 * 1024 * 1024) rejectBody(new Error('body too large')); });
    req.on('end', () => { try { resolveBody(data ? JSON.parse(data) : {}); } catch (e) { rejectBody(e); } });
    req.on('error', rejectBody);
  });

  const requireNode = (req, res) => {
    const nodeId = req.headers['x-node-id'];
    if (!nodeId || !allowedNodes.has(nodeId)) { send(res, 403, { error: '未登记节点：部署配置中不存在该 NODE_ID', nodeId: nodeId ?? null }); return null; }
    return nodeId;
  };

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    try {
      if (req.method === 'GET' && (p === '/' || p === '/healthz')) {
        return send(res, 200, { ok: true, service: 'sampling-rendezvous', jobs: store.listJobs().map((j) => j.jobId), nodes: store.health(Date.now(), rv.heartbeatTimeoutMs) });
      }
      if (req.method === 'GET' && p === '/api/nodes') {
        return send(res, 200, { configured: deployConfig.nodes.map((n) => n.nodeId), observed: store.health(Date.now(), rv.heartbeatTimeoutMs) });
      }
      if (req.method === 'POST' && p === '/api/nodes/heartbeat') {
        const nodeId = requireNode(req, res);
        if (!nodeId) return;
        const body = await readBody(req);
        const node = store.heartbeat(nodeId, body);
        return send(res, 200, { ok: true, nodeId, lastSeenAgoMs: 0, heartbeats: node.heartbeats });
      }
      if (req.method === 'POST' && p === '/api/jobs') {
        const body = await readBody(req);
        const budget = Number(body.budget ?? sceneConfig.sequenceAllocation.defaultBudget);
        if (!sceneConfig.sequenceAllocation.budgets.includes(budget))
          return send(res, 400, { error: `采样预算必须取自锁定选项 ${sceneConfig.sequenceAllocation.budgets.join('/')}`, got: body.budget });
        // 默认使用锁定场景尺寸；仅允许带 legacyOverride 标记的旧样例覆盖（见 legacy-example.config.json）
        const override = body.legacyOverride;
        const W = Number(override?.width ?? sceneConfig.image.width);
        const H = Number(override?.height ?? sceneConfig.image.height);
        const tileSize = Number(override?.tileSize ?? sceneConfig.image.tileSize);
        const chunkSize = Number(override?.chunkSize ?? sceneConfig.sequenceAllocation.chunkSize);
        const jobId = String(body.jobId ?? `job-${Date.now()}`);
        if (store.getJob(jobId)) return send(res, 409, { error: 'job 已存在', jobId });
        const job = store.createJob({
          jobId, budget, chunkSize, W, H, tileSize,
          sceneId: override ? `${sceneConfig.sceneId}@legacy-${override.width}x${override.height}` : sceneConfig.sceneId,
          policy: sceneConfig.sequenceAllocation.policy,
          startedBy: body.startedBy ?? 'cli',
        });
        return send(res, 201, { ok: true, jobId, totalIntervals: job.tasks.length, totalSamples: job.totalSamples, budget, legacy: Boolean(override) });
      }
      const jobMatch = p.match(/^\/api\/jobs\/([^/]+)(\/(lease|result|progress|publish|journal|snapshot))?$/);
      if (jobMatch) {
        const [, jobId, , action] = jobMatch;
        const job = store.getJob(jobId);
        if (!job) return send(res, 404, { error: 'job 不存在', jobId });
        if (req.method === 'GET' && (!action || action === 'progress')) {
          return send(res, 200, { progress: store.progress(jobId), publish: job.publish ?? null });
        }
        if (req.method === 'GET' && action === 'journal') {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          const file = join(stateDir, `job-${jobId}.journal.jsonl`);
          return res.end(existsSync(file) ? readFileSync(file) : '');
        }
        if (req.method === 'GET' && action === 'snapshot') {
          const merger = aggregateJob(job);
          const stats = imageStats(merger);
          return send(res, 200, {
            jobId, W: job.W, H: job.H, state: job.state,
            progress: store.progress(jobId),
            mean: Array.from(merger.mean),
            count: Array.from(merger.count),
            imageMean: stats.imageMean,
            channelMean: stats.channelMean,
            noise: stats.noise,
            perPixel: stats.perPixel,
            publish: job.publish ?? null,
          });
        }
        if (req.method === 'POST' && action === 'lease') {
          const nodeId = requireNode(req, res);
          if (!nodeId) return;
          await readBody(req);
          store.heartbeat(nodeId, {});
          const granted = store.lease(jobId, nodeId);
          if (!granted) return send(res, 200, { task: null, state: store.finishIfComplete(jobId) });
          return send(res, 200, { task: granted.task, lease: granted.lease, reassigned: granted.reassigned, W: job.W, H: job.H, sceneId: job.sceneId });
        }
        if (req.method === 'POST' && action === 'result') {
          const nodeId = requireNode(req, res);
          if (!nodeId) return;
          const payload = await readBody(req);
          const out = store.submit(jobId, nodeId, payload);
          store.finishIfComplete(jobId);
          return send(res, out.status === 'rejected' ? 422 : 200, out);
        }
        if (req.method === 'POST' && action === 'publish') {
          if (job.state !== 'complete') return send(res, 409, { error: 'job 尚未完成，禁止发布', state: job.state });
          if (job.publish?.type === 'published') return send(res, 409, { error: '产物已发布', outputDir: job.publish.outputDir });
          const merger = aggregateJob(job);
          const result = publishJob({ job, merger, config: { ...sceneConfig, _stateDir: stateDir }, outputDir, logDir });
          store.markPublished(jobId, result.decision);
          return send(res, result.ok ? 200 : 422, result);
        }
      }
      if (req.method === 'GET' && p.startsWith('/gui/')) {
        return serveGui(res, p);
      }
      if (req.method === 'GET' && p === '/gui') {
        res.writeHead(302, { location: '/gui/panel.html' });
        return res.end();
      }
      send(res, 404, { error: 'not found', path: p });
    } catch (err) {
      send(res, 500, { error: String(err?.message ?? err) });
    }
  }

  function serveGui(res, path) {
    const safe = normalize(path.replace(/^\/gui\//, ''));
    if (safe.startsWith('..')) { res.writeHead(403); return res.end(); }
    const file = join(HERE, '..', 'gui', safe);
    if (!existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  }

  const server = createServer(handle);
  // 追踪连接：关闭时主动销毁 keep-alive 空闲连接，避免 server.close() 被挂起
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.shutdown = () => new Promise((resolveShutdown) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolveShutdown(); } };
    // Node 18.2+：先关闭全部现存连接（含 keep-alive），再停止接收新连接
    try { server.closeAllConnections?.(); } catch { /* 版本不支持则靠 socket 追踪兜底 */ }
    for (const socket of sockets) socket.destroy();
    server.close((err) => {
      if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') console.error(JSON.stringify({ evt: 'shutdown-error', error: String(err.message) }));
      finish();
    });
    // 双保险：保证无论 close 回调何时触发，promise 都在下一个 tick 结束
    setImmediate(finish);
  });
  server.store = store;
  server.config = { stateDir, outputDir, logDir, allowedNodes: [...allowedNodes] };
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sceneConfig = loadConfig(resolve(HERE, '../config/scene.config.json'));
  const deployConfig = loadConfig(resolve(HERE, '../config/deployment.config.json'));
  const server = createRendezvous({ sceneConfig, deployConfig });
  const port = Number(process.env.RV_PORT ?? deployConfig.rendezvous.port);
  const host = process.env.RV_HOST ?? deployConfig.rendezvous.host;
  server.listen(port, host, () => console.log(JSON.stringify({ evt: 'rendezvous-listen', host, port, pid: process.pid })));
  const shutdown = (sig) => {
    console.log(JSON.stringify({ evt: 'rendezvous-shutdown', sig, pid: process.pid }));
    server.shutdown().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
