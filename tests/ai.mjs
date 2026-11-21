import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9334;
const BASE = "http://localhost:5173/";
const OUT = resolve("test-shots");
await mkdir(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log("[ai]", ...args);
const profile = await mkdtemp(join(tmpdir(), "nimp-ai-"));
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
    errors.push(`console: ${message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(" ")}`);
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
  const result = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitFor(expression, timeout = 20000, interval = 150) {
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
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(OUT, name), Buffer.from(data, "base64"));
  log("screenshot", name);
}

const report = { progress: [] };

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

  report.online = await evalp("navigator.onLine");
  report.secure = await evalp("isSecureContext");

  // Track progress updates
  await evalp(`(() => {
    window.__progress = [];
    const editor = window.nimpEditor;
    const original = editor.hooks.onProgress;
    editor.hooks.onProgress = (payload) => {
      if (payload) window.__progress.push({ text: payload.text, pct: payload.pct });
      else window.__progress.push(null);
      original?.(payload);
    };
    return true;
  })()`);

  report.photo = await evalp(`(async () => {
    const response = await fetch('assets/sample.png');
    const image = new Image();
    image.src = URL.createObjectURL(await response.blob());
    await image.decode();
    await window.nimpEditor.loadFromImage(image, 'sample.png');
    return { width: window.nimpEditor.base.width, height: window.nimpEditor.base.height };
  })()`);
  await sleep(300);

  log("menjalankan splitWithAI()…");
  await evalp("window.nimpEditor.splitWithAI()", false);
  const start = Date.now();
  let lastText = "";
  while (Date.now() - start < 480000) {
    const state = await evalp(`(() => {
      const p = window.__progress[window.__progress.length - 1];
      return {
        busy: window.nimpEditor.busy,
        text: p ? p.text : null,
        pct: p ? p.pct : null,
        layers: window.nimpEditor.layers.length,
        toasts: [...document.querySelectorAll('#toastWrap .toast')].map((node) => node.textContent.trim()),
      };
    })()`);
    if (state.text && state.text !== lastText) {
      lastText = state.text;
      log(`progress: ${state.text}${state.pct != null ? ` (${Math.round(state.pct * 100)}%)` : ""}`);
    }
    report.progress.push({ at: Date.now() - start, ...state, busy: undefined, toasts: undefined });
    if (!state.busy) {
      report.final = state;
      break;
    }
    await sleep(2000);
  }
  report.durationMs = Date.now() - start;
  report.layers = await evalp("window.nimpEditor.layers.map((layer) => ({name: layer.name, kind: layer.kind}))");
  report.aiLayers = report.layers.filter((layer) => layer.name.startsWith("Subjek"));
  await sleep(500);
  await shot("11-ai-split.png");
  await evalp(`(() => {
    const layer = window.nimpEditor.layers[0];
    layer.x -= 260;
    layer.y += 60;
    window.nimpEditor.emit();
    return true;
  })()`);
  await sleep(400);
  await shot("15-ai-moved.png");
  report.pageErrors = errors;
  report.windowErrors = await evalp("window.__errors");
} catch (error) {
  report.fatal = String(error);
  errors.push(String(error));
  try {
    await shot("99-ai-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  console.log(JSON.stringify(report, null, 2));
  ws.close();
  chrome.kill();
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(report.fatal || report.aiLayers?.length ? (report.fatal ? 1 : 0) : 2);
}
