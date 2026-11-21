import { makeCanvas, context2d } from "./util.js";

let sequence = 0;
const nextId = () => `layer-${++sequence}`;

const measureCanvas = makeCanvas(8, 8);
const measureCtx = measureCanvas.getContext("2d");

export class Layer {
  constructor({ name = "Lapisan", canvas = null, w = 0, h = 0, x = 0, y = 0 }) {
    this.id = nextId();
    this.name = name;
    this.kind = "image";
    this.canvas = canvas;
    this.ctx = canvas ? context2d(canvas) : null;
    this.w = w;
    this.h = h;
    this.x = x;
    this.y = y;
    this.scale = 1;
    this.rotation = 0;
    this.opacity = 1;
    this.visible = true;
    this.pxRatio = 1;
  }

  draw(ctx) {
    if (!this.visible || !this.canvas) return;
    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);
    ctx.scale(this.scale, this.scale);
    ctx.drawImage(this.canvas, -this.w / 2, -this.h / 2, this.w, this.h);
    ctx.restore();
  }

  toLocal(point) {
    const dx = point.x - this.x;
    const dy = point.y - this.y;
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    return {
      x: (dx * cos + dy * sin) / this.scale + this.w / 2,
      y: (-dx * sin + dy * cos) / this.scale + this.h / 2,
    };
  }

  hitTest(point) {
    if (!this.visible || !this.canvas) return false;
    const local = this.toLocal(point);
    if (local.x < 0 || local.y < 0 || local.x >= this.w || local.y >= this.h) return false;
    const px = Math.floor(local.x * this.pxRatio);
    const py = Math.floor(local.y * this.pxRatio);
    try {
      const data = this.ctx.getImageData(px, py, 1, 1).data;
      return data[3] > 12;
    } catch {
      return true;
    }
  }

  corners() {
    const halfW = (this.w * this.scale) / 2;
    const halfH = (this.h * this.scale) / 2;
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    return [
      [-halfW, -halfH],
      [halfW, -halfH],
      [halfW, halfH],
      [-halfW, halfH],
    ].map(([lx, ly]) => ({
      x: this.x + lx * cos - ly * sin,
      y: this.y + lx * sin + ly * cos,
    }));
  }

  snapshot() {
    return {
      x: this.x,
      y: this.y,
      scale: this.scale,
      rotation: this.rotation,
      opacity: this.opacity,
      visible: this.visible,
      name: this.name,
    };
  }

  restore(state) {
    Object.assign(this, state);
  }
}

export class ImageLayer extends Layer {
  constructor({ name = "Objek", canvas, x, y, w, h }) {
    super({ name, canvas, w, h, x, y });
    this.kind = "image";
  }
}

let defaultTextStyle = {
  fontFamily: "Arial",
  fontSize: 72,
  color: "#ffffff",
  bold: true,
  italic: false,
  align: "left",
  shadow: true,
};

export function setDefaultTextStyle(patch) {
  defaultTextStyle = { ...defaultTextStyle, ...patch };
}

export function getDefaultTextStyle() {
  return { ...defaultTextStyle };
}

export class TextLayer extends Layer {
  constructor(options = {}) {
    super({ name: "Teks", x: options.x || 0, y: options.y || 0 });
    this.kind = "text";
    this.text = options.text ?? "Teks baru";
    this.fontFamily = options.fontFamily ?? defaultTextStyle.fontFamily;
    this.fontSize = options.fontSize ?? defaultTextStyle.fontSize;
    this.color = options.color ?? defaultTextStyle.color;
    this.bold = options.bold ?? defaultTextStyle.bold;
    this.italic = options.italic ?? defaultTextStyle.italic;
    this.align = options.align ?? defaultTextStyle.align;
    this.shadow = options.shadow ?? defaultTextStyle.shadow;
    this.lineHeight = 1.16;
    this.pxRatio = 2;
    this.render();
  }

  fontCss() {
    const weight = this.bold ? 700 : 400;
    const style = this.italic ? "italic " : "";
    return `${style}${weight} ${this.fontSize}px "${this.fontFamily}", sans-serif`;
  }

  render() {
    const lines = String(this.text ?? "").split("\n");
    measureCtx.font = this.fontCss();
    const widths = lines.map((line) => measureCtx.measureText(line || " ").width);
    const maxWidth = Math.max(12, ...widths);
    const lineHeight = this.fontSize * this.lineHeight;
    const padX = Math.round(this.fontSize * 0.16) + 3;
    const padY = Math.round(this.fontSize * 0.1) + 3;
    this.layout = { lines, widths, maxWidth, lineHeight, padX, padY };
    this.w = Math.ceil(maxWidth + padX * 2);
    this.h = Math.ceil(Math.max(this.fontSize, lines.length * lineHeight) + padY * 2);

    const canvas = makeCanvas(this.w * this.pxRatio, this.h * this.pxRatio);
    const ctx = context2d(canvas);
    ctx.scale(this.pxRatio, this.pxRatio);
    this.paint(ctx);
    this.canvas = canvas;
    this.ctx = ctx;
    const preview = lines.join(" ").trim();
    this.name = preview ? `Teks · ${preview.slice(0, 18)}` : "Teks kosong";
  }

  paint(ctx) {
    const { lines, widths, maxWidth, lineHeight, padX, padY } = this.layout;
    ctx.font = this.fontCss();
    ctx.textBaseline = "top";
    ctx.fillStyle = this.color;
    if (this.shadow) {
      ctx.shadowColor = "rgba(0,0,0,0.42)";
      ctx.shadowBlur = Math.max(2, this.fontSize * 0.1);
      ctx.shadowOffsetY = Math.max(1, this.fontSize * 0.025);
    }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      let x = padX;
      if (this.align === "center") x = padX + (maxWidth - widths[index]) / 2;
      else if (this.align === "right") x = padX + (maxWidth - widths[index]);
      ctx.fillText(line, x, padY + index * lineHeight);
    }
  }

  rasterForScale(scale) {
    if (!this.layout || scale <= 1.02) return this.canvas;
    const canvas = makeCanvas(this.w * scale, this.h * scale);
    const ctx = context2d(canvas);
    ctx.scale(scale, scale);
    this.paint(ctx);
    return canvas;
  }

  hitTest(point) {
    if (!this.visible || !this.canvas) return false;
    const local = this.toLocal(point);
    return local.x >= 0 && local.y >= 0 && local.x < this.w && local.y < this.h;
  }

  snapshot() {
    return {
      ...super.snapshot(),
      text: this.text,
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      color: this.color,
      bold: this.bold,
      italic: this.italic,
      align: this.align,
      shadow: this.shadow,
    };
  }

  restore(state) {
    super.restore(state);
    this.render();
  }
}
