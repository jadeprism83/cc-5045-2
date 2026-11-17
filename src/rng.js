// 计数器式哈希随机数：每个随机数由 (像素, 样本号, 路径维度) 稳定索引唯一决定。
// 任务换节点、完成顺序变化都不会改变某一样本的内容，也不会无意复用样本。

export function hash32(x) {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

// pixel: 像素线性索引; sample: 全局样本编号; dim: 路径维度（第几次抽取）
export function randIndex(pixel, sample, dim) {
  let h = hash32(pixel ^ 0x9e3779b9);
  h = hash32(h ^ hash32(sample ^ 0x85ebca6b));
  h = hash32(h ^ hash32(dim ^ 0xc2b2ae35));
  return h / 4294967296;
}

// 调度器注入故障用的局部流式 PRNG（与样本流无关）
export function makeStream(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
