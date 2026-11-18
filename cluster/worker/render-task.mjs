// 工作节点任务执行：把汇合服务下发的 (瓦片, 样本区间) 交给共享路径追踪内核，
// 输出可 JSON 传输的区间统计。随机数完全由计数器索引决定，与节点身份无关。
import { SCENE } from '../../src/scene.js';
import { renderChunk } from '../../src/tracer.js';

export function executeTask(task, W, H) {
  if (!task || !task.tile || !Number.isInteger(task.s0) || !Number.isInteger(task.s1) || task.s1 <= task.s0) {
    throw new Error('任务字段缺失或非法，拒绝以默认值补全执行');
  }
  const r = renderChunk(SCENE, W, H, task.tile, task.s0, task.s1);
  if (r.count !== task.s1 - task.s0) throw new Error('渲染样本数与区间不符');
  return {
    key: task.key, s0: r.s0, s1: r.s1, count: r.count,
    sum: Array.from(r.sum), M2: Array.from(r.M2),
  };
}
