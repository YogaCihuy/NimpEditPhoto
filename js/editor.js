import { clamp, makeCanvas, context2d, canvasToBlob, nextFrame } from "./util.js";
import { History } from "./history.js";
import { Layer, ImageLayer, TextLayer } from "./layers.js";
import { inpaintFromMask } from "./inpaint.js";
import { autoSplit, splitForeground, wandSelect, buildCutout, unionMasks } from "./segment.js";
import { getForegroundAlpha } from "./ai.js";
import { autoBrighten, sharpenCanvas } from "./enhance.js";

const MAX_IMAGE_DIMENSION = 1900;
const MAX_LAYER_SCALE = 30;
const MIN_LAYER_SCALE = 0.03;
const ACCENT = "#c6f432";
const PINK = "#ff5c7a";

function makeBrushStamp(r, g, b) {
  const size = 128;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, size * 0.28, size / 2, size / 2, size * 0.5);
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
  gradient.addColorStop(0.68, `rgba(${r}, ${g}, ${b}, 1)`);
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  return canvas;
}

function copyCanvas(source) {
  const canvas = makeCanvas(source.width, source.height);
  context2d(canvas).drawImage(source, 0, 0);
  return canvas;
}

function tintMask(mask, color, width, height) {
  const canvas = makeCanvas(width, height);
  const ctx = context2d(canvas);
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export class Editor {
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.hooks = hooks;
    this.tool = "select";
    this.brushSize = 52;
    this.tolerance = 30;
    this.layers = [];
    this.selected = null;
    this.base = null;
    this.baseCtx = null;
    this.original = null;
    this.imageName = "";
    this.mask = null;
    this.maskCtx = null;
    this.maskView = null;
    this.maskViewCtx = null;
    this.maskDirty = false;
    this.selection = null;
    this.view = { scale: 1, ox: 0, oy: 0, fit: 1, autoFit: true };
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;
    this.drag = null;
    this.pointers = new Map();
    this.pinch = null;
    this.hover = null;
    this.showOriginal = false;
    this.spaceDown = false;
    this.busy = false;
    this.stamp = makeBrushStamp(255, 255, 255);
    this.stampView = makeBrushStamp(255, 92, 122);
    this.history = new History(() => this.emit());
    this.lastPoint = null;

    this.attachEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();

    this.loop = this.loop.bind(this);
    this.frame = requestAnimationFrame(this.loop);
  }

  /* ---------------- events ---------------- */

  attachEvents() {
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onWheel = this.onWheel.bind(this);
    this.onDblClick = this.onDblClick.bind(this);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", () => {
      if (!this.drag) this.hover = null;
    });
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("dblclick", this.onDblClick);
    window.addEventListener("keydown", (event) => {
      if (event.code === "Space" && !event.repeat) {
        this.spaceDown = true;
      }
    });
    window.addEventListener("keyup", (event) => {
      if (event.code === "Space") this.spaceDown = false;
    });
  }

  eventScreen(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  screenToImage(point) {
    return {
      x: (point.x - this.view.ox) / this.view.scale,
      y: (point.y - this.view.oy) / this.view.scale,
    };
  }

  imageToScreen(point) {
    return {
      x: this.view.ox + point.x * this.view.scale,
      y: this.view.oy + point.y * this.view.scale,
    };
  }

  pointInsideImage(point) {
    return !!this.base && point.x >= 0 && point.y >= 0 && point.x < this.base.width && point.y < this.base.height;
  }

  onWheel(event) {
    if (!this.base) return;
    event.preventDefault();
    const screen = this.eventScreen(event);
    const factor = Math.exp(-event.deltaY * 0.0016);
    this.setScale(this.view.scale * factor, screen);
  }

  onPointerDown(event) {
    if (!this.base || this.busy) return;
    this.canvas.focus({ preventScroll: true });
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2) {
      this.startPinch();
      return;
    }
    if (this.pointers.size > 2) return;

    const screen = this.eventScreen(event);
    const point = this.screenToImage(screen);
    this.lastPoint = point;

    if (event.button === 1 || this.spaceDown) {
      this.drag = { mode: "pan", startScreen: screen, startOx: this.view.ox, startOy: this.view.oy };
      this.canvas.style.cursor = "grabbing";
      return;
    }

    if (this.tool === "select") {
      const handle = this.handleAt(screen);
      if (handle && this.selected instanceof Layer) {
        const layer = this.selected;
        const before = layer.snapshot();
        this.drag = {
          mode: handle.type,
          layer,
          before,
          startPoint: point,
          center: { x: layer.x, y: layer.y },
          startScale: layer.scale,
          startRotation: layer.rotation,
          startDist: Math.max(1, distance(point, { x: layer.x, y: layer.y })),
          startAngle: Math.atan2(point.y - layer.y, point.x - layer.x),
          moved: false,
        };
        return;
      }
      const hit = this.topLayerAt(point);
      if (hit) {
        if (this.selected !== hit) this.select(hit);
        const before = hit.snapshot();
        this.drag = {
          mode: "move",
          layer: hit,
          before,
          startPoint: point,
          center: { x: hit.x, y: hit.y },
          moved: false,
        };
      } else {
        this.drag = {
          mode: "panclick",
          startScreen: screen,
          startOx: this.view.ox,
          startOy: this.view.oy,
          moved: false,
        };
      }
      return;
    }

    if (!this.pointInsideImage(point)) return;

    if (this.tool === "text") {
      const hit = this.topLayerAt(point);
      if (hit && hit.kind === "text") {
        this.select(hit);
        this.drag = {
          mode: "move",
          layer: hit,
          before: hit.snapshot(),
          startPoint: point,
          center: { x: hit.x, y: hit.y },
          moved: false,
        };
      } else {
        this.addTextLayer({ x: point.x, y: point.y });
      }
      return;
    }

    if (this.tool === "erase") {
      this.ensureMask();
      this.paintBrush(point, null);
      this.drag = { mode: "brush", moved: true };
      this.maskDirty = true;
      this.emit();
      return;
    }

    if (this.tool === "wand") {
      this.selectByWand(point);
    }
  }

  onPointerMove(event) {
    if (!this.base) return;
    if (this.pointers.has(event.pointerId)) {
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (this.pinch) {
      this.updatePinch();
      return;
    }

    const screen = this.eventScreen(event);
    const point = this.screenToImage(screen);
    this.hover = point;

    if (!this.drag) {
      this.updateCursor(screen, point);
      return;
    }

    const drag = this.drag;
    if (drag.mode === "pan" || drag.mode === "panclick") {
      const dx = screen.x - drag.startScreen.x;
      const dy = screen.y - drag.startScreen.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      this.view.ox = drag.startOx + dx;
      this.view.oy = drag.startOy + dy;
      this.view.autoFit = false;
      this.hooks.onView?.();
      return;
    }

    if (drag.mode === "move") {
      const layer = drag.layer;
      layer.x = drag.center.x + (point.x - drag.startPoint.x);
      layer.y = drag.center.y + (point.y - drag.startPoint.y);
      drag.moved = true;
      return;
    }

    if (drag.mode === "scale") {
      const layer = drag.layer;
      const dist = Math.max(1, distance(point, { x: layer.x, y: layer.y }));
      layer.scale = clamp((drag.startScale * dist) / drag.startDist, MIN_LAYER_SCALE, MAX_LAYER_SCALE);
      drag.moved = true;
      return;
    }

    if (drag.mode === "rotate") {
      const layer = drag.layer;
      const angle = Math.atan2(point.y - layer.y, point.x - layer.x);
      let next = drag.startRotation + (angle - drag.startAngle);
      if (event.shiftKey) {
        const step = Math.PI / 12;
        next = Math.round(next / step) * step;
      }
      layer.rotation = next;
      drag.moved = true;
      return;
    }

    if (drag.mode === "brush") {
      this.paintBrush(point, this.lastPoint);
      this.lastPoint = point;
      this.maskDirty = true;
    }
  }

  onPointerUp(event) {
    this.pointers.delete(event.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    if (drag.mode === "panclick" && !drag.moved) {
      this.select(null);
    }
    if ((drag.mode === "move" || drag.mode === "scale" || drag.mode === "rotate") && drag.moved) {
      this.pushLayerState(drag.layer, drag.before, drag.layer.snapshot(), null);
    }
    if (drag.mode === "brush") {
      this.emit();
    }
    this.canvas.style.cursor = this.tool === "select" ? "default" : this.defaultCursor();
  }

  onDblClick(event) {
    if (!this.base) return;
    const point = this.screenToImage(this.eventScreen(event));
    const hit = this.topLayerAt(point);
    if (hit && hit.kind === "text") {
      this.select(hit);
      this.hooks.onEditText?.(hit);
    }
  }

  updateCursor(screen, point) {
    if (!this.base) return;
    let cursor = this.defaultCursor();
    if (this.spaceDown) {
      cursor = "grab";
    } else if (this.tool === "select") {
      const handle = this.handleAt(screen);
      if (handle?.type === "scale") cursor = "nwse-resize";
      else if (handle?.type === "rotate") cursor = "grab";
      else if (this.topLayerAt(point)) cursor = "grab";
    }
    if (this.canvas.style.cursor !== cursor) this.canvas.style.cursor = cursor;
  }

  defaultCursor() {
    if (this.tool === "erase" || this.tool === "wand") return "crosshair";
    if (this.tool === "text") return "text";
    if (this.tool === "sticker") return "copy";
    return "default";
  }

  /* ---------------- pinch / zoom ---------------- */

  startPinch() {
    const points = [...this.pointers.values()];
    const rect = this.canvas.getBoundingClientRect();
    const mid = {
      x: (points[0].x + points[1].x) / 2 - rect.left,
      y: (points[0].y + points[1].y) / 2 - rect.top,
    };
    this.pinch = {
      startDist: Math.max(4, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)),
      startScale: this.view.scale,
      imgPoint: this.screenToImage(mid),
    };
    this.drag = null;
  }

  updatePinch() {
    if (this.pointers.size < 2) return;
    const points = [...this.pointers.values()];
    const rect = this.canvas.getBoundingClientRect();
    const mid = {
      x: (points[0].x + points[1].x) / 2 - rect.left,
      y: (points[0].y + points[1].y) / 2 - rect.top,
    };
    const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    const scale = clamp(
      this.pinch.startScale * (dist / this.pinch.startDist),
      this.view.fit * 0.2,
      Math.max(6, this.view.fit * 16)
    );
    this.view.scale = scale;
    this.view.ox = mid.x - this.pinch.imgPoint.x * scale;
    this.view.oy = mid.y - this.pinch.imgPoint.y * scale;
    this.view.autoFit = false;
    this.hooks.onView?.();
  }

  setScale(scale, anchorScreen) {
    if (!this.base) return;
    const anchor = anchorScreen || { x: this.cssW / 2, y: this.cssH / 2 };
    const imagePoint = this.screenToImage(anchor);
    const min = this.view.fit * 0.2;
    const max = Math.max(6, this.view.fit * 16);
    this.view.scale = clamp(scale, min, max);
    this.view.ox = anchor.x - imagePoint.x * this.view.scale;
    this.view.oy = anchor.y - imagePoint.y * this.view.scale;
    this.view.autoFit = false;
    this.hooks.onView?.();
  }

  zoomBy(factor) {
    this.setScale(this.view.scale * factor, { x: this.cssW / 2, y: this.cssH / 2 });
  }

  fit() {
    if (!this.base) return;
    const fit = this.computeFit();
    this.view.fit = fit;
    this.view.scale = fit;
    this.view.ox = (this.cssW - this.base.width * fit) / 2;
    this.view.oy = this.computeTopPadding() + (this.cssH - this.computeTopPadding() - this.computeBottomPadding() - this.base.height * fit) / 2;
    this.view.autoFit = true;
    this.hooks.onView?.();
  }

  computeTopPadding() {
    return this.cssW <= 980 ? 46 : 58;
  }

  computeBottomPadding() {
    return this.cssW <= 980 ? 92 : 30;
  }

  computeFit() {
    if (!this.base) return 1;
    const padX = this.cssW <= 980 ? 20 : 40;
    const availW = Math.max(40, this.cssW - padX * 2);
    const availH = Math.max(40, this.cssH - this.computeTopPadding() - this.computeBottomPadding());
    return Math.min(availW / this.base.width, availH / this.base.height, 3);
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelW = Math.round(rect.width * this.dpr);
    const pixelH = Math.round(rect.height * this.dpr);
    const previousW = this.cssW;
    const previousH = this.cssH;
    this.cssW = rect.width;
    this.cssH = rect.height;
    if (this.canvas.width !== pixelW || this.canvas.height !== pixelH) {
      this.canvas.width = pixelW;
      this.canvas.height = pixelH;
    }
    if (!this.base) return;
    if (this.view.autoFit) {
      this.fit();
      return;
    }
    if (previousW && previousH) {
      const center = {
        x: (previousW / 2 - this.view.ox) / this.view.scale,
        y: (previousH / 2 - this.view.oy) / this.view.scale,
      };
      this.view.fit = this.computeFit();
      this.view.ox = this.cssW / 2 - center.x * this.view.scale;
      this.view.oy = this.cssH / 2 - center.y * this.view.scale;
    }
    this.hooks.onView?.();
  }

  /* ---------------- image ---------------- */

  async loadFromImage(image, name = "foto.png") {
    const naturalW = image.naturalWidth || image.width;
    const naturalH = image.naturalHeight || image.height;
    const ratio = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(naturalW, naturalH));
    const width = Math.max(1, Math.round(naturalW * ratio));
    const height = Math.max(1, Math.round(naturalH * ratio));
    const base = makeCanvas(width, height);
    context2d(base).drawImage(image, 0, 0, width, height);
    this.base = base;
    this.baseCtx = context2d(base, { willReadFrequently: true });
    this.original = copyCanvas(base);
    this.imageName = name;
    this.layers = [];
    this.selected = null;
    this.selection = null;
    this.drag = null;
    this.pinch = null;
    this.pointers.clear();
    this.clearMask();
    this.showOriginal = false;
    this.history.clear();
    this.fit();
    this.emit();
    this.toast(`Foto dimuat · ${width} × ${height}px`);
  }

  get imageSize() {
    return this.base ? { width: this.base.width, height: this.base.height } : null;
  }

  /* ---------------- layers ---------------- */

  select(target) {
    this.selected = target;
    this.emit();
  }

  topLayerAt(point) {
    for (let index = this.layers.length - 1; index >= 0; index -= 1) {
      const layer = this.layers[index];
      if (layer.hitTest(point)) return layer;
    }
    return null;
  }

  addLayerObject(layer, { record = true, select = true, silent = false } = {}) {
    this.layers.push(layer);
    const index = this.layers.length - 1;
    if (record) {
      const command = {
        undo: () => {
          const current = this.layers.indexOf(layer);
          if (current >= 0) this.layers.splice(current, 1);
          if (this.selected === layer) this.selected = null;
          this.emit();
        },
        redo: () => {
          this.layers.splice(Math.min(index, this.layers.length), 0, layer);
          this.emit();
        },
      };
      this.history.push(command);
    }
    if (select) this.selected = layer;
    if (!silent) this.emit();
  }

  deleteLayer(layer) {
    const index = this.layers.indexOf(layer);
    if (index < 0) return;
    this.layers.splice(index, 1);
    if (this.selected === layer) this.selected = null;
    const command = {
      undo: () => {
        this.layers.splice(Math.min(index, this.layers.length), 0, layer);
        this.selected = layer;
        this.emit();
      },
      redo: () => {
        const current = this.layers.indexOf(layer);
        if (current >= 0) this.layers.splice(current, 1);
        if (this.selected === layer) this.selected = null;
        this.emit();
      },
    };
    this.history.push(command);
    this.emit();
    this.toast(`${layer.name} dihapus · Ctrl+Z untuk mengembalikan`);
  }

  toggleVisibility(layer) {
    this.mutateLayer(layer, (target) => {
      target.visible = !target.visible;
    });
    this.emit();
  }

  moveLayer(layer, direction) {
    const index = this.layers.indexOf(layer);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= this.layers.length) return;
    const swap = () => {
      const current = this.layers.indexOf(layer);
      const target = current + direction;
      if (target < 0 || target >= this.layers.length) return;
      const other = this.layers[target];
      this.layers[target] = layer;
      this.layers[current] = other;
      this.emit();
    };
    swap();
    const undoSwap = () => {
      const current = this.layers.indexOf(layer);
      const target = current - direction;
      if (target < 0 || target >= this.layers.length) return;
      const other = this.layers[target];
      this.layers[target] = layer;
      this.layers[current] = other;
      this.emit();
    };
    this.history.push({ undo: undoSwap, redo: swap });
  }

  pushLayerState(layer, before, after, mergeKey) {
    const changedKeys = Object.keys(before);
    let changed = false;
    for (const key of changedKeys) {
      if (before[key] !== after[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const last = this.history.last();
    if (
      mergeKey &&
      last &&
      last.mergeKey === mergeKey &&
      last.layerId === layer.id &&
      performance.now() - (last.time || 0) < 1400
    ) {
      last.after = after;
      last.time = performance.now();
      this.emit();
      return;
    }
    const command = {
      layerId: layer.id,
      mergeKey,
      time: performance.now(),
      before,
      after,
      undo: () => {
        layer.restore(command.before);
        this.emit();
      },
      redo: () => {
        layer.restore(command.after);
        this.emit();
      },
    };
    this.history.push(command);
    this.emit();
  }

  mutateLayer(layer, mutator, mergeKey = null) {
    const before = layer.snapshot();
    mutator(layer);
    if (layer.kind === "text") layer.render();
    const after = layer.snapshot();
    this.pushLayerState(layer, before, after, mergeKey);
    this.emit();
  }

  addTextLayer({ x, y, text = "Teks baru" } = {}) {
    if (!this.base) return null;
    const fontSize = Math.max(26, Math.round(Math.min(this.base.width, this.base.height) * 0.075));
    const layer = new TextLayer({
      text,
      fontSize,
      x: x ?? this.base.width / 2,
      y: y ?? this.base.height / 2,
    });
    this.addLayerObject(layer);
    this.setTool("select");
    this.hooks.onFocusText?.(layer);
    this.toast("Teks ditambahkan. Ubah isi & gaya di panel kanan.");
    return layer;
  }

  addStickerEmoji(emoji) {
    if (!this.base) return null;
    const size = Math.round(Math.min(this.base.width, this.base.height) * 0.26);
    const canvas = makeCanvas(512, 512);
    const ctx = context2d(canvas);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = '400 400px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
    ctx.fillText(emoji, 256, 276);
    const offset = (this.layers.length % 5) * 18;
    const layer = new ImageLayer({
      name: `Stiker ${emoji}`,
      canvas,
      w: size,
      h: size,
      x: this.base.width / 2 + offset,
      y: this.base.height / 2 + offset,
    });
    this.addLayerObject(layer);
    this.setTool("select");
    this.toast("Stiker ditambahkan. Geser & perbesar sesuai selera.");
    return layer;
  }

  addStickerFromImage(image, name = "Objek") {
    if (!this.base) return null;
    const naturalW = image.naturalWidth || image.width;
    const naturalH = image.naturalHeight || image.height;
    const limit = Math.min(1, 1100 / Math.max(naturalW, naturalH));
    const canvas = makeCanvas(naturalW * limit, naturalH * limit);
    context2d(canvas).drawImage(image, 0, 0, canvas.width, canvas.height);
    const fitScale = Math.min(1, (Math.min(this.base.width, this.base.height) * 0.45) / Math.max(canvas.width, canvas.height));
    const layer = new ImageLayer({
      name,
      canvas,
      w: canvas.width,
      h: canvas.height,
      x: this.base.width / 2,
      y: this.base.height / 2,
    });
    layer.scale = fitScale;
    this.addLayerObject(layer);
    this.setTool("select");
    this.toast("Objek ditambahkan.");
    return layer;
  }

  /* ---------------- brush / wand ---------------- */

  ensureMask() {
    if (!this.base) return;
    const { width, height } = this.base;
    if (this.mask && this.mask.width === width && this.mask.height === height) return;
    this.mask = makeCanvas(width, height);
    this.maskCtx = context2d(this.mask);
    this.maskView = makeCanvas(width, height);
    this.maskViewCtx = context2d(this.maskView);
    this.maskDirty = false;
  }

  clearMask() {
    if (this.mask) {
      this.maskCtx.clearRect(0, 0, this.mask.width, this.mask.height);
      this.maskViewCtx.clearRect(0, 0, this.maskView.width, this.maskView.height);
    }
    this.maskDirty = false;
    this.hover = null;
    this.emit();
  }

  paintBrush(point, from) {
    this.ensureMask();
    const size = this.brushSize;
    const radius = size / 2;
    const stampAt = (x, y) => {
      this.maskCtx.drawImage(this.stamp, x - radius, y - radius, size, size);
      this.maskViewCtx.drawImage(this.stampView, x - radius, y - radius, size, size);
    };
    if (!from) {
      stampAt(point.x, point.y);
      return;
    }
    const dist = distance(point, from);
    const step = Math.max(2, size * 0.16);
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= steps; i += 1) {
      stampAt(
        from.x + ((point.x - from.x) * i) / steps,
        from.y + ((point.y - from.y) * i) / steps
      );
    }
  }

  selectByWand(point) {
    const result = wandSelect(this.base, point, this.tolerance);
    if (!result) {
      this.toast("Area tidak terpilih. Coba klik area lain atau naikkan toleransi.", "warn");
      return;
    }
    this.clearMaskSilent();
    result.view = tintMask(result.mask, ACCENT, this.base.width, this.base.height);
    this.selection = result;
    this.emit();
    if (result.coverage > 0.8) {
      this.toast("Area terpilih hampir seluruh foto. Kecilkan toleransi untuk hasil rapi.", "warn");
    }
  }

  clearMaskSilent() {
    if (this.mask) {
      this.maskCtx.clearRect(0, 0, this.mask.width, this.mask.height);
      this.maskViewCtx.clearRect(0, 0, this.maskView.width, this.maskView.height);
    }
    this.maskDirty = false;
  }

  discardSelection() {
    this.selection = null;
    this.emit();
  }

  async applyErase() {
    if (this.busy) return;
    if (!this.maskDirty || !this.mask) {
      this.toast("Coret dulu area yang mau dihapus.", "warn");
      return;
    }
    this.busy = true;
    this.hooks.onProgress?.({ text: "Mengisi area dengan background…", pct: null });
    await nextFrame();
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      const edit = inpaintFromMask(this.baseCtx, this.mask);
      if (!edit) {
        this.toast("Area terlalu kecil untuk diisi.", "warn");
        return;
      }
      const command = {
        bytes: edit.bytes,
        undo: () => {
          this.baseCtx.putImageData(edit.before, edit.x, edit.y);
          this.emit();
        },
        redo: () => {
          this.baseCtx.putImageData(edit.after, edit.x, edit.y);
          this.emit();
        },
      };
      this.history.push(command);
      this.clearMaskSilent();
      this.selection = null;
      this.toast("Area dihapus & background diisi ulang.");
      this.emit();
    } finally {
      this.busy = false;
      this.hooks.onProgress?.(null);
    }
  }

  async liftSelection() {
    if (this.busy || !this.selection) return;
    this.busy = true;
    this.hooks.onProgress?.({ text: "Mengangkat objek jadi lapisan…", pct: null });
    await nextFrame();
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      const cut = buildCutout(this.base, this.selection.mask);
      if (!cut) {
        this.toast("Gagal memotong objek.", "err");
        return;
      }
      const edit = inpaintFromMask(this.baseCtx, this.selection.mask);
      const layer = new ImageLayer({
        name: "Objek potongan",
        canvas: cut.canvas,
        x: cut.x,
        y: cut.y,
        w: cut.w,
        h: cut.h,
      });
      this.layers.push(layer);
      this.selected = layer;
      const command = {
        bytes: edit?.bytes || 0,
        undo: () => {
          const index = this.layers.indexOf(layer);
          if (index >= 0) this.layers.splice(index, 1);
          if (edit) this.baseCtx.putImageData(edit.before, edit.x, edit.y);
          if (this.selected === layer) this.selected = null;
          this.emit();
        },
        redo: () => {
          this.layers.push(layer);
          if (edit) this.baseCtx.putImageData(edit.after, edit.x, edit.y);
          this.selected = layer;
          this.emit();
        },
      };
      this.history.push(command);
      this.selection = null;
      this.emit();
      this.toast("Objek jadi lapisan sendiri. Background di belakangnya sudah diisi.");
    } finally {
      this.busy = false;
      this.hooks.onProgress?.(null);
    }
  }

  async applySelectionErase() {
    if (!this.selection) return;
    const mask = this.selection.mask;
    this.selection = null;
    this.ensureMask();
    this.maskCtx.clearRect(0, 0, this.mask.width, this.mask.height);
    this.maskCtx.drawImage(mask, 0, 0);
    this.maskViewCtx.clearRect(0, 0, this.maskView.width, this.maskView.height);
    this.maskViewCtx.drawImage(tintMask(mask, PINK, this.base.width, this.base.height), 0, 0);
    this.maskDirty = true;
    await this.applyErase();
  }

  /* ---------------- split ---------------- */

  async splitAutomatically() {
    if (this.busy || !this.base) return;
    this.busy = true;
    this.hooks.onProgress?.({ text: "Memecah foto jadi bagian…", pct: 0.05 });
    try {
      const parts = await autoSplit(this.base, {
        maxParts: 6,
        onProgress: (text, pct) => {
          this.hooks.onProgress?.({ text, pct });
        },
      });
      if (!parts.length) {
        this.toast("Belum ada objek yang bisa dipisah otomatis. Coba AI atau kuas hapus.", "warn");
        return;
      }
      this.applyParts(parts, "Objek");
    } catch (error) {
      console.error(error);
      this.toast("Gagal memecah foto.", "err");
    } finally {
      this.busy = false;
      this.hooks.onProgress?.(null);
    }
  }

  async splitWithAI() {
    if (this.busy || !this.base) return;
    this.busy = true;
    this.hooks.onProgress?.({ text: "Menyiapkan AI…", pct: 0.02 });
    try {
      const alpha = await getForegroundAlpha(this.base, (text, pct) => {
        this.hooks.onProgress?.({ text, pct });
      });
      const result = await splitForeground(this.base, alpha, {
        maxParts: 5,
        onProgress: (text, pct) => {
          this.hooks.onProgress?.({ text, pct });
        },
      });
      if (!result.parts.length) {
        const message =
          result.reason === "too-large"
            ? "AI melihat hampir seluruh foto sebagai subjek. Coba foto dengan subjek yang lebih jelas."
            : "AI belum menemukan subjek. Coba foto potret, atau pakai kuas hapus / pecah offline.";
        this.toast(message, "warn");
        return;
      }
      this.applyParts(result.parts, "Subjek");
    } catch (error) {
      console.error(error);
      this.toast("AI gagal dimuat. Cek koneksi internet, atau pakai Pecah offline.", "err");
    } finally {
      this.busy = false;
      this.hooks.onProgress?.(null);
    }
  }

  applyParts(parts, label) {
    const entries = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const cut = buildCutout(this.base, part.mask);
      if (!cut) continue;
      const suffix = part.color && part.color !== label ? ` · ${part.color}` : "";
      const layer = new ImageLayer({
        name: `${label} ${index + 1}${suffix}`,
        canvas: cut.canvas,
        x: cut.x,
        y: cut.y,
        w: cut.w,
        h: cut.h,
      });
      entries.push({ layer, mask: part.mask });
    }
    if (!entries.length) {
      this.toast("Tidak ada bagian yang berhasil dipotong.", "warn");
      return;
    }
    const union = unionMasks(entries.map((entry) => entry.mask), this.base.width, this.base.height);
    const edit = inpaintFromMask(this.baseCtx, union);
    const added = entries.map((entry) => entry.layer);
    for (const layer of added) this.layers.push(layer);
    this.selected = added[0];
    const command = {
      bytes: edit?.bytes || 0,
      undo: () => {
        for (const layer of added) {
          const index = this.layers.indexOf(layer);
          if (index >= 0) this.layers.splice(index, 1);
        }
        if (edit) this.baseCtx.putImageData(edit.before, edit.x, edit.y);
        if (added.includes(this.selected)) this.selected = null;
        this.emit();
      },
      redo: () => {
        for (const layer of added) this.layers.push(layer);
        if (edit) this.baseCtx.putImageData(edit.after, edit.x, edit.y);
        this.selected = added[0];
        this.emit();
      },
    };
    this.history.push(command);
    this.emit();
    this.toast(`${added.length} bagian dipisah jadi lapisan. Background sudah diisi ulang.`);
  }

  /* ---------------- tool & view ---------------- */

  setTool(tool) {
    if (this.tool === tool) return;
    this.clearMaskSilent();
    this.selection = null;
    this.drag = null;
    this.tool = tool;
    this.canvas.style.cursor = this.defaultCursor();
    this.emit();
    this.hooks.onTool?.(tool);
  }

  setShowOriginal(value) {
    this.showOriginal = !!value;
  }

  /* ---------------- history ---------------- */

  undo() {
    if (!this.history.undo()) return false;
    return true;
  }

  redo() {
    if (!this.history.redo()) return false;
    return true;
  }

  /* ---------------- enhancement ---------------- */

  async autoEnhance(strength = 0.55) {
    if (!this.base || this.busy) return;
    this.busy = true;
    this.hooks.onProgress?.({ text: "Menyeimbangkan cahaya…", pct: null });
    await nextFrame();
    try {
      const edit = autoBrighten(this.baseCtx, strength);
      if (!edit) {
        this.toast("Kecerahan sudah seimbang. Naikkan intensitas kalau masih kurang.", "warn");
        return;
      }
      this.history.push({
        bytes: edit.bytes,
        undo: () => {
          this.baseCtx.putImageData(edit.before, 0, 0);
          this.emit();
        },
        redo: () => {
          this.baseCtx.putImageData(edit.after, 0, 0);
          this.emit();
        },
      });
      this.emit();
      this.toast(
        `Cahaya diseimbangkan · rata-rata ${edit.stats.meanBefore}% → ${edit.stats.meanAfter}%`
      );
    } finally {
      this.busy = false;
      this.hooks.onProgress?.(null);
    }
  }

  /* ---------------- export ---------------- */

  compose() {
    if (!this.base) return null;
    const output = makeCanvas(this.base.width, this.base.height);
    const ctx = context2d(output);
    ctx.drawImage(this.base, 0, 0);
    for (const layer of this.layers) layer.draw(ctx);
    return output;
  }

  composeAt(longEdge = 0) {
    if (!this.base) return null;
    const baseLong = Math.max(this.base.width, this.base.height);
    const scale = longEdge > 0 ? longEdge / baseLong : 1;
    if (Math.abs(scale - 1) < 0.002) return this.compose();

    const width = Math.max(1, Math.round(this.base.width * scale));
    const height = Math.max(1, Math.round(this.base.height * scale));
    const output = makeCanvas(width, height);
    const ctx = context2d(output);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.base, 0, 0, width, height);

    for (const layer of this.layers) {
      if (!layer.visible || !layer.canvas) continue;
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.translate(layer.x * scale, layer.y * scale);
      ctx.rotate(layer.rotation);
      ctx.scale(layer.scale, layer.scale);
      const raster =
        layer.kind === "text" && typeof layer.rasterForScale === "function"
          ? layer.rasterForScale(scale)
          : layer.canvas;
      ctx.drawImage(raster, (-layer.w * scale) / 2, (-layer.h * scale) / 2, layer.w * scale, layer.h * scale);
      ctx.restore();
    }

    if (scale > 1.05) sharpenCanvas(output, 0.32);
    return output;
  }

  async exportPNG({ longEdge = 0 } = {}) {
    const canvas = this.composeAt(longEdge);
    if (!canvas) return null;
    const blob = await canvasToBlob(canvas, "image/png");
    return {
      blob,
      width: canvas.width,
      height: canvas.height,
      layers: this.layers.length,
      longEdge,
    };
  }

  /* ---------------- render ---------------- */

  loop(now) {
    this.render(now);
    this.frame = requestAnimationFrame(this.loop);
  }

  render(now = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.base) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.save();
    ctx.translate(this.view.ox, this.view.oy);
    ctx.scale(this.view.scale, this.view.scale);

    const source = this.showOriginal ? this.original : this.base;
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
    ctx.shadowBlur = 30 / this.view.scale;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    ctx.restore();
    ctx.drawImage(source, 0, 0);

    if (!this.showOriginal) {
      for (const layer of this.layers) layer.draw(ctx);

      if (this.tool === "erase" && this.maskDirty && this.maskView) {
        ctx.save();
        ctx.globalAlpha = 0.52;
        ctx.drawImage(this.maskView, 0, 0);
        ctx.restore();
      }

      if (this.selection?.view) {
        ctx.save();
        ctx.globalAlpha = 0.42 + Math.sin(now / 280) * 0.07;
        ctx.drawImage(this.selection.view, 0, 0);
        ctx.restore();
      }
    }

    ctx.restore();

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.showOriginal) return;

    if (this.selection?.bounds) {
      this.drawSelectionOutline(now);
    }
    if (this.selected instanceof Layer) {
      this.drawHandles(now);
    }
    if (this.tool === "erase" && this.hover && this.pointInsideImage(this.hover)) {
      this.drawBrushCursor();
    }
  }

  drawSelectionOutline(now) {
    const bounds = this.selection.bounds;
    const topLeft = this.imageToScreen({ x: bounds.x, y: bounds.y });
    const scale = this.view.scale;
    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.lineDashOffset = -now / 40;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.6;
    ctx.strokeRect(topLeft.x, topLeft.y, bounds.w * scale, bounds.h * scale);
    ctx.restore();
  }

  getRotateHandle(layer) {
    const corners = layer.corners().map((point) => this.imageToScreen(point));
    const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
    const center = this.imageToScreen({ x: layer.x, y: layer.y });
    let dx = topMid.x - center.x;
    let dy = topMid.y - center.y;
    const length = Math.hypot(dx, dy) || 1;
    dx /= length;
    dy /= length;
    return { mid: topMid, point: { x: topMid.x + dx * 30, y: topMid.y + dy * 30 } };
  }

  handleAt(screen) {
    if (!(this.selected instanceof Layer)) return null;
    const layer = this.selected;
    const corners = layer.corners().map((point) => this.imageToScreen(point));
    for (let index = 0; index < corners.length; index += 1) {
      if (distance(screen, corners[index]) <= 13) return { type: "scale", index };
    }
    const rotate = this.getRotateHandle(layer);
    if (distance(screen, rotate.point) <= 14) return { type: "rotate" };
    return null;
  }

  drawHandles(now) {
    const layer = this.selected;
    const ctx = this.ctx;
    const corners = layer.corners().map((point) => this.imageToScreen(point));
    const rotate = this.getRotateHandle(layer);
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let index = 1; index < corners.length; index += 1) ctx.lineTo(corners[index].x, corners[index].y);
    ctx.closePath();
    ctx.stroke();

    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(rotate.mid.x, rotate.mid.y);
    ctx.lineTo(rotate.point.x, rotate.point.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const size = 9;
    for (const corner of corners) {
      ctx.fillStyle = "#0c0e12";
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.rect(corner.x - size / 2, corner.y - size / 2, size, size);
      ctx.fill();
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(rotate.point.x, rotate.point.y, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = "#0c0e12";
    ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.restore();
  }

  drawBrushCursor() {
    const screen = this.imageToScreen(this.hover);
    const radius = (this.brushSize / 2) * this.view.scale;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, Math.max(4, radius), 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = PINK;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------- helpers ---------------- */

  emit() {
    this.hooks.onChange?.();
  }

  toast(message, type = "ok") {
    this.hooks.toast?.(message, type);
  }
}
