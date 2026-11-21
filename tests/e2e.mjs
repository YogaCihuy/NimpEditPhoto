import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;
const BASE = "http://localhost:5173/";
const OUT = resolve("test-shots");
await mkdir(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log("[e2e]", ...args);
const profile = await mkdtemp(join(tmpdir(), "nimp-cdp-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-features=Translate,MediaRouter",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1440,900",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

async function waitForDebug() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return;
    } catch {
      /* retry */
    }
    await sleep(100);
  }
  throw new Error("Chrome debugging endpoint tidak tersedia");
}

await waitForDebug();
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = targets.find((item) => item.type === "page");
if (!target) throw new Error("Tidak ada target page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolvePromise, reject) => {
  ws.onopen = resolvePromise;
  ws.onerror = () => reject(new Error("WebSocket CDP gagal"));
});

let messageId = 0;
const pending = new Map();
const errors = [];
const events = new Map();

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
    else entry.resolve(message.result);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    errors.push(`exception: ${message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text}`);
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    const text = message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(" ");
    errors.push(`console: ${text}`);
  }
  if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    errors.push(`log: ${message.params.entry.text}`);
  }
  const listeners = events.get(message.method);
  if (listeners) listeners.splice(0).forEach((listener) => listener(message.params));
};

function send(method, params = {}) {
  return new Promise((resolvePromise, reject) => {
    const id = ++messageId;
    pending.set(id, { resolve: resolvePromise, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function waitEvent(method, timeout = 15000) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout event ${method}`)), timeout);
    const list = events.get(method) || [];
    events.set(method, list);
    list.push((params) => {
      clearTimeout(timer);
      resolvePromise(params);
    });
  });
}

async function evalp(expression, awaitPromise = true) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const description =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      "unknown exception";
    throw new Error(description);
  }
  return result.result?.value;
}

async function waitFor(expression, timeout = 20000, interval = 120) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const value = await evalp(expression);
      if (value) return value;
    } catch {
      /* page may be reloading */
    }
    await sleep(interval);
  }
  throw new Error(`Timeout menunggu: ${expression.slice(0, 120)}`);
}

async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(join(OUT, name), Buffer.from(data, "base64"));
  log("screenshot", name);
}

async function mouse(type, x, y) {
  await send("Input.dispatchMouseEvent", {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: 1,
  });
}

async function drag(points, pause = 16) {
  await mouse("mousePressed", points[0].x, points[0].y);
  for (const point of points.slice(1)) {
    await sleep(pause);
    await mouse("mouseMoved", point.x, point.y);
  }
  const last = points[points.length - 1];
  await mouse("mouseReleased", last.x, last.y);
  await sleep(150);
}

const report = {};

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__errors = [];
      window.addEventListener('error', (event) => window.__errors.push('error: ' + event.message));
      window.addEventListener('unhandledrejection', (event) => window.__errors.push('rejection: ' + String(event.reason)));
    `,
  });
  const loaded = waitEvent("Page.loadEventFired", 20000);
  await send("Page.navigate", { url: BASE });
  await loaded;
  await waitFor("!!window.nimpEditor");
  await waitFor("document.querySelector('#view').width > 200");
  await evalp(`(() => {
    window.__sum = (x, y, w, h) => {
      const ctx = window.nimpEditor.baseCtx;
      const data = ctx.getImageData(x, y, w, h).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum = (sum + data[i] * 3 + data[i + 1] * 5 + data[i + 2] * 7) % 1000000007;
      }
      return sum;
    };
    return true;
  })()`);
  report.viewport = await evalp("({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})");
  await shot("01-empty.png");

  // 1. Load sample photo
  report.photo = await evalp(`(async () => {
    const response = await fetch('assets/sample.png');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.src = url;
    await image.decode();
    await window.nimpEditor.loadFromImage(image, 'sample.png');
    URL.revokeObjectURL(url);
    return { width: window.nimpEditor.base.width, height: window.nimpEditor.base.height };
  })()`);
  await sleep(400);
  await shot("02-loaded.png");

  // 2. Text layer + live edit + drag
  await evalp("document.querySelector('[data-tool=\"text\"]').click()");
  await sleep(120);
  await evalp("document.querySelector('[data-action=\"addText\"]').click()");
  report.textCreated = await evalp(`(() => {
    const editor = window.nimpEditor;
    const layer = editor.selected;
    editor.mutateLayer(layer, (target) => {
      target.text = 'HALO NIMP';
      target.fontSize = 150;
      target.color = '#c6f432';
    }, 'test-text');
    return { kind: layer.kind, name: layer.name, w: layer.w, h: layer.h };
  })()`);
  const beforeMove = await evalp("({x: window.nimpEditor.selected.x, y: window.nimpEditor.selected.y})");
  const textPoint = await evalp(`(() => {
    const editor = window.nimpEditor;
    const layer = editor.selected;
    const screen = editor.imageToScreen({x: layer.x, y: layer.y});
    const rect = document.querySelector('#view').getBoundingClientRect();
    return {x: rect.left + screen.x, y: rect.top + screen.y};
  })()`);
  await drag([
    { x: textPoint.x, y: textPoint.y },
    { x: textPoint.x + 40, y: textPoint.y + 20 },
    { x: textPoint.x + 90, y: textPoint.y + 45 },
  ]);
  report.textMoved = await evalp(`(() => {
    const layer = window.nimpEditor.selected;
    return {x: Math.round(layer.x), y: Math.round(layer.y)};
  })()`);
  report.textDragDelta = {
    x: Math.round(report.textMoved.x - beforeMove.x),
    y: Math.round(report.textMoved.y - beforeMove.y),
  };

  // 3. Sticker
  report.sticker = await evalp("window.nimpEditor.addStickerEmoji('🐶').name");
  await evalp("window.nimpEditor.setTool('select')");
  await sleep(200);
  await shot("03-text-sticker.png");

  // 4. Brush erase + inpaint + undo/redo
  report.signChecksumBefore = await evalp("window.__sum(150, 590, 300, 120)");
  await evalp("document.querySelector('[data-tool=\"erase\"]').click()");
  await evalp("window.nimpEditor.brushSize = 70");
  const strokePoints = await evalp(`(() => {
    const editor = window.nimpEditor;
    const rect = document.querySelector('#view').getBoundingClientRect();
    const points = [];
    for (let i = 0; i <= 10; i += 1) {
      const imagePoint = {x: 200 + i * 20, y: 650 + (i % 2) * 8};
      const screen = editor.imageToScreen(imagePoint);
      points.push({x: rect.left + screen.x, y: rect.top + screen.y});
    }
    return points;
  })()`);
  await drag(strokePoints, 18);
  report.maskDirtyAfterStroke = await evalp("window.nimpEditor.maskDirty");
  await evalp("document.querySelector('[data-action=\"eraseApply\"]').click()");
  await waitFor("window.nimpEditor.busy === false", 20000);
  await sleep(200);
  report.signChecksumAfter = await evalp("window.__sum(150, 590, 300, 120)");
  await shot("04-erased.png");
  await evalp("window.nimpEditor.undo()");
  await sleep(150);
  report.signChecksumUndo = await evalp("window.__sum(150, 590, 300, 120)");
  await evalp("window.nimpEditor.redo()");
  await sleep(150);
  report.signChecksumRedo = await evalp("window.__sum(150, 590, 300, 120)");

  // 5. Wand select + lift layer
  await evalp("document.querySelector('[data-tool=\"wand\"]').click()");
  await evalp("window.nimpEditor.tolerance = 22");
  const wandPoint = await evalp(`(() => {
    const editor = window.nimpEditor;
    const screen = editor.imageToScreen({x: 300, y: 620});
    const rect = document.querySelector('#view').getBoundingClientRect();
    return {x: rect.left + screen.x, y: rect.top + screen.y};
  })()`);
  await mouse("mousePressed", wandPoint.x, wandPoint.y);
  await mouse("mouseReleased", wandPoint.x, wandPoint.y);
  await sleep(600);
  report.wandSelection = await evalp(`(() => {
    const selection = window.nimpEditor.selection;
    return selection ? {coverage: Math.round(selection.coverage * 1000) / 1000, bounds: selection.bounds} : null;
  })()`);
  const layersBeforeLift = await evalp("window.nimpEditor.layers.length");
  if (report.wandSelection) {
    await evalp("document.querySelector('[data-action=\"wandLift\"]').click()");
    await waitFor("window.nimpEditor.busy === false", 20000);
    await sleep(200);
  }
  report.wandLiftLayers = (await evalp("window.nimpEditor.layers.length")) - layersBeforeLift;
  await shot("05-wand-lift.png");

  // 6. Auto split + undo/redo
  const layersBeforeSplit = await evalp("window.nimpEditor.layers.length");
  await evalp("document.querySelector('[data-tool=\"split\"]').click()");
  await sleep(120);
  await evalp("document.querySelector('[data-action=\"runSplit\"]').click()");
  await waitFor("window.nimpEditor.busy === false", 40000);
  await sleep(300);
  const layersAfterSplit = await evalp("window.nimpEditor.layers.length");
  report.autoSplitAdded = layersAfterSplit - layersBeforeSplit;
  report.autoSplitLayers = await evalp("window.nimpEditor.layers.map((layer) => layer.name)");
  await shot("06-split.png");
  await evalp("window.nimpEditor.undo()");
  await sleep(200);
  report.layersAfterUndoSplit = await evalp("window.nimpEditor.layers.length");
  await evalp("window.nimpEditor.redo()");
  await sleep(200);
  report.layersAfterRedoSplit = await evalp("window.nimpEditor.layers.length");

  // 7. Export
  await evalp("document.querySelector('#btnExport').click()");
  await waitFor("!document.querySelector('#exportModal').hidden", 15000);
  await sleep(500);
  report.exportPreview = await evalp(`(() => {
    const image = document.querySelector('#resultImg');
    return {width: image.naturalWidth, height: image.naturalHeight, src: image.src.startsWith('blob:')};
  })()`);
  report.exportPng = await evalp(`(async () => {
    const result = await window.nimpEditor.exportPNG();
    return {bytes: result.blob.size, width: result.width, height: result.height, layers: result.layers};
  })()`);
  await shot("07-export.png");
  await evalp("document.querySelector('#btnCloseExport').click()");

  // 8. Network / AI probe
  report.network = await evalp(`(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    const started = performance.now();
    try {
      const response = await fetch('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/package.json', {signal: controller.signal, mode: 'cors'});
      return {ok: response.ok, status: response.status, ms: Math.round(performance.now() - started)};
    } catch (error) {
      return {error: String(error), ms: Math.round(performance.now() - started)};
    } finally {
      clearTimeout(timer);
    }
  })()`);
  report.pageErrors = await evalp("window.__errors");
  report.runtimeErrors = errors;

  // 9. Mobile layout pass
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  const reloaded = waitEvent("Page.loadEventFired", 20000);
  await send("Page.reload", { ignoreCache: true });
  await reloaded;
  await waitFor("!!window.nimpEditor");
  await waitFor("document.querySelector('#view').width > 200");
  await sleep(400);
  report.mobile = await evalp(`(() => {
    const toolbar = document.querySelector('.toolbar').getBoundingClientRect();
    const fab = document.querySelector('#btnLayers');
    const sidebar = document.querySelector('#sidebar').getBoundingClientRect();
    const stage = document.querySelector('#stage').getBoundingClientRect();
    return {
      inner: [innerWidth, innerHeight],
      toolbar: {top: Math.round(toolbar.top), bottom: Math.round(toolbar.bottom), height: Math.round(toolbar.height)},
      stage: {width: Math.round(stage.width), height: Math.round(stage.height)},
      fabVisible: getComputedStyle(fab).display !== 'none',
      sidebarLeft: Math.round(sidebar.left),
      sidebarOffscreen: sidebar.left >= innerWidth - 2,
    };
  })()`);
  await shot("08-mobile-empty.png");
  await evalp(`(async () => {
    const response = await fetch('assets/sample.png');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.src = url;
    await image.decode();
    await window.nimpEditor.loadFromImage(image, 'sample.png');
    URL.revokeObjectURL(url);
    return true;
  })()`);
  await sleep(500);
  await shot("09-mobile-loaded.png");
  await evalp("document.querySelector('#btnLayers').click()");
  await sleep(500);
  report.mobileDrawer = await evalp(`(() => {
    const sidebar = document.querySelector('#sidebar').getBoundingClientRect();
    return {left: Math.round(sidebar.left), width: Math.round(sidebar.width), open: document.querySelector('#sidebar').classList.contains('open')};
  })()`);
  await shot("10-mobile-drawer.png");
} catch (error) {
  report.fatal = String(error && error.stack ? error.stack : error);
  try {
    await shot("99-failure.png");
    report.failureState = await evalp("window.nimpEditor ? {layers: window.nimpEditor.layers.length, busy: window.nimpEditor.busy, hasBase: !!window.nimpEditor.base, errors: window.__errors} : null");
  } catch {
    /* ignore */
  }
} finally {
  console.log(JSON.stringify(report, null, 2));
  ws.close();
  chrome.kill();
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
