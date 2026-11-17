// Web Worker：接收 (瓦片, 样本区间) 任务，用同一份路径追踪内核计算，
// 返回该区间的每像素 Welford 统计量（可转移对象，零拷贝）。
import { SCENE } from './scene.js';
import { renderChunk } from './tracer.js';

self.onmessage = (e) => {
  const { tile, s0, s1, W, H } = e.data;
  const res = renderChunk(SCENE, W, H, tile, s0, s1);
  self.postMessage(
    { tile: res.tile, s0: res.s0, s1: res.s1, count: res.count, sum: res.sum, M2: res.M2 },
    [res.sum.buffer, res.M2.buffer]
  );
};
