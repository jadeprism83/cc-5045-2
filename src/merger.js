// 采样汇合内核：按显式样本权重（各区间样本数）做 Chan 并行方差合并。
// - 每个区间以唯一 key 登记，重复回传只计入一次；
// - 绝不把不同采样数的均值等权相加，合并权重为各自样本数；
// - 维护每像素 count/mean/M2，可输出噪声（均值标准误）与覆盖率统计。
export class Merger {
  constructor(W, H) {
    this.W = W; this.H = H;
    this.count = new Float64Array(W * H);
    this.mean = new Float64Array(W * H * 3);
    this.M2 = new Float64Array(W * H * 3);
    this.seen = new Set();
    this.acceptedChunks = 0;
    this.duplicates = 0;
    this.acceptedSamples = 0;
  }

  // key: 区间唯一标识（tileId:intervalId）；nB: 该区间每像素样本数
  addChunk(key, tile, nB, sum, m2) {
    if (this.seen.has(key)) { this.duplicates++; return false; }
    this.seen.add(key);
    const { x0, y0, w, h } = tile;
    const W = this.W;
    for (let y = 0; y < h; y++) {
      const row = (y0 + y) * W + x0;
      for (let x = 0; x < w; x++) {
        const gi = row + x, li = y * w + x;
        const nA = this.count[gi], n = nA + nB;
        const g3 = gi * 3, l3 = li * 3;
        for (let c = 0; c < 3; c++) {
          const meanB = sum[l3 + c] / nB;
          const mA = this.mean[g3 + c];
          const delta = meanB - mA;
          this.mean[g3 + c] = nA === 0 ? meanB : mA + (delta * nB) / n;
          this.M2[g3 + c] += m2[l3 + c] + (nA > 0 ? (delta * delta * nA * nB) / n : 0);
        }
        this.count[gi] = n;
      }
    }
    this.acceptedChunks++;
    this.acceptedSamples += nB * w * h;
    return true;
  }

  // 噪声估计：所有已采样像素的"均值标准误"（每通道 sqrt(var/n)）的平均
  noise() {
    let acc = 0, k = 0;
    for (let i = 0; i < this.W * this.H; i++) {
      const n = this.count[i];
      if (n < 2) continue;
      let se = 0;
      for (let c = 0; c < 3; c++) se += Math.sqrt(this.M2[i * 3 + c] / (n - 1) / n);
      acc += se / 3; k++;
    }
    return k ? acc / k : NaN;
  }

  perPixel() {
    let mn = Infinity, mx = 0;
    for (let i = 0; i < this.count.length; i++) {
      if (this.count[i] < mn) mn = this.count[i];
      if (this.count[i] > mx) mx = this.count[i];
    }
    return { min: mn, max: mx };
  }

  // 与参考图像（同一样本集合的单进程结果）比较
  compare(refMean) {
    let se = 0, maxAbs = 0;
    for (let i = 0; i < this.mean.length; i++) {
      const d = this.mean[i] - refMean[i];
      se += d * d;
      const ad = Math.abs(d);
      if (ad > maxAbs) maxAbs = ad;
    }
    return { rmse: Math.sqrt(se / this.mean.length), maxAbs };
  }
}
