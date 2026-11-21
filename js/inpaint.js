import { makeCanvas, context2d, clamp } from "./util.js";

export function maskBounds(maskCanvas, threshold = 8) {
  const { width, height } = maskCanvas;
  if (!width || !height) return null;
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

/**
 * Mengisi area bertopeng dengan hasil difusi warna dari sekitarnya (content-aware fill ringan).
 * Mengembalikan data sebelum/sesudah untuk undo.
 */
export function inpaintFromMask(baseCtx, maskCanvas) {
  const baseCanvas = baseCtx.canvas;
  const W = baseCanvas.width;
  const H = baseCanvas.height;
  if (!W || !H) return null;

  const bounds = maskBounds(maskCanvas);
  if (!bounds) return null;

  const pad = 8;
  const x0 = clamp(bounds.x - pad, 0, W - 1);
  const y0 = clamp(bounds.y - pad, 0, H - 1);
  const x1 = clamp(bounds.x + bounds.w + pad, 1, W);
  const y1 = clamp(bounds.y + bounds.h + pad, 1, H);
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw < 3 || bh < 3) return null;

  const before = baseCtx.getImageData(x0, y0, bw, bh);

  const workScale = Math.min(1, Math.sqrt(80000 / (bw * bh)));
  const ww = clamp(Math.round(bw * workScale), 6, bw);
  const wh = clamp(Math.round(bh * workScale), 6, bh);

  const workBase = makeCanvas(ww, wh);
  const wbCtx = context2d(workBase, { willReadFrequently: true });
  wbCtx.imageSmoothingEnabled = true;
  wbCtx.imageSmoothingQuality = "medium";
  wbCtx.drawImage(baseCanvas, x0, y0, bw, bh, 0, 0, ww, wh);
  const baseData = wbCtx.getImageData(0, 0, ww, wh).data;

  const workMask = makeCanvas(ww, wh);
  const wmCtx = context2d(workMask, { willReadFrequently: true });
  wmCtx.imageSmoothingEnabled = true;
  wmCtx.drawImage(maskCanvas, x0, y0, bw, bh, 0, 0, ww, wh);
  const maskData = wmCtx.getImageData(0, 0, ww, wh).data;

  const count = ww * wh;
  const R = new Float32Array(count);
  const G = new Float32Array(count);
  const B = new Float32Array(count);
  const known = new Uint8Array(count);
  let unknownCount = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let knownCount = 0;

  for (let i = 0; i < count; i += 1) {
    const p = i * 4;
    R[i] = baseData[p];
    G[i] = baseData[p + 1];
    B[i] = baseData[p + 2];
    if (maskData[p + 3] > 18) {
      unknownCount += 1;
    } else {
      known[i] = 1;
      knownCount += 1;
      sumR += baseData[p];
      sumG += baseData[p + 1];
      sumB += baseData[p + 2];
    }
  }
  if (unknownCount === 0) return null;

  const avgR = knownCount ? sumR / knownCount : 128;
  const avgG = knownCount ? sumG / knownCount : 128;
  const avgB = knownCount ? sumB / knownCount : 128;

  for (let i = 0; i < count; i += 1) {
    if (!known[i]) {
      R[i] = avgR;
      G[i] = avgG;
      B[i] = avgB;
    }
  }

  const iterations = 34;
  for (let iter = 0; iter < iterations; iter += 1) {
    const backward = iter % 2 === 1;
    const startY = backward ? wh - 2 : 1;
    const endY = backward ? 0 : wh - 1;
    const stepY = backward ? -1 : 1;
    const startX = backward ? ww - 2 : 1;
    const endX = backward ? 0 : ww - 1;
    const stepX = backward ? -1 : 1;
    for (let y = startY; y !== endY; y += stepY) {
      const row = y * ww;
      for (let x = startX; x !== endX; x += stepX) {
        const i = row + x;
        if (known[i]) continue;
        const up = i - ww;
        const down = i + ww;
        const left = i - 1;
        const right = i + 1;
        R[i] = (R[up] + R[down] + R[left] + R[right]) * 0.25;
        G[i] = (G[up] + G[down] + G[left] + G[right]) * 0.25;
        B[i] = (B[up] + B[down] + B[left] + B[right]) * 0.25;
      }
    }
  }

  const filled = wbCtx.createImageData(ww, wh);
  const filledData = filled.data;
  for (let i = 0; i < count; i += 1) {
    const p = i * 4;
    if (known[i]) {
      filledData[p] = R[i];
      filledData[p + 1] = G[i];
      filledData[p + 2] = B[i];
    } else {
      const noise = (Math.random() - 0.5) * 4;
      filledData[p] = clamp(R[i] + noise, 0, 255);
      filledData[p + 1] = clamp(G[i] + noise, 0, 255);
      filledData[p + 2] = clamp(B[i] + noise, 0, 255);
    }
    filledData[p + 3] = 255;
  }
  wbCtx.putImageData(filled, 0, 0);

  const patch = makeCanvas(bw, bh);
  const pCtx = context2d(patch);
  pCtx.imageSmoothingEnabled = true;
  pCtx.imageSmoothingQuality = "high";
  pCtx.drawImage(workBase, 0, 0, bw, bh);
  pCtx.globalCompositeOperation = "destination-in";
  pCtx.drawImage(maskCanvas, x0, y0, bw, bh, 0, 0, bw, bh);

  baseCtx.save();
  baseCtx.drawImage(patch, x0, y0);
  baseCtx.restore();

  const after = baseCtx.getImageData(x0, y0, bw, bh);
  return {
    x: x0,
    y: y0,
    w: bw,
    h: bh,
    before,
    after,
    bytes: before.data.byteLength + after.data.byteLength,
  };
}
