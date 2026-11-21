export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export function context2d(canvas, options = {}) {
  const ctx = canvas.getContext("2d", options);
  if (!ctx) throw new Error("Canvas 2D tidak tersedia");
  return ctx;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Gagal memuat gambar"));
    image.src = src;
  });
}

export async function fileToImage(file) {
  const url = URL.createObjectURL(file);
  try {
    return await loadImage(url);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

export function canvasToBlob(canvas, type = "image/png", quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Gagal membuat file gambar"));
    }, type, quality);
  });
}

export function canvasToImageData(canvas) {
  return context2d(canvas, { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function colorName(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (max < 42) return "Hitam";
  if (min > 222 && delta < 20) return "Putih";
  if (delta < 22) return max > 165 ? "Abu terang" : "Abu";
  let hue;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 15 || hue >= 345) return "Merah";
  if (hue < 42) return max < 165 ? "Coklat" : "Oranye";
  if (hue < 68) return "Kuning";
  if (hue < 155) return "Hijau";
  if (hue < 195) return "Toska";
  if (hue < 255) return "Biru";
  if (hue < 290) return "Ungu";
  return "Pink";
}

export function colorToHex(r, g, b) {
  return `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
