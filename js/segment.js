import { makeCanvas, context2d, clamp, colorName } from "./util.js";

const yieldFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

export function maskBounds(maskCanvas, threshold = 10) {
  const { width, height } = maskCanvas;
  const data = context2d(maskCanvas, { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (data[(row + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function buildCutout(baseCanvas, maskCanvas) {
  const bounds = maskBounds(maskCanvas);
  if (!bounds) return null;
  const pad = 1;
  const x = clamp(bounds.x - pad, 0, baseCanvas.width - 1);
  const y = clamp(bounds.y - pad, 0, baseCanvas.height - 1);
  const w = clamp(bounds.x + bounds.w + pad, x + 1, baseCanvas.width) - x;
  const h = clamp(bounds.y + bounds.h + pad, y + 1, baseCanvas.height) - y;
  if (w < 2 || h < 2) return null;
  const canvas = makeCanvas(w, h);
  const ctx = context2d(canvas);
  ctx.drawImage(baseCanvas, x, y, w, h, 0, 0, w, h);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(maskCanvas, x, y, w, h, 0, 0, w, h);
  return { canvas, x: x + w / 2, y: y + h / 2, w, h };
}

export function unionMasks(masks, width, height) {
  const canvas = makeCanvas(width, height);
  const ctx = context2d(canvas);
  for (const mask of masks) {
    ctx.drawImage(mask, 0, 0, width, height);
  }
  return canvas;
}

function upscaleMask(workMask, width, height) {
  const full = makeCanvas(width, height);
  const ctx = context2d(full);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(workMask, 0, 0, width, height);
  return full;
}

function makeWorkMask(w, h, pixels) {
  const canvas = makeCanvas(w, h);
  const ctx = context2d(canvas, { willReadFrequently: true });
  const image = ctx.createImageData(w, h);
  for (const index of pixels) {
    const p = index * 4;
    image.data[p] = 255;
    image.data[p + 1] = 255;
    image.data[p + 2] = 255;
    image.data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function smoothLabels(labels, w, h, passes = 1) {
  const counts = new Int32Array(8);
  for (let pass = 0; pass < passes; pass += 1) {
    const next = Uint8Array.from(labels);
    for (let y = 1; y < h - 1; y += 1) {
      const row = y * w;
      for (let x = 1; x < w - 1; x += 1) {
        counts.fill(0);
        for (let dy = -1; dy <= 1; dy += 1) {
          const r = row + dy * w;
          for (let dx = -1; dx <= 1; dx += 1) {
            counts[labels[r + x + dx]] += 1;
          }
        }
        let best = labels[row + x];
        let bestCount = 0;
        for (let k = 0; k < counts.length; k += 1) {
          if (counts[k] > bestCount) {
            bestCount = counts[k];
            best = k;
          }
        }
        next[row + x] = best;
      }
    }
    labels.set(next);
  }
}

function connectedComponents(labelMap, w, h) {
  const n = w * h;
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  const components = [];
  for (let start = 0; start < n; start += 1) {
    if (visited[start]) continue;
    const label = labelMap[start];
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    const pixels = [];
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    let border = false;
    while (sp > 0) {
      const index = stack[--sp];
      pixels.push(index);
      const x = index % w;
      const y = (index - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      const neighbors = [index - 1, index + 1, index - w, index + w];
      for (let side = 0; side < 4; side += 1) {
        const next = neighbors[side];
        if (side === 0 && x === 0) continue;
        if (side === 1 && x === w - 1) continue;
        if (next < 0 || next >= n || visited[next]) continue;
        if (labelMap[next] !== label) continue;
        visited[next] = 1;
        stack[sp++] = next;
      }
    }
    components.push({
      label,
      pixels,
      area: pixels.length,
      bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      border,
    });
  }
  return components;
}

function averageColor(pixels, source, index) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of pixels) {
    const p = i * 4;
    r += source[p];
    g += source[p + 1];
    b += source[p + 2];
  }
  const count = pixels.length || 1;
  return [r / count, g / count, b / count];
}

/**
 * Memecah foto jadi beberapa bagian berbasis pengelompokan warna.
 * Bagian yang menempel tepi dan besar dianggap latar belakang.
 */
export async function autoSplit(baseCanvas, { maxParts = 6, onProgress = () => {} } = {}) {
  const W = baseCanvas.width;
  const H = baseCanvas.height;
  if (!W || !H) return [];

  const workMax = 560;
  const workScale = Math.min(1, workMax / Math.max(W, H));
  const w = Math.max(24, Math.round(W * workScale));
  const h = Math.max(24, Math.round(H * workScale));
  const work = makeCanvas(w, h);
  const wctx = context2d(work, { willReadFrequently: true });
  wctx.drawImage(baseCanvas, 0, 0, w, h);
  const pixels = wctx.getImageData(0, 0, w, h).data;
  const n = w * h;

  onProgress("Menganalisis warna foto…", 0.12);
  await yieldFrame();

  const step = Math.max(1, Math.round(Math.sqrt(n / 20000)));
  const samples = [];
  for (let y = Math.floor(step / 2); y < h; y += step) {
    for (let x = Math.floor(step / 2); x < w; x += step) {
      const p = (y * w + x) * 4;
      samples.push([pixels[p], pixels[p + 1], pixels[p + 2]]);
    }
  }
  if (samples.length < 30) return [];

  const k = 6;
  const centers = [samples[0]];
  while (centers.length < k) {
    let best = samples[0];
    let bestDist = -1;
    for (const sample of samples) {
      let minDist = Infinity;
      for (const center of centers) {
        const dr = sample[0] - center[0];
        const dg = sample[1] - center[1];
        const db = sample[2] - center[2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < minDist) minDist = dist;
      }
      if (minDist > bestDist) {
        bestDist = minDist;
        best = sample;
      }
    }
    centers.push(best.slice());
  }

  const sums = new Float64Array(k * 3);
  const counts = new Int32Array(k);
  for (let iteration = 0; iteration < 10; iteration += 1) {
    sums.fill(0);
    counts.fill(0);
    for (const sample of samples) {
      let bestIndex = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c += 1) {
        const dr = sample[0] - centers[c][0];
        const dg = sample[1] - centers[c][1];
        const db = sample[2] - centers[c][2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = c;
        }
      }
      sums[bestIndex * 3] += sample[0];
      sums[bestIndex * 3 + 1] += sample[1];
      sums[bestIndex * 3 + 2] += sample[2];
      counts[bestIndex] += 1;
    }
    for (let c = 0; c < k; c += 1) {
      if (!counts[c]) continue;
      centers[c][0] = sums[c * 3] / counts[c];
      centers[c][1] = sums[c * 3 + 1] / counts[c];
      centers[c][2] = sums[c * 3 + 2] / counts[c];
    }
  }

  onProgress("Memisahkan bagian foto…", 0.42);
  await yieldFrame();

  const labels = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = i * 4;
    const r = pixels[p];
    const g = pixels[p + 1];
    const b = pixels[p + 2];
    let bestIndex = 0;
    let bestDist = Infinity;
    for (let c = 0; c < k; c += 1) {
      const dr = r - centers[c][0];
      const dg = g - centers[c][1];
      const db = b - centers[c][2];
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = c;
      }
    }
    labels[i] = bestIndex;
  }
  smoothLabels(labels, w, h, 2);
  await yieldFrame();

  onProgress("Menyusun objek…", 0.62);
  const components = connectedComponents(labels, w, h);
  const total = n;
  const minArea = total * 0.004;
  const maxArea = total * 0.36;
  const borderLimit = total * 0.085;

  const eligible = components
    .filter((component) => component.area >= minArea)
    .filter((component) => component.area <= maxArea)
    .filter((component) => component.bbox.w >= 12 && component.bbox.h >= 12);
  const interior = eligible.filter((component) => !component.border).sort((a, b) => b.area - a.area);
  const edge = eligible
    .filter((component) => component.border && component.area <= borderLimit)
    .sort((a, b) => b.area - a.area);
  const candidates = interior.slice(0, maxParts);
  if (candidates.length < 4) {
    for (const component of edge) {
      if (candidates.length >= maxParts) break;
      candidates.push(component);
    }
  }

  if (!candidates.length) return [];

  const parts = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const component = candidates[index];
    const workMask = makeWorkMask(w, h, component.pixels);
    const mask = upscaleMask(workMask, W, H);
    const bounds = maskBounds(mask);
    if (!bounds) continue;
    const [r, g, b] = averageColor(component.pixels, pixels, index);
    parts.push({
      mask,
      bounds,
      color: colorName(r, g, b),
      coverage: component.area / total,
      area: component.area,
    });
    onProgress(`Menyiapkan objek ${parts.length}…`, 0.62 + (0.3 * (index + 1)) / candidates.length);
    await yieldFrame();
  }

  return parts;
}

/**
 * Memisahkan subjek dari hasil AI matte (kanal alpha) menjadi beberapa bagian.
 */
export async function splitForeground(baseCanvas, alphaCanvas, { maxParts = 5, onProgress = () => {} } = {}) {
  const W = baseCanvas.width;
  const H = baseCanvas.height;
  if (!W || !H) return { parts: [], reason: "empty" };

  const workMax = 640;
  const workScale = Math.min(1, workMax / Math.max(W, H));
  const w = Math.max(24, Math.round(W * workScale));
  const h = Math.max(24, Math.round(H * workScale));
  const workAlpha = makeCanvas(w, h);
  const waCtx = context2d(workAlpha, { willReadFrequently: true });
  waCtx.drawImage(alphaCanvas, 0, 0, w, h);
  const data = waCtx.getImageData(0, 0, w, h).data;
  const n = w * h;
  const labels = new Uint8Array(n);
  let foreground = 0;
  for (let i = 0; i < n; i += 1) {
    if (data[i * 4 + 3] > 110) {
      labels[i] = 1;
      foreground += 1;
    }
  }

  if (!foreground) return { parts: [], reason: "empty" };
  if (foreground / n > 0.94) return { parts: [], reason: "too-large" };

  onProgress("Memisahkan subjek…", 0.8);
  await yieldFrame();

  const components = connectedComponents(labels, w, h).filter((component) => component.label === 1);
  const minArea = Math.max(60, n * 0.0015);
  const candidates = components
    .filter((component) => component.area >= minArea)
    .sort((a, b) => b.area - a.area)
    .slice(0, maxParts);

  if (!candidates.length) return { parts: [], reason: "empty" };

  const parts = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const component = candidates[index];
    const workMask = makeWorkMask(w, h, component.pixels);
    const mask = upscaleMask(workMask, W, H);
    const maskCtx = context2d(mask);
    maskCtx.globalCompositeOperation = "destination-in";
    maskCtx.drawImage(alphaCanvas, 0, 0, W, H);
    const bounds = maskBounds(mask);
    if (!bounds) continue;
    const colored = makeCanvas(W, H);
    const coloredCtx = context2d(colored);
    coloredCtx.drawImage(baseCanvas, 0, 0);
    coloredCtx.globalCompositeOperation = "destination-in";
    coloredCtx.drawImage(mask, 0, 0);
    const colorData = context2d(colored, { willReadFrequently: true }).getImageData(
      bounds.x,
      bounds.y,
      Math.min(24, bounds.w),
      Math.min(24, bounds.h)
    ).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let p = 0; p < colorData.length; p += 4) {
      if (colorData[p + 3] > 40) {
        r += colorData[p];
        g += colorData[p + 1];
        b += colorData[p + 2];
        count += 1;
      }
    }
    const name = count ? colorName(r / count, g / count, b / count) : "Subjek";
    parts.push({
      mask,
      bounds,
      color: name,
      coverage: component.area / n,
      area: component.area,
    });
    onProgress(`Subjek ${parts.length} ditemukan…`, 0.82 + (0.1 * (index + 1)) / candidates.length);
    await yieldFrame();
  }

  return { parts, reason: parts.length ? "ok" : "empty" };
}

/**
 * Magic wand: flood fill warna dari titik yang diklik.
 */
export function wandSelect(baseCanvas, point, tolerance = 30) {
  const W = baseCanvas.width;
  const H = baseCanvas.height;
  if (point.x < 0 || point.y < 0 || point.x >= W || point.y >= H) return null;

  const maxPixels = 900000;
  const workScale = Math.min(1, Math.sqrt(maxPixels / (W * H)));
  const w = Math.max(8, Math.round(W * workScale));
  const h = Math.max(8, Math.round(H * workScale));
  const work = makeCanvas(w, h);
  const ctx = context2d(work, { willReadFrequently: true });
  ctx.drawImage(baseCanvas, 0, 0, w, h);
  const pixels = ctx.getImageData(0, 0, w, h).data;

  const sx = clamp(Math.floor(point.x * workScale), 0, w - 1);
  const sy = clamp(Math.floor(point.y * workScale), 0, h - 1);
  const seed = (sy * w + sx) * 4;
  const tr = pixels[seed];
  const tg = pixels[seed + 1];
  const tb = pixels[seed + 2];
  const threshold = (tolerance / 100) * 255;
  const thresholdSq = threshold * threshold;

  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  stack[sp++] = sy * w + sx;
  visited[sy * w + sx] = 1;
  const selected = [];
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;

  while (sp > 0) {
    const index = stack[--sp];
    selected.push(index);
    const x = index % w;
    const y = (index - x) / w;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    for (let side = 0; side < 4; side += 1) {
      let nx = x;
      let ny = y;
      if (side === 0) nx -= 1;
      else if (side === 1) nx += 1;
      else if (side === 2) ny -= 1;
      else ny += 1;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const next = ny * w + nx;
      if (visited[next]) continue;
      const p = next * 4;
      const dr = pixels[p] - tr;
      const dg = pixels[p + 1] - tg;
      const db = pixels[p + 2] - tb;
      if (dr * dr + dg * dg + db * db > thresholdSq) continue;
      visited[next] = 1;
      stack[sp++] = next;
    }
  }

  if (selected.length < 12) return null;
  if (selected.length > w * h * 0.97) return null;

  const workMask = makeWorkMask(w, h, selected);
  const mask = upscaleMask(workMask, W, H);
  const bounds = maskBounds(mask);
  if (!bounds) return null;

  return {
    mask,
    bounds,
    coverage: selected.length / (w * h),
  };
}
