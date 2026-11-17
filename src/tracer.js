// 路径追踪内核：漫反射（余弦半球采样 + 显式光源采样 NEE）与镜面反射材质。
// 每个样本的随机数由 randIndex(像素, 样本号, 维度) 驱动，与执行位置无关。
import { randIndex } from './rng.js';

const EPS = 1e-4;
const MAX_BOUNCES = 6;
const PI = Math.PI;

function next(rng) {
  return randIndex(rng.px, rng.s, rng.dim++);
}

export function makeCamera(cam, W, H) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
  const fwd = norm(sub(cam.look, cam.eye));
  const right = norm(cross(fwd, cam.up));
  const upv = cross(right, fwd);
  const halfH = Math.tan((cam.fov * PI) / 360);
  const halfW = halfH * (W / H);
  return { eye: cam.eye, fwd, right, upv, halfW, halfH };
}

function intersect(scene, ro, rd) {
  let bestT = Infinity, best = null;
  if (Math.abs(rd[1]) > 1e-9) {
    const t = (scene.plane.y - ro[1]) / rd[1];
    if (t > EPS && t < bestT) {
      bestT = t;
      best = { t, p: [ro[0] + rd[0] * t, scene.plane.y, ro[2] + rd[2] * t], n: [0, 1, 0], mat: scene.plane.mat };
    }
  }
  const testSphere = (c, r, mat) => {
    const ox = ro[0] - c[0], oy = ro[1] - c[1], oz = ro[2] - c[2];
    const b = ox * rd[0] + oy * rd[1] + oz * rd[2];
    const cc = ox * ox + oy * oy + oz * oz - r * r;
    const disc = b * b - cc;
    if (disc < 0) return;
    const sq = Math.sqrt(disc);
    let t = -b - sq;
    if (t < EPS) t = -b + sq;
    if (t < EPS || t >= bestT) return;
    const px = ro[0] + rd[0] * t, py = ro[1] + rd[1] * t, pz = ro[2] + rd[2] * t;
    bestT = t;
    best = { t, p: [px, py, pz], n: [(px - c[0]) / r, (py - c[1]) / r, (pz - c[2]) / r], mat };
  };
  for (const s of scene.spheres) testSphere(s.center, s.radius, s.mat);
  testSphere(scene.light.center, scene.light.radius, { emission: scene.light.emission });
  return best;
}

function cosineSample(n, u1, u2) {
  const r = Math.sqrt(u1), phi = 2 * PI * u2;
  const x = r * Math.cos(phi), y = r * Math.sin(phi), z = Math.sqrt(Math.max(0, 1 - u1));
  const a = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let tx = a[1] * n[2] - a[2] * n[1], ty = a[2] * n[0] - a[0] * n[2], tz = a[0] * n[1] - a[1] * n[0];
  const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
  const bx = n[1] * tz - n[2] * ty, by = n[2] * tx - n[0] * tz, bz = n[0] * ty - n[1] * tx;
  return [tx * x + bx * y + n[0] * z, ty * x + by * y + n[1] * z, tz * x + bz * y + n[2] * z];
}

