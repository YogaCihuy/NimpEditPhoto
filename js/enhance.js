import { clamp } from "./util.js";

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function histogramStats(data, width, height) {
  const bins = new Uint32Array(256);
  let total = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 12) continue;
    const luma = Math.round(luminance(data[i], data[i + 1], data[i + 2]));
    bins[Math.min(255, Math.max(0, luma))] += 1;
    sum += luma;
    total += 1;
  }
  if (!total) return null;
  const pick = (ratio) => {
    const target = total * ratio;
    let seen = 0;
    for (let i = 0; i < 256; i += 1) {
      seen += bins[i];
      if (seen >= target) return i / 255;
    }
    return 1;
  };
  return {
    total,
    mean: sum / total / 255,
    p2: pick(0.02),
    median: pick(0.5),
    p98: pick(0.98),
  };
}

/**
 * Menyeimbangkan pencahayaan: angkat bayangan & midtone, jaga highlight,
 * plus sedikit saturasi. Intensitas 0..1. Mengembalikan edit untuk undo/redo.
 */
export function autoBrighten(baseCtx, strength = 0.55) {
  const canvas = baseCtx.canvas;
  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) return null;
  const level = clamp(strength, 0, 1);
  if (level < 0.01) return null;

  const before = baseCtx.getImageData(0, 0, width, height);
  const stats = histogramStats(before.data, width, height);
  if (!stats) return null;

  const headroom = clamp((1 - stats.p98) / 0.04, 0.35, 1);
  const effective = level * headroom;
  const target = stats.mean + (0.56 - stats.mean) * effective;
  let gamma = target > 0.02 && stats.mean > 0.02 ? Math.log(target) / Math.log(stats.mean) : 1;
  gamma = clamp(gamma, 0.7, 1);

  const saturation = 1 + 0.07 * effective;
  const contrast = 0.055 * effective;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i += 1) {
    let value = Math.pow(i / 255, gamma);
    value += contrast * (value - 0.5) * (1 - Math.abs(value - 0.5) * 2);
    lut[i] = Math.round(clamp(value, 0, 1) * 255);
  }

  const after = new ImageData(new Uint8ClampedArray(before.data.length), width, height);
  const source = before.data;
  const out = after.data;
  let sumAfter = 0;
  let countAfter = 0;
  for (let i = 0; i < source.length; i += 4) {
    if (source[i + 3] < 12) {
      out[i] = source[i];
      out[i + 1] = source[i + 1];
      out[i + 2] = source[i + 2];
      out[i + 3] = source[i + 3];
      continue;
    }
    const r = lut[source[i]];
    const g = lut[source[i + 1]];
    const b = lut[source[i + 2]];
    const luma = luminance(r, g, b);
    out[i] = clamp(luma + (r - luma) * saturation, 0, 255);
    out[i + 1] = clamp(luma + (g - luma) * saturation, 0, 255);
    out[i + 2] = clamp(luma + (b - luma) * saturation, 0, 255);
    out[i + 3] = source[i + 3];
    sumAfter += luminance(out[i], out[i + 1], out[i + 2]);
    countAfter += 1;
  }

  baseCtx.putImageData(after, 0, 0);
  return {
    x: 0,
    y: 0,
    w: width,
    h: height,
    before,
    after,
    bytes: before.data.byteLength + after.data.byteLength,
    stats: {
      meanBefore: Math.round(stats.mean * 100),
      meanAfter: countAfter ? Math.round((sumAfter / countAfter / 255) * 100) : 0,
      p98Before: Math.round(stats.p98 * 100),
      gamma: Math.round(gamma * 100) / 100,
    },
  };
}

/**
 * Unsharp mask ringan untuk hasil upscale. Dilewati bila gambar terlalu besar
 * atau bila lingkungan tidak mendukung (mis. memori WebView terbatas).
 */
export function sharpenCanvas(canvas, amount = 0.35) {
  const width = canvas.width;
  const height = canvas.height;
  const pixels = width * height;
  if (width < 8 || height < 8 || amount <= 0 || pixels > 12500000) return false;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const image = ctx.getImageData(0, 0, width, height);
    const data = image.data;
    const source = new Uint8ClampedArray(data);
    const row = width * 4;
    for (let y = 1; y < height - 1; y += 1) {
      const base = y * row;
      for (let x = 1; x < width - 1; x += 1) {
        const i = base + x * 4;
        if (source[i + 3] < 12) continue;
        for (let c = 0; c < 3; c += 1) {
          const center = source[i + c];
          const sum = source[i - 4 + c] + source[i + 4 + c] + source[i - row + c] + source[i + row + c];
          data[i + c] = clamp(center + (amount * (center * 4 - sum)) / 4, 0, 255);
        }
      }
    }
    ctx.putImageData(image, 0, 0);
    return true;
  } catch (error) {
    console.warn("Penajaman HD dilewati.", error);
    return false;
  }
}
