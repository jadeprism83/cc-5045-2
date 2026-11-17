// 商品静物参考场景：漫反射"产品"球、镜面反射球、小漫反射球、地面、球形面积光。
export const SCENE = {
  camera: { eye: [0, 1.05, 3.1], look: [0, 0.42, 0], up: [0, 1, 0], fov: 38 },
  light: { center: [0.2, 2.25, 1.1], radius: 0.55, emission: [10, 10, 10] },
  spheres: [
    { center: [-0.55, 0.5, 0.1], radius: 0.5, mat: { type: 'diffuse', albedo: [0.72, 0.22, 0.18] } },
    { center: [0.55, 0.42, 0.45], radius: 0.42, mat: { type: 'mirror', color: [0.93, 0.95, 0.97] } },
    { center: [0.05, 0.22, -0.85], radius: 0.22, mat: { type: 'diffuse', albedo: [0.2, 0.42, 0.72] } },
  ],
  plane: { y: 0, mat: { type: 'diffuse', albedo: [0.7, 0.68, 0.66] } },
};