function radiance(scene, ro, rd, rng) {
  const T = [1, 1, 1], L = [0, 0, 0];
  let prevDelta = true;
  for (let b = 0; b < MAX_BOUNCES; b++) {
    const hit = intersect(scene, ro, rd);
    if (!hit) break;
    const m = hit.mat;
    if (m.emission) {
      if (prevDelta) { L[0] += T[0] * m.emission[0]; L[1] += T[1] * m.emission[1]; L[2] += T[2] * m.emission[2]; }
      break;
    }
    const n = hit.n;
    if (m.type === 'mirror') {
      const d = 2 * (rd[0] * n[0] + rd[1] * n[1] + rd[2] * n[2]);
      rd = [rd[0] - d * n[0], rd[1] - d * n[1], rd[2] - d * n[2]];
      T[0] *= m.color[0]; T[1] *= m.color[1]; T[2] *= m.color[2];
      ro = [hit.p[0] + n[0] * EPS, hit.p[1] + n[1] * EPS, hit.p[2] + n[2] * EPS];
      prevDelta = true;
    } else {
      // 显式光源采样（下一事件估计）：在球形光源面上均匀取点，面积 PDF 转立体角 PDF
      const light = scene.light;
      const u1 = next(rng), u2 = next(rng);
      const z = 1 - 2 * u1, phi = 2 * PI * u2, rr = Math.sqrt(Math.max(0, 1 - z * z));
      const lx = light.center[0] + rr * Math.cos(phi) * light.radius;
      const ly = light.center[1] + z * light.radius;
      const lz = light.center[2] + rr * Math.sin(phi) * light.radius;
      let wx = lx - hit.p[0], wy = ly - hit.p[1], wz = lz - hit.p[2];
      const dist = Math.hypot(wx, wy, wz); wx /= dist; wy /= dist; wz /= dist;
      const cosX = n[0] * wx + n[1] * wy + n[2] * wz;
      const cosL = -(wx * (lx - light.center[0]) + wy * (ly - light.center[1]) + wz * (lz - light.center[2])) / light.radius;
      if (cosX > 0 && cosL > 1e-6) {
        const sro = [hit.p[0] + n[0] * EPS, hit.p[1] + n[1] * EPS, hit.p[2] + n[2] * EPS];
        const shadow = intersect(scene, sro, [wx, wy, wz]);
        if (shadow && shadow.mat.emission && shadow.t > dist - 1e-2) {
          const area = 4 * PI * light.radius * light.radius;
          const pdfSA = (dist * dist) / (area * cosL);
          const f = cosX / (pdfSA * PI);
          L[0] += T[0] * m.albedo[0] * light.emission[0] * f;
          L[1] += T[1] * m.albedo[1] * light.emission[1] * f;
          L[2] += T[2] * m.albedo[2] * light.emission[2] * f;
        }
      }
      const u3 = next(rng), u4 = next(rng);
      rd = cosineSample(n, u3, u4);
      T[0] *= m.albedo[0]; T[1] *= m.albedo[1]; T[2] *= m.albedo[2];
      ro = [hit.p[0] + n[0] * EPS, hit.p[1] + n[1] * EPS, hit.p[2] + n[2] * EPS];
      prevDelta = false;
    }
    if (b >= 2) {
      const q = Math.min(0.95, Math.max(0.05, Math.max(T[0], T[1], T[2])));
      if (next(rng) > q) break;
      T[0] /= q; T[1] /= q; T[2] /= q;
    }
  }
  return L;
}

// 渲染一个像素瓦片内、样本编号区间 [s0, s1) 的全部样本。
// 返回该区间每像素的 Welford 统计量（count 标量、sum、M2），供汇合内核加权合并。
export function renderChunk(scene, W, H, tile, s0, s1) {
  const cam = makeCamera(scene.camera, W, H);
  const npx = tile.w * tile.h;
  const sum = new Float64Array(npx * 3);
  const M2 = new Float64Array(npx * 3);
  const count = s1 - s0;
  for (let y = 0; y < tile.h; y++) {
    for (let x = 0; x < tile.w; x++) {
      const px = (tile.y0 + y) * W + (tile.x0 + x);
      const li = (y * tile.w + x) * 3;
      const mean = [0, 0, 0], m2 = [0, 0, 0];
      let n = 0;
      for (let s = s0; s < s1; s++) {
        const rng = { px, s, dim: 0 };
        const u = next(rng), v = next(rng);
        const sx = (2 * ((tile.x0 + x + u) / W) - 1) * cam.halfW;
        const sy = (1 - 2 * ((tile.y0 + y + v) / H)) * cam.halfH;
        let dx = cam.fwd[0] + cam.right[0] * sx + cam.upv[0] * sy;
        let dy = cam.fwd[1] + cam.right[1] * sx + cam.upv[1] * sy;
        let dz = cam.fwd[2] + cam.right[2] * sx + cam.upv[2] * sy;
        const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
        const L = radiance(scene, cam.eye, [dx, dy, dz], rng);
        n++;
        for (let c = 0; c < 3; c++) {
          const val = Math.min(L[c], 1e4);
          const delta = val - mean[c];
          mean[c] += delta / n;
          m2[c] += delta * (val - mean[c]);
        }
      }
      for (let c = 0; c < 3; c++) { sum[li + c] = mean[c] * n; M2[li + c] = m2[c]; }
    }
  }
  return { tile, s0, s1, count, sum, M2 };
}
