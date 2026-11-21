import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9335;
const BASE = "http://localhost:5173/";
const OUT = resolve("test-shots");
await mkdir(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const log = (...args) => console.log("[interaksi]", ...args);
const profile = await mkdtemp(join(tmpdir(), "nimp-int-"));
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

async function waitFor(expression, timeout = 20000, interval = 120) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const value = await evalp(expression);
      if (value) return value;
    } catch {
      /* ignore */
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

async function dragPath(points, pause = 16) {
  await mouse("mousePressed", points[0].x, points[0].y);
  for (const point of points.slice(1)) {
    await sleep(pause);
    await mouse("mouseMoved", point.x, point.y);
  }
  const last = points[points.length - 1];
  await mouse("mouseReleased", last.x, last.y);
  await sleep(120);
}

async function key(type, keyValue, code, vk, modifiers = 0) {
  await send("Input.dispatchKeyEvent", {
    type,
    key: keyValue,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  });
}

const report = {};

try {
  await send("Page.enable");
  await send("Runtime.enable");
  const loaded = waitEvent("Page.loadEventFired", 20000);
  await send("Page.navigate", { url: BASE });
  await loaded;
  await waitFor("!!window.nimpEditor");
  await waitFor("document.querySelector('#view').width > 200");

  // Load photo
  await evalp(`(async () => {
    const response = await fetch('assets/sample.png');
    const image = new Image();
    image.src = URL.createObjectURL(await response.blob());
    await image.decode();
    await window.nimpEditor.loadFromImage(image, 'sample.png');
    return true;
  })()`);
  await sleep(250);

  // Wand select + "Isi & Hapus"
  await evalp(`(() => {
    window.__sum = (x, y, w, h) => {
      const data = window.nimpEditor.baseCtx.getImageData(x, y, w, h).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum = (sum + data[i] * 3 + data[i + 1] * 5 + data[i + 2] * 7) % 1000000007;
      return sum;
    };
    return true;
  })()`);
  report.skyBefore = await evalp("window.__sum(700, 120, 220, 90)");
  await evalp("document.querySelector('[data-tool=\"wand\"]').click()");
  await evalp("window.nimpEditor.tolerance = 30");
  const skyPoint = await evalp(`(() => {
    const editor = window.nimpEditor;
    const screen = editor.imageToScreen({x: 820, y: 150});
    const rect = document.querySelector('#view').getBoundingClientRect();
    return {x: rect.left + screen.x, y: rect.top + screen.y};
  })()`);
  await mouse("mousePressed", skyPoint.x, skyPoint.y);
  await mouse("mouseReleased", skyPoint.x, skyPoint.y);
  await sleep(500);
  report.skySelected = await evalp("!!window.nimpEditor.selection");
  await evalp("document.querySelector('[data-action=\"wandErase\"]').click()");
  await waitFor("window.nimpEditor.busy === false", 20000);
  await sleep(200);
  report.skyAfter = await evalp("window.__sum(700, 120, 220, 90)");
  report.skyErased = report.skyAfter !== report.skyBefore;
  report.selectionCleared = await evalp("window.nimpEditor.selection === null");
  await evalp("window.nimpEditor.setTool('select')");

  // Add a text layer via the toolbar
  await evalp("document.querySelector('[data-tool=\"text\"]').click()");
  await sleep(100);
  await evalp("document.querySelector('[data-action=\"addText\"]').click()");
  await sleep(150);
  await evalp("window.nimpEditor.setTool('select')");
  await sleep(120);
  report.added = await evalp("window.nimpEditor.layers.length");

  // Type into the textarea through CDP and verify focus survives re-render
  await evalp(`(() => {
    const area = document.querySelector('#props textarea');
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    return area.value;
  })()`);
  await send("Input.insertText", { text: " GOYANG" });
  await sleep(400);
  report.typing = await evalp(`(() => {
    const layer = window.nimpEditor.selected;
    const area = document.querySelector('#props textarea');
    return {
      text: layer.text,
      focused: document.activeElement === area,
      value: area ? area.value : null,
    };
  })()`);

  // Change font size through the number input
  await evalp(`(() => {
    const input = document.querySelector('#props input[type="number"]');
    input.value = '96';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(250);
  report.fontSize = await evalp("window.nimpEditor.selected.fontSize");

  // Drag the bottom-right scale handle outward
  const scaleStart = await evalp(`(() => {
    const editor = window.nimpEditor;
    const layer = editor.selected;
    const rect = document.querySelector('#view').getBoundingClientRect();
    const corner = editor.imageToScreen(layer.corners()[2]);
    const center = editor.imageToScreen({x: layer.x, y: layer.y});
    return {
      from: {x: rect.left + corner.x, y: rect.top + corner.y},
      to: {x: rect.left + center.x + (corner.x - center.x) * 1.45, y: rect.top + center.y + (corner.y - center.y) * 1.45},
      scaleBefore: layer.scale,
      rotationBefore: layer.rotation,
    };
  })()`);
  await dragPath([scaleStart.from, { x: scaleStart.to.x, y: scaleStart.to.y }], 20);
  report.scale = await evalp("window.nimpEditor.selected.scale");
  report.scaleGrew = report.scale > scaleStart.scaleBefore * 1.15;

  // Drag the rotate handle a quarter turn around the layer center
  const rotateStart = await evalp(`(() => {
    const editor = window.nimpEditor;
    const layer = editor.selected;
    const rect = document.querySelector('#view').getBoundingClientRect();
    const corners = layer.corners().map((point) => editor.imageToScreen(point));
    const center = editor.imageToScreen({x: layer.x, y: layer.y});
    const topMid = {x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2};
    const dx = topMid.x - center.x;
    const dy = topMid.y - center.y;
    const length = Math.hypot(dx, dy) || 1;
    const handle = {x: topMid.x + (dx / length) * 30, y: topMid.y + (dy / length) * 30};
    const radius = Math.hypot(handle.x - center.x, handle.y - center.y);
    const startAngle = Math.atan2(handle.y - center.y, handle.x - center.x);
    const points = [];
    for (let i = 0; i <= 12; i += 1) {
      const angle = startAngle + (Math.PI / 2) * (i / 12);
      points.push({x: rect.left + center.x + Math.cos(angle) * radius, y: rect.top + center.y + Math.sin(angle) * radius});
    }
    return {points, center: {x: rect.left + center.x, y: rect.top + center.y}};
  })()`);
  await dragPath(rotateStart.points, 16);
  report.rotation = await evalp("window.nimpEditor.selected.rotation");
  report.rotationQuarterTurn = Math.abs(report.rotation - Math.PI / 2) < 0.2;
  await shot("12-interactions.png");

  // Keyboard delete + undo
  const layersBeforeDelete = await evalp("window.nimpEditor.layers.length");
  await evalp("document.querySelector('#view').focus()");
  await key("rawKeyDown", "Delete", "Delete", 46);
  await key("keyUp", "Delete", "Delete", 46);
  await sleep(200);
  report.layersAfterDelete = await evalp("window.nimpEditor.layers.length");
  await key("rawKeyDown", "z", "KeyZ", 90, 2);
  await key("keyUp", "z", "KeyZ", 90, 2);
  await sleep(200);
  report.layersAfterUndoDelete = await evalp("window.nimpEditor.layers.length");
  report.deleteWorks = report.layersAfterDelete === layersBeforeDelete - 1;
  report.deleteUndoWorks = report.layersAfterUndoDelete === layersBeforeDelete;

  // Compare button hold
  const compare = await evalp(`(() => {
    const rect = document.querySelector('#btnCompare').getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  })()`);
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: Math.round(compare.x),
    y: Math.round(compare.y),
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(200);
  report.compareHeld = await evalp("window.nimpEditor.showOriginal");
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: Math.round(compare.x),
    y: Math.round(compare.y),
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(200);
  report.compareReleased = !(await evalp("window.nimpEditor.showOriginal"));

  // Add panel + real file upload
  await evalp("document.querySelector('[data-tab=\"tambah\"]').click()");
  await sleep(250);
  await shot("13-add-panel.png");
  await send("DOM.enable");
  const doc = await send("DOM.getDocument", { depth: 1 });
  const fileNode = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#fileSticker" });
  const layersBeforeUpload = await evalp("window.nimpEditor.layers.length");
  await send("DOM.setFileInputFiles", {
    nodeId: fileNode.nodeId,
    files: [resolve("assets/sample.png")],
  });
  await sleep(700);
  report.upload = {
    before: layersBeforeUpload,
    after: await evalp("window.nimpEditor.layers.length"),
    name: await evalp("window.nimpEditor.selected ? window.nimpEditor.selected.name : null"),
  };
  report.uploadWorks = report.upload.after === layersBeforeUpload + 1;
  await evalp("document.querySelector('[data-tab=\"layers\"]').click()");
  await shot("14-after-upload.png");

  // Pinch zoom with two pointers
  report.pinch = await evalp(`(() => {
    const editor = window.nimpEditor;
    const canvas = document.querySelector('#view');
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const before = editor.view.scale;
    const fire = (type, id, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
      pointerId: id,
      clientX: x,
      clientY: y,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerType: 'touch',
      bubbles: true,
      cancelable: true,
    }));
    fire('pointerdown', 11, cx - 40, cy);
    fire('pointerdown', 12, cx + 40, cy);
    fire('pointermove', 11, cx - 100, cy);
    fire('pointermove', 12, cx + 100, cy);
    fire('pointerup', 11, cx - 100, cy);
    fire('pointerup', 12, cx + 100, cy);
    return { before, after: editor.view.scale };
  })()`);
  report.pinchWorks = report.pinch.after > report.pinch.before * 1.2;

  // Zoom controls
  const zoomBefore = await evalp("window.nimpEditor.view.scale");
  await evalp("document.querySelector('#btnZoomIn').click()");
  await sleep(120);
  report.zoomInWorks = (await evalp("window.nimpEditor.view.scale")) > zoomBefore;
  await evalp("document.querySelector('#btnZoomFit').click()");
  await sleep(120);
  report.fitWorks = await evalp("window.nimpEditor.view.fit");

  report.errors = errors;
} catch (error) {
  report.fatal = String(error);
  try {
    await shot("99-interactions-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  console.log(JSON.stringify(report, null, 2));
  ws.close();
  chrome.kill();
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(report.fatal ? 1 : 0);
}
