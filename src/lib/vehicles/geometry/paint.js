import * as THREE from 'three';

// Glossy vehicle surfaces (paint, glass, light covers): clearcoat reflecting
// a small procedural sky/ground panorama. Per-material envMap rather than
// scene.environment, so terrain and buildings stay unaffected.

const DAY_REFLECTION = 1.0;
const MIN_REFLECTION = 0.08;

const glossyMaterials = new Set();
let reflection = DAY_REFLECTION;
let envTexture = null;

/** Equirect panorama; high contrast (horizon line, clouds, skyline) so reflections read as gloss. */
function createPanoramaEnv() {
  const width = 512;
  const height = 256;
  const horizon = height / 2;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#3f78c0');
  sky.addColorStop(0.8, '#bcd8f5');
  sky.addColorStop(1, '#ffffff');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, horizon);

  const ground = ctx.createLinearGradient(0, horizon, 0, height);
  ground.addColorStop(0, '#4a4a44');
  ground.addColorStop(1, '#141412');
  ctx.fillStyle = ground;
  ctx.fillRect(0, horizon, width, height - horizon);

  // Deterministic clouds and skyline so every car reflects the same panorama.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (let i = 0; i < 14; i++) {
    const x = random() * width;
    const y = horizon * (0.2 + random() * 0.55);
    ctx.beginPath();
    ctx.ellipse(x, y, 20 + random() * 40, 5 + random() * 8, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#2b3530';
  for (let x = 0; x < width; ) {
    const w = 6 + random() * 24;
    ctx.fillRect(x, horizon - random() * 14, w, horizon);
    x += w + random() * 30;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** The shared reflection panorama (for materials that scale their own envMapIntensity). */
export function panoramaEnv() {
  envTexture ??= createPanoramaEnv();
  return envTexture;
}

/** Current day/night reflection strength, as set on glossy materials. */
export const paintReflection = () => reflection;

/** MeshPhysicalMaterial with clearcoat + panorama reflections; params as for MeshStandardMaterial. */
export function createGlossyMaterial(params) {
  panoramaEnv();
  const material = new THREE.MeshPhysicalMaterial({
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    envMap: envTexture,
    envMapIntensity: reflection,
    flatShading: true,
    ...params,
  });
  glossyMaterials.add(material);
  material.addEventListener('dispose', () => glossyMaterials.delete(material));
  return material;
}

// A paint value is 0xRRGGBB plus this flag bit, so it travels everywhere a colour does (saves, net).
export const METALLIC_PAINT = 0x1000000;
const METALLIC = { metalness: 0.75, roughness: 0.28 };

export const paintRgb = (paint) => paint & 0xffffff;
export const isMetallicPaint = (paint) => (paint & METALLIC_PAINT) !== 0;
export const withMetallic = (paint, on) => paintRgb(paint) | (on ? METALLIC_PAINT : 0);

/** Body paint: glossy material with paint-like defaults; `paint` may carry the metallic flag. */
export function createPaintMaterial(paint, options = {}) {
  const solid = { metalness: 0.3, roughness: 0.4, ...options };
  const material = createGlossyMaterial({ ...solid, color: paintRgb(paint) });
  material.userData.solidPaint = { metalness: solid.metalness, roughness: solid.roughness };
  setPaint(material, paint);
  return material;
}

/** Repaints a createPaintMaterial material: colour + solid / metallic finish. */
export function setPaint(material, paint) {
  material.color.setHex(paintRgb(paint));
  const finish = isMetallicPaint(paint) ? METALLIC : material.userData.solidPaint;
  if (!finish) return;
  material.metalness = finish.metalness;
  material.roughness = finish.roughness;
}

/** Paint gloss 0 (satin, no clearcoat sheen) .. 1 (full clearcoat, the default). */
export function setPaintGloss(material, gloss) {
  const g = THREE.MathUtils.clamp(gloss, 0, 1);
  material.clearcoat = g;
  material.clearcoatRoughness = THREE.MathUtils.lerp(0.6, 0.05, g);
}

/** Scales reflections with sky brightness so vehicles don't glow at night. */
export function setPaintReflection(skyColor) {
  const brightness = (skyColor.r + skyColor.g + skyColor.b) / 3;
  reflection = THREE.MathUtils.clamp(brightness * 3, MIN_REFLECTION, DAY_REFLECTION);
  for (const material of glossyMaterials) material.envMapIntensity = reflection;
}
