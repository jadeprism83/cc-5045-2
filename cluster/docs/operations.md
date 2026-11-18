# 多进程采样集群操作手册

## 图形入口（主界面）

启动集群后，在浏览器打开出图任务面板：

```
http://127.0.0.1:8731/gui/panel.html
```

面板功能（全部直接调用采样汇合 HTTP API，无固定/模拟数据）：

- 选择采样预算（64 / 128 / 256 / 512 spp，锁定选项，来自 `cluster/config/scene.config.json`）并创建采样任务；
- 实时显示汇合图像（服务端按已接受区间渐进合成）、噪声变化曲线（均值标准误 vs 已接受样本）、图像均值累积曲线；
- 显示每像素计数 min/max、区间覆盖、重复回传拒绝数、校验拒绝数、发布状态；
- 显示每个工作节点的心跳在线状态；
- 任务完成后一键「发布产物」，触发服务端发布门槛校验。

> 命令行仅作为采样汇合的辅助手段，日常操作以图形面板为准。

## 命令行辅助

```bash
# 启动汇合服务 + 全部工作节点（按 deployment.config.json），并创建一个采样任务
JOB_ID=job-demo BUDGET=128 node cluster/scripts/start-cluster.mjs

# 健康检查（PID 存活性 + 心跳在线 + 任务进度；退出码 0 健康 / 1 异常）
node cluster/scripts/health-check.mjs

# 重启单个节点或全部节点（同一 JOB_ID，验证重启不重复计数）
node cluster/scripts/restart-node.mjs node-2
node cluster/scripts/restart-node.mjs --all

# 停止整个集群（幂等，可重复执行）
node cluster/scripts/stop-cluster.mjs

# 汇合辅助 CLI
node cluster/cli/rv-cli.mjs create --budget 128 --job-id job-cli-1
node cluster/cli/rv-cli.mjs nodes
node cluster/cli/rv-cli.mjs progress job-cli-1
node cluster/cli/rv-cli.mjs publish job-cli-1
node cluster/cli/rv-cli.mjs journal job-cli-1
```

## 故障注入演练

```bash
# node-3 执行到区间 5:2 前崩溃（退出码 91），再用 restart-node 拉起
CRASH_BEFORE_KEY=5:2 node cluster/scripts/start-cluster.mjs
node cluster/scripts/restart-node.mjs node-3

# node-4 每 5 个结果丢 1 个（区间遗失），遗失区间由后续认领补齐
DROP_EVERY=5 node cluster/scripts/start-cluster.mjs
```

## 锁定配置

- 场景与随机序列分配：`cluster/config/scene.config.json`
  - 策略 `counter-indexed-global-stride`：样本由 `(pixel, globalSampleIndex, dim)` 经 `hash32` 计数器索引唯一确定；
  - 全局样本编号区间按 `intervalId` 锁定，节点只认领区间、不拥有样本号段；换节点/重启/乱序都不改变样本内容、不重号；
  - 区间大小固定 16，预算仅允许 64/128/256/512。
- 工作节点部署：`cluster/config/deployment.config.json`
  - 4 个登记节点 `node-1..node-4`，未登记节点的租约/回传一律 403；
  - 汇合地址、状态/输出/日志目录、心跳超时、租约超时、轮询参数。

## 运行期目录

```
cluster/run/
  pids/                 # 汇合服务与各节点 PID
  current-job.json      # 当前任务 ID 与汇合地址
  state/job-*.journal.jsonl   # append-only 事件日志（重启回放依据）
  logs/job-*.failures.log     # 重复/校验失败/发布拒绝全部留痕
  logs/node-*.log             # 节点 stdout/stderr
  output/<jobId>/       # 仅发布成功后出现：image.ppm、stats.json、journal.jsonl、checksums.sha256
```

## 发布门槛（任一不过即拒绝，不出产物）

1. 区间全覆盖：接受区间数 == 任务清单区间数；
2. 每像素计数恰好等于预算（重复计数会使 max 超预算）；
3. 重复计数为 0；
4. 噪声估计为正有限值；
5. 与单进程参考（同一场景、同一计数器随机数、完整区间）的 RMSE ≤ 1e-9；
6. 图像均值与参考偏差 ≤ 0.05；
7. 四类产物齐全并生成 SHA-256 校验和。

未完成任务调用发布返回 409，汇合失败/门槛拒绝时 `output/<jobId>/` 不会产生有效产物，失败细节写入 `logs/job-*.failures.log`。

## 验证

```bash
node test/verify.mjs                                  # 内核层 16 项（RNG/加权汇合/去重/故障注入）
node cluster/test/cluster-evidence.test.mjs           # 真实多进程证据测试 7 组
```
