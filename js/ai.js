import { makeCanvas, canvasToBlob } from "./util.js";

const CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";
const MODEL = "Xenova/modnet";

let segmenterPromise = null;
let statusHandler = null;

function report(message, progress) {
  if (statusHandler) statusHandler(message, progress);
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function ensureReachable() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch("https://huggingface.co/Xenova/modnet/resolve/main/config.json", {
      signal: controller.signal,
      cache: "no-store",
      mode: "cors",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

async function loadSegmenter() {
  if (segmenterPromise) return segmenterPromise;
  segmenterPromise = (async () => {
    report("Memeriksa koneksi…", 0.02);
    await ensureReachable();
    report("Memuat mesin AI…", 0.03);
    const module = await import(/* @vite-ignore */ CDN);
    const { pipeline, env } = module;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1;
    }
    let weightRatio = 0;
    const options = {
      progress_callback: (event) => {
        if (!event) return;
        if (event.status === "progress" && event.total > 1e6) {
          weightRatio = Math.max(weightRatio, Math.min(1, event.loaded / event.total));
          report(`Mengunduh model AI ${Math.round(weightRatio * 100)}%`, 0.05 + weightRatio * 0.58);
        } else if (event.status === "initiate") {
          report(`Menyiapkan ${event.file || "model AI"}…`, 0.04);
        }
      },
    };
    const ready = (segmenter) => {
      report("Model AI siap…", 0.68);
      return segmenter;
    };
    try {
      return ready(
        await withTimeout(
          pipeline("background-removal", MODEL, { ...options, dtype: "q8" }),
          240000,
          "Unduhan model AI terlalu lama"
        )
      );
    } catch (error) {
      console.warn("Model quantized gagal dimuat, mencoba versi standar.", error);
      return ready(
        await withTimeout(
          pipeline("background-removal", MODEL, options),
          240000,
          "Unduhan model AI terlalu lama"
        )
      );
    }
  })().catch((error) => {
    segmenterPromise = null;
    throw error;
  });
  return segmenterPromise;
}

function rawToAlphaCanvas(raw) {
  if (!raw || !raw.data || !raw.width || !raw.height) return null;
  const width = raw.width;
  const height = raw.height;
  const channels = raw.channels || 4;
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  const count = width * height;
  for (let i = 0; i < count; i += 1) {
    const alpha = channels >= 4 ? raw.data[i * channels + 3] : raw.data[i];
    const p = i * 4;
    image.data[p] = 255;
    image.data[p + 1] = 255;
    image.data[p + 2] = 255;
    image.data[p + 3] = alpha;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Menjalankan model pemisah subjek (MODNet) di browser.
 * Mengembalikan kanvas alpha seukuran gambar input.
 */
export async function getForegroundAlpha(imageCanvas, onStatus) {
  statusHandler = onStatus;
  try {
    const segmenter = await loadSegmenter();
    report("Menganalisis foto…", 0.72);
    const blob = await canvasToBlob(imageCanvas, "image/png");
    const url = URL.createObjectURL(blob);
    let output;
    try {
      output = await withTimeout(segmenter(url), 120000, "Analisis AI terlalu lama");
    } finally {
      URL.revokeObjectURL(url);
    }
    const raw = Array.isArray(output) ? output[0] : output;
    const alpha = rawToAlphaCanvas(raw);
    if (!alpha) throw new Error("Format keluaran model tidak dikenali");
    report("Menyiapkan hasil…", 0.78);
    return alpha;
  } finally {
    statusHandler = null;
  }
}
