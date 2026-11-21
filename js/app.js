import { $, $$, clamp, fileToImage, loadImage, downloadBlob, formatBytes, nextFrame } from "./util.js";
import { Editor } from "./editor.js";

const STICKERS = [
  "🧍", "🐶", "🐱", "🐘", "🦜",
  "🌳", "🌴", "🏠", "🎈", "☀️",
  "☁️", "⛵", "🚗", "🕶️", "👒",
  "🌺", "🔥", "⭐", "🪨", "🦋",
];

const FONTS = ["Arial", "Verdana", "Georgia", "Trebuchet MS", "Courier New", "Impact", "Comic Sans MS", "Segoe UI"];

const view = $("#view");
const stage = $("#stage");
const emptyState = $("#emptyState");
const imgInfo = $("#imgInfo");
const zoomLabel = $("#zoomLabel");
const toolOptions = $("#toolOptions");
const layerList = $("#layerList");
const props = $("#props");
const sidebar = $("#sidebar");
const aiProgress = $("#aiProgress");
const aiProgressText = $("#aiProgressText");
const aiProgressBar = $("#aiProgressBar");
const toastWrap = $("#toastWrap");
const filePhoto = $("#filePhoto");
const fileSticker = $("#fileSticker");
const exportModal = $("#exportModal");
const resultImg = $("#resultImg");
const resultMeta = $("#resultMeta");
const btnDownload = $("#btnDownload");
const btnUndo = $("#btnUndo");
const btnRedo = $("#btnRedo");
const btnExport = $("#btnExport");
const btnCompare = $("#btnCompare");
const btnOpen = $("#btnOpen");
const btnAI = $("#btnAI");
const btnZoomIn = $("#btnZoomIn");
const btnZoomOut = $("#btnZoomOut");
const btnZoomFit = $("#btnZoomFit");
const stageSkeleton = $("#stageSkeleton");
const stageSkeletonText = $("#stageSkeletonText");
const enhanceRange = $("#enhanceRange");
const enhanceValue = $("#enhanceValue");
const btnEnhance = $("#btnEnhance");
const qualityList = $("#qualityList");
const qualityNative = $("#qualityNative");
const hdHint = $("#hdHint");
const btnExportHD = $("#btnExportHD");
const resultPreview = $("#resultPreview");
const previewSkeleton = $("#previewSkeleton");
const previewSkeletonLabel = $("#previewSkeletonLabel");
const exportQuality = $("#exportQuality");
const qualityNote = $("#qualityNote");

let currentTab = "layers";
let lastPropsKey = "__init__";
let resultUrl = null;
let currentResult = null;
let draggingDepth = 0;
let saveQuality = 3840;
let exportSeq = 0;

const HD_SIZES = { 0: "Asli", 2560: "2K", 3840: "4K" };
const qualityName = (longEdge) => HD_SIZES[longEdge] || `${longEdge}px`;
const MAX_HD_EDGE = 3840;

/* ---------------- helpers ---------------- */

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function svg(markup) {
  const wrap = document.createElement("span");
  wrap.innerHTML = markup;
  return wrap.firstElementChild;
}

const ICONS = {
  eye: '<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 6.1A9.9 9.9 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.1 3.6M6.3 6.9C3.9 8.7 2.5 12 2.5 12S6 18 12 18a9 9 0 0 0 4-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4.8h6V7M6.5 7l.8 13h9.4l.8-13M10 11v6M14 11v6"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 17 4.5-4.5 3.5 3.5 2.5-2.5 4 4"/></svg>',
};

function toast(message, type = "ok") {
  const node = el("div", `toast ${type === "warn" ? "warn" : type === "err" ? "err" : ""}`, message);
  toastWrap.append(node);
  while (toastWrap.children.length > 3) toastWrap.firstElementChild.remove();
  setTimeout(() => {
    node.classList.add("out");
    setTimeout(() => node.remove(), 280);
  }, 3400);
}

function showProgress(state) {
  if (!state) {
    aiProgress.hidden = true;
    return;
  }
  aiProgress.hidden = false;
  aiProgressText.textContent = state.text || "Memproses…";
  if (typeof state.pct === "number" && Number.isFinite(state.pct)) {
    aiProgressBar.style.width = `${Math.round(clamp(state.pct, 0, 1) * 100)}%`;
  } else {
    aiProgressBar.style.width = "38%";
  }
}

function showStageSkeleton(text) {
  stageSkeletonText.textContent = text;
  stageSkeleton.hidden = false;
}

function hideStageSkeleton() {
  stageSkeleton.hidden = true;
}

function outputSize(longEdge) {
  if (!editor.base) return null;
  const long = Math.max(editor.base.width, editor.base.height);
  const scale = longEdge > 0 ? longEdge / long : 1;
  return {
    width: Math.max(1, Math.round(editor.base.width * scale)),
    height: Math.max(1, Math.round(editor.base.height * scale)),
    scale,
  };
}

function refreshSaveQuality() {
  const size = outputSize(saveQuality);
  const buttons = qualityList.querySelectorAll("button");
  buttons.forEach((button) => button.classList.toggle("on", Number(button.dataset.quality) === saveQuality));
  if (size && editor.base) {
    const nativeLong = Math.max(editor.base.width, editor.base.height);
    qualityNative.textContent = `${nativeLong} px`;
    const up = saveQuality > nativeLong + 2;
    hdHint.textContent = saveQuality
      ? `Hasil ${size.width} × ${size.height} px${up ? ` · upscale ${(size.scale).toFixed(2)}×` : " · tanpa penskalaan"}`
      : `Resolusi asli ${editor.base.width} × ${editor.base.height} px`;
  } else {
    qualityNative.textContent = "—";
    hdHint.textContent = "Sisi terpanjang 3840 px · rasio foto dipertahankan.";
  }
  btnExportHD.disabled = !editor.base || editor.busy;
}

function openSidebar() {
  if (window.innerWidth <= 980) sidebar.classList.add("open");
}

function switchTab(name) {
  currentTab = name;
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  $$(".tab-panel").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
}

function openAddPanel() {
  switchTab("tambah");
  openSidebar();
}

/* ---------------- editor ---------------- */

const editor = new Editor(view, {
  toast,
  onChange: () => syncUI(),
  onView: () => syncZoom(),
  onProgress: showProgress,
  onTool: (tool) => {
    if (tool === "sticker") openAddPanel();
    updateToolButtons();
    renderToolOptions();
  },
  onEditText: () => {
    switchTab("layers");
    openSidebar();
    setTimeout(() => {
      const textarea = props.querySelector("textarea");
      if (textarea) {
        textarea.focus();
        textarea.select();
      }
    }, 40);
  },
  onFocusText: () => {
    switchTab("layers");
    openSidebar();
  },
});

/* ---------------- UI sync ---------------- */

function syncUI() {
  renderLayerList();
  renderProps();
  updateChrome();
  renderToolOptions();
}

function syncZoom() {
  zoomLabel.textContent = `${Math.round(editor.view.scale * 100)}%`;
}

function updateToolButtons() {
  $$(".tool[data-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === editor.tool);
  });
}

function updateChrome() {
  const hasImage = !!editor.base;
  emptyState.hidden = hasImage;
  btnUndo.disabled = !editor.history.canUndo;
  btnRedo.disabled = !editor.history.canRedo;
  btnExport.disabled = !hasImage;
  btnCompare.disabled = !hasImage;
  btnAI.disabled = !hasImage;
  btnZoomIn.disabled = !hasImage;
  btnZoomOut.disabled = !hasImage;
  btnZoomFit.disabled = !hasImage;
  btnEnhance.disabled = !hasImage || editor.busy;
  refreshSaveQuality();
  if (hasImage) {
    const { width, height } = editor.imageSize;
    imgInfo.textContent = `${editor.imageName || "Foto"} · ${width}×${height} · ${editor.layers.length} lapisan`;
  } else {
    imgInfo.textContent = "Belum ada foto";
  }
  syncZoom();
  updateToolButtons();
}

function drawBaseThumb(canvas, source) {
  const ctx = canvas.getContext("2d");
  const scale = Math.max(canvas.width / source.width, canvas.height / source.height);
  const w = source.width * scale;
  const h = source.height * scale;
  ctx.drawImage(source, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

function drawLayerThumb(canvas, layer) {
  const ctx = canvas.getContext("2d");
  if (!layer.canvas) return;
  const scale = Math.min(canvas.width / layer.canvas.width, canvas.height / layer.canvas.height);
  const w = Math.max(1, layer.canvas.width * scale);
  const h = Math.max(1, layer.canvas.height * scale);
  ctx.drawImage(layer.canvas, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

function makeThumb(source) {
  const canvas = document.createElement("canvas");
  canvas.width = 40;
  canvas.height = 40;
  drawBaseThumb(canvas, source);
  return canvas;
}

function renderLayerList() {
  layerList.replaceChildren();
  if (!editor.base) {
    layerList.append(el("li", "layer-empty", "Lapisan objek akan muncul di sini setelah foto dibuka."));
    return;
  }

  const baseRow = el("li", `layer-row${editor.selected === "base" ? " active" : ""}`);
  const baseThumb = el("div", "layer-thumb");
  baseThumb.append(makeThumb(editor.base));
  const baseMeta = el("div", "layer-meta");
  baseMeta.append(
    el("span", "layer-name", "Background foto"),
    el("span", "layer-sub", `${editor.base.width} × ${editor.base.height} · diisi otomatis`)
  );
  baseRow.append(baseThumb, baseMeta);
  baseRow.addEventListener("click", () => editor.select("base"));
  layerList.append(baseRow);

  for (let index = editor.layers.length - 1; index >= 0; index -= 1) {
    const layer = editor.layers[index];
    const row = el("li", `layer-row${editor.selected === layer ? " active" : ""}${layer.visible ? "" : " hidden-layer"}`);
    const thumb = el("div", "layer-thumb");
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 40;
    drawLayerThumb(canvas, layer);
    thumb.append(canvas);

    const meta = el("div", "layer-meta");
    const subtitle = layer.kind === "text" ? `Teks · ${Math.round(layer.fontSize)}px` : `Objek · ${Math.round(layer.scale * 100)}%`;
    meta.append(el("span", "layer-name", layer.name), el("span", "layer-sub", subtitle));

    const eye = el("button", "icon-btn");
    eye.type = "button";
    eye.title = layer.visible ? "Sembunyikan" : "Tampilkan";
    eye.append(svg(layer.visible ? ICONS.eye : ICONS.eyeOff));
    eye.addEventListener("click", (event) => {
      event.stopPropagation();
      editor.toggleVisibility(layer);
    });

    const remove = el("button", "icon-btn danger");
    remove.type = "button";
    remove.title = "Hapus lapisan";
    remove.append(svg(ICONS.trash));
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      editor.deleteLayer(layer);
    });

    row.append(thumb, meta, eye, remove);
    row.addEventListener("click", () => editor.select(layer));
    layerList.append(row);
  }
}

/* ---------------- properties ---------------- */

function group(labelText, ...children) {
  const wrapper = el("div", "prop-group");
  if (labelText) wrapper.append(el("span", "prop-label", labelText));
  for (const child of children) wrapper.append(child);
  return wrapper;
}

function sliderProperty(layer, labelText, { min, max, step, value, format, apply, key }) {
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const out = el("span", "slider-val", format(value));
  input.addEventListener("input", () => {
    const numeric = Number(input.value);
    out.textContent = format(numeric);
    editor.mutateLayer(layer, (target) => apply(target, numeric), key);
  });
  const row = el("div", "prop-row");
  row.append(input, out);
  return group(labelText, row);
}

function segmented(layer, options, key) {
  const wrapper = el("div", "seg");
  for (const option of options) {
    const button = el("button", option.active ? "on" : "", option.label);
    button.type = "button";
    button.addEventListener("click", () => {
      editor.mutateLayer(layer, option.apply, key);
    });
    wrapper.append(button);
  }
  return wrapper;
}

function actionButton(labelText, onClick, { danger = false } = {}) {
  const button = el("button", `btn${danger ? " danger" : " ghost"}`, labelText);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function orderButtons(layer) {
  const row = el("div", "prop-row");
  row.append(
    actionButton("▲ Naik", () => editor.moveLayer(layer, 1)),
    actionButton("▼ Turun", () => editor.moveLayer(layer, -1))
  );
  return group("Urutan lapisan", row);
}

function renderProps() {
  const selection = editor.selected;
  const key = selection === "base" ? "base" : selection?.id || "none";
  const active = document.activeElement;
  const editingProps =
    active &&
    active.closest("#props") &&
    (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");
  if (editingProps && key === lastPropsKey) return;
  lastPropsKey = key;
  props.replaceChildren();

  if (!selection) {
    props.append(el("p", "props-empty", "Klik lapisan di daftar atau objek di kanvas untuk mengatur propertinya."));
    return;
  }

  if (selection === "base") {
    props.append(el("div", "props-title", "Background foto"));
    const info = el("div", "prop-group");
    info.append(
      el("span", "prop-label", "Info"),
      el("p", "hint", `${editor.base.width} × ${editor.base.height}px · ${editor.layers.length} lapisan objek. Bagian yang dihapus atau dipisah sudah diisi ulang di background ini.`)
    );
    props.append(info);

    const actions = el("div", "props-actions");
    const splitButton = el("button", "btn ghost", "Pecah otomatis");
    splitButton.type = "button";
    splitButton.addEventListener("click", () => editor.splitAutomatically());
    const aiButton = el("button", "btn ghost", "Pisah subjek (AI)");
    aiButton.type = "button";
    aiButton.addEventListener("click", () => editor.splitWithAI());
    const openButton = el("button", "btn ghost", "Buka foto lain");
    openButton.type = "button";
    openButton.addEventListener("click", () => filePhoto.click());
    actions.append(splitButton, aiButton, openButton);
    props.append(actions);
    return;
  }

  const layer = selection;
  props.append(el("div", "props-title", layer.kind === "text" ? "Properti teks" : "Properti objek"));

  if (layer.kind === "text") {
    const textarea = document.createElement("textarea");
    textarea.value = layer.text;
    textarea.placeholder = "Tulis teks…";
    textarea.addEventListener("input", () => {
      editor.mutateLayer(layer, (target) => {
        target.text = textarea.value;
      }, `text:${layer.id}:content`);
    });
    props.append(group("Isi teks", textarea));

    const select = document.createElement("select");
    for (const font of FONTS) {
      const option = document.createElement("option");
      option.value = font;
      option.textContent = font;
      option.selected = font === layer.fontFamily;
      select.append(option);
    }
    select.addEventListener("change", () => {
      editor.mutateLayer(layer, (target) => {
        target.fontFamily = select.value;
      }, `text:${layer.id}:font`);
    });
    props.append(group("Font", select));

    const sizeInput = document.createElement("input");
    sizeInput.type = "number";
    sizeInput.min = "8";
    sizeInput.max = "500";
    sizeInput.step = "1";
    sizeInput.value = String(Math.round(layer.fontSize));
    sizeInput.addEventListener("input", () => {
      const numeric = Number(sizeInput.value);
      if (!Number.isFinite(numeric)) return;
      editor.mutateLayer(layer, (target) => {
        target.fontSize = clamp(numeric, 8, 500);
      }, `text:${layer.id}:size`);
    });
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = layer.color;
    colorInput.addEventListener("input", () => {
      editor.mutateLayer(layer, (target) => {
        target.color = colorInput.value;
      }, `text:${layer.id}:color`);
    });
    const sizeRow = el("div", "prop-row");
    sizeRow.append(sizeInput, colorInput);
    props.append(group("Ukuran & warna", sizeRow));

    props.append(group(
      "Gaya",
      segmented(layer, [
        { label: "B", active: layer.bold, apply: (target) => { target.bold = !target.bold; } },
        { label: "I", active: layer.italic, apply: (target) => { target.italic = !target.italic; } },
        { label: layer.shadow ? "Bayangan ✓" : "Bayangan", active: layer.shadow, apply: (target) => { target.shadow = !target.shadow; } },
      ], `text:${layer.id}:style`),
      segmented(layer, [
        { label: "Kiri", active: layer.align === "left", apply: (target) => { target.align = "left"; } },
        { label: "Tengah", active: layer.align === "center", apply: (target) => { target.align = "center"; } },
        { label: "Kanan", active: layer.align === "right", apply: (target) => { target.align = "right"; } },
      ], `text:${layer.id}:align`)
    ));

    props.append(sliderProperty(layer, "Rotasi", {
      min: -180, max: 180, step: 1,
      value: Math.round((layer.rotation * 180) / Math.PI),
      format: (value) => `${Math.round(value)}°`,
      apply: (target, value) => { target.rotation = (value * Math.PI) / 180; },
      key: `text:${layer.id}:rotation`,
    }));

    props.append(sliderProperty(layer, "Opasitas", {
      min: 10, max: 100, step: 1,
      value: Math.round(layer.opacity * 100),
      format: (value) => `${Math.round(value)}%`,
      apply: (target, value) => { target.opacity = value / 100; },
      key: `text:${layer.id}:opacity`,
    }));
  } else {
    props.append(sliderProperty(layer, "Skala", {
      min: 5, max: 300, step: 1,
      value: Math.round(layer.scale * 100),
      format: (value) => `${Math.round(value)}%`,
      apply: (target, value) => { target.scale = value / 100; },
      key: `image:${layer.id}:scale`,
    }));
    props.append(sliderProperty(layer, "Rotasi", {
      min: -180, max: 180, step: 1,
      value: Math.round((layer.rotation * 180) / Math.PI),
      format: (value) => `${Math.round(value)}°`,
      apply: (target, value) => { target.rotation = (value * Math.PI) / 180; },
      key: `image:${layer.id}:rotation`,
    }));
    props.append(sliderProperty(layer, "Opasitas", {
      min: 10, max: 100, step: 1,
      value: Math.round(layer.opacity * 100),
      format: (value) => `${Math.round(value)}%`,
      apply: (target, value) => { target.opacity = value / 100; },
      key: `image:${layer.id}:opacity`,
    }));
    props.append(el("p", "hint", "Objek ini terpisah dari background. Hapus lapisan untuk menghilangkannya — background di belakangnya sudah diisi."));
  }

  props.append(orderButtons(layer));
  const actions = el("div", "props-actions");
  actions.append(
    actionButton(layer.kind === "text" ? "Hapus teks" : "Hapus objek", () => editor.deleteLayer(layer), { danger: true })
  );
  props.append(actions);
}

/* ---------------- tool options ---------------- */

function addHint(parent, text) {
  parent.append(el("span", "opt-hint", text));
}

function addDivider(parent) {
  parent.append(el("span", "opt-divider"));
}

function addAction(parent, label, action, { primary = false, ghost = false, disabled = false } = {}) {
  const button = el("button", `btn small${primary ? " primary" : ghost ? " ghost" : ""}`, label);
  button.type = "button";
  button.dataset.action = action;
  button.disabled = disabled || editor.busy;
  parent.append(button);
  return button;
}

function addSliderControl(parent, labelText, { min, max, step, value, format, onInput }) {
  const wrap = el("div", "opt-group");
  wrap.append(el("span", "opt-label", labelText));
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const out = el("span", "slider-val", format(value));
  input.addEventListener("input", () => {
    const numeric = Number(input.value);
    out.textContent = format(numeric);
    onInput(numeric);
  });
  wrap.append(input, out);
  parent.append(wrap);
}

function renderToolOptions() {
  toolOptions.replaceChildren();
  if (!editor.base) {
    addHint(toolOptions, "Buka foto dulu untuk mulai mengedit.");
    return;
  }

  if (editor.tool === "select") {
    if (editor.selected && editor.selected !== "base") {
      toolOptions.append(el("span", "opt-label", editor.selected.name));
      addDivider(toolOptions);
      addHint(toolOptions, "Seret untuk geser · tarik sudut untuk skala · titik atas untuk rotasi");
    } else {
      addHint(toolOptions, "Klik objek untuk memilih. Seret ruang kosong untuk menggeser kanvas.");
    }
    return;
  }

  if (editor.tool === "text") {
    addAction(toolOptions, "+ Tambah Teks", "addText", { primary: true });
    addHint(toolOptions, "atau klik kanvas untuk menaruh teks di titik itu");
    return;
  }

  if (editor.tool === "sticker") {
    addAction(toolOptions, "Buka Stiker", "openStickers", { primary: true });
    addHint(toolOptions, "Pilih emoji / unggah PNG di panel kanan");
    return;
  }

  if (editor.tool === "erase") {
    addSliderControl(toolOptions, "Kuas", {
      min: 8, max: 220, step: 2,
      value: editor.brushSize,
      format: (value) => `${Math.round(value)}px`,
      onInput: (value) => {
        editor.brushSize = value;
      },
    });
    addDivider(toolOptions);
    addAction(toolOptions, "Isi & Hapus", "eraseApply", { primary: true, disabled: !editor.maskDirty });
    addAction(toolOptions, "Bersihkan", "eraseClear", { ghost: true, disabled: !editor.maskDirty });
    addHint(toolOptions, "Coret orang, hewan, teks, atau objek yang mengganggu");
    return;
  }

  if (editor.tool === "wand") {
    addSliderControl(toolOptions, "Toleransi", {
      min: 5, max: 90, step: 1,
      value: editor.tolerance,
      format: (value) => `${Math.round(value)}%`,
      onInput: (value) => {
        editor.tolerance = value;
      },
    });
    addDivider(toolOptions);
    if (editor.selection) {
      addAction(toolOptions, "Jadikan Lapisan", "wandLift", { primary: true });
      addAction(toolOptions, "Isi & Hapus", "wandErase");
      addAction(toolOptions, "Batal", "wandCancel", { ghost: true });
    } else {
      addHint(toolOptions, "Klik area warna untuk memilih (langit, papan, objek)");
    }
    return;
  }

  if (editor.tool === "split") {
    addAction(toolOptions, "Pecah Otomatis", "runSplit", { primary: true });
    addAction(toolOptions, "AI Subjek", "runAI", { ghost: true });
    addHint(toolOptions, "Offline berbasis warna · AI lebih presisi (unduh model sekali)");
  }
}

/* ---------------- event wiring ---------------- */

$$(".tool[data-tool]").forEach((button) => {
  button.addEventListener("click", () => editor.setTool(button.dataset.tool));
});

btnAI.addEventListener("click", async () => {
  if (!editor.base) {
    toast("Buka foto dulu.", "warn");
    return;
  }
  await editor.splitWithAI();
});

toolOptions.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "addText") editor.addTextLayer();
  else if (action === "openStickers") openAddPanel();
  else if (action === "eraseApply") await editor.applyErase();
  else if (action === "eraseClear") editor.clearMask();
  else if (action === "wandLift") await editor.liftSelection();
  else if (action === "wandErase") await editor.applySelectionErase();
  else if (action === "wandCancel") editor.discardSelection();
  else if (action === "runSplit") await editor.splitAutomatically();
  else if (action === "runAI") await editor.splitWithAI();
});

$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

$("#btnLayers").addEventListener("click", () => sidebar.classList.add("open"));
$("#btnCloseSidebar").addEventListener("click", () => sidebar.classList.remove("open"));

qualityList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-quality]");
  if (!button) return;
  saveQuality = Number(button.dataset.quality);
  refreshSaveQuality();
});

enhanceRange.addEventListener("input", () => {
  enhanceValue.textContent = `${enhanceRange.value}%`;
});

btnEnhance.addEventListener("click", async () => {
  await editor.autoEnhance(Number(enhanceRange.value) / 100);
});

btnExportHD.addEventListener("click", () => openExport(saveQuality));

const openPhoto = () => filePhoto.click();
btnOpen.addEventListener("click", openPhoto);
$("#btnOpenEmpty").addEventListener("click", openPhoto);
$("#btnSample").addEventListener("click", loadSample);
$("#btnUploadSticker").addEventListener("click", () => fileSticker.click());
$("#btnAddText").addEventListener("click", () => editor.addTextLayer());

filePhoto.addEventListener("change", () => {
  const file = filePhoto.files?.[0];
  if (file) loadPhotoFile(file);
});
fileSticker.addEventListener("change", () => {
  const file = fileSticker.files?.[0];
  if (file) loadStickerFile(file);
});

btnUndo.addEventListener("click", () => editor.undo());
btnRedo.addEventListener("click", () => editor.redo());
btnZoomIn.addEventListener("click", () => editor.zoomBy(1.25));
btnZoomOut.addEventListener("click", () => editor.zoomBy(0.8));
btnZoomFit.addEventListener("click", () => editor.fit());

const stopCompare = () => editor.setShowOriginal(false);
btnCompare.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  if (!editor.base) return;
  editor.setShowOriginal(true);
});
btnCompare.addEventListener("pointerup", stopCompare);
btnCompare.addEventListener("pointerleave", stopCompare);
btnCompare.addEventListener("pointercancel", stopCompare);
window.addEventListener("pointerup", stopCompare);
window.addEventListener("blur", stopCompare);

btnExport.addEventListener("click", () => openExport(saveQuality));
$("#btnCloseExport").addEventListener("click", closeExport);
$("#btnExportClose2").addEventListener("click", closeExport);
exportModal.addEventListener("click", (event) => {
  if (event.target === exportModal) closeExport();
});
btnDownload.addEventListener("click", saveResult);

exportQuality.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-quality]");
  if (!button || exportModal.hidden) return;
  const longEdge = Number(button.dataset.quality);
  if (longEdge === saveQuality && currentResult) return;
  saveQuality = longEdge;
  refreshSaveQuality();
  renderExport(longEdge);
});

/* ---------------- sticker grid ---------------- */

function buildStickerGrid() {
  const grid = $("#stickerGrid");
  for (const emoji of STICKERS) {
    const button = el("button", "sticker-btn", emoji);
    button.type = "button";
    button.title = `Tambah stiker ${emoji}`;
    button.addEventListener("click", () => editor.addStickerEmoji(emoji));
    grid.append(button);
  }
}

/* ---------------- photo / sticker loading ---------------- */

async function loadPhotoFile(file) {
  if (!file.type.startsWith("image/")) {
    toast("File harus berupa gambar.", "err");
    return;
  }
  showStageSkeleton("Membaca foto…");
  await nextFrame();
  try {
    const image = await fileToImage(file);
    showStageSkeleton("Menyiapkan kanvas…");
    await nextFrame();
    await editor.loadFromImage(image, file.name);
    switchTab("layers");
  } catch (error) {
    console.error(error);
    toast("Gagal membuka foto.", "err");
  } finally {
    hideStageSkeleton();
    filePhoto.value = "";
  }
}

async function loadStickerFile(file) {
  if (!file.type.startsWith("image/")) {
    toast("File harus berupa gambar.", "err");
    return;
  }
  try {
    const image = await fileToImage(file);
    editor.addStickerFromImage(image, file.name.replace(/\.[^.]+$/, ""));
  } catch (error) {
    console.error(error);
    toast("Gagal memuat objek.", "err");
  } finally {
    fileSticker.value = "";
  }
}

async function loadSample() {
  showStageSkeleton("Memuat foto contoh…");
  await nextFrame();
  try {
    toast("Memuat foto contoh…");
    const response = await fetch("assets/sample.png");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    try {
      const image = await loadImage(url);
      await editor.loadFromImage(image, "Nimp Beach (contoh)");
      toast("Coba: Pecah otomatis, AI Subjek, atau kuas hapus.");
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    console.error(error);
    toast("Foto contoh gagal dimuat. Buka foto dari perangkat.", "err");
  } finally {
    hideStageSkeleton();
  }
}

/* ---------------- export & HD ---------------- */

function setPreviewLoading(loading, label) {
  previewSkeleton.hidden = !loading;
  resultPreview.classList.toggle("loading", loading);
  if (label) previewSkeletonLabel.textContent = label;
  if (loading) resultImg.hidden = true;
}

function setExportQualityUI(longEdge) {
  exportQuality.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("on", Number(button.dataset.quality) === longEdge);
  });
  const nativeLong = editor.base ? Math.max(editor.base.width, editor.base.height) : 0;
  if (!longEdge) {
    qualityNote.textContent = "ukuran asli";
  } else if (nativeLong && longEdge > nativeLong + 2) {
    qualityNote.textContent = `${qualityName(longEdge)} · upscale ${(longEdge / nativeLong).toFixed(2)}×`;
  } else {
    qualityNote.textContent = qualityName(longEdge);
  }
}

function fillResultMeta(result, longEdge) {
  const dims = el("span");
  dims.append(el("strong", "", "Dimensi "), document.createTextNode(`${result.width} × ${result.height}px`));
  const size = el("span");
  size.append(el("strong", "", "Ukuran "), document.createTextNode(formatBytes(result.blob.size)));
  const layers = el("span");
  layers.append(el("strong", "", "Lapisan "), document.createTextNode(String(result.layers)));
  const quality = el("span", "", `${qualityName(longEdge)}${longEdge ? " · HD" : ""}`);
  resultMeta.replaceChildren(dims, size, layers, quality);
}

async function renderExport(longEdge = saveQuality) {
  if (!editor.base) return;
  const seq = ++exportSeq;
  const size = outputSize(longEdge);
  if (!size) return;
  setExportQualityUI(longEdge);
  setPreviewLoading(
    true,
    longEdge ? `Merender ${qualityName(longEdge)} · ${size.width} × ${size.height}…` : "Menyiapkan hasil…"
  );
  btnDownload.disabled = true;
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
  currentResult = null;
  resultMeta.replaceChildren();
  await nextFrame();

  try {
    const result = await editor.exportPNG({ longEdge });
    if (seq !== exportSeq) return;
    if (!result) throw new Error("Hasil kosong");

    resultUrl = URL.createObjectURL(result.blob);
    currentResult = result;
    const loaded = new Promise((resolve) => {
      resultImg.onload = resolve;
      resultImg.onerror = resolve;
    });
    resultImg.src = resultUrl;
    resultImg.hidden = false;
    await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 2500))]);
    if (seq !== exportSeq) return;

    setPreviewLoading(false);
    fillResultMeta(result, longEdge);
    btnDownload.disabled = false;
  } catch (error) {
    console.error(error);
    if (seq === exportSeq) {
      setPreviewLoading(false);
      toast("Gagal membuat hasil akhir.", "err");
    }
  } finally {
    if (seq === exportSeq) {
      btnExport.disabled = !editor.base || !exportModal.hidden;
      refreshSaveQuality();
    }
  }
}

async function openExport(longEdge = saveQuality) {
  if (!editor.base) return;
  saveQuality = longEdge;
  refreshSaveQuality();
  btnExport.disabled = true;
  exportModal.hidden = false;
  await renderExport(longEdge);
}

function closeExport() {
  exportSeq += 1;
  exportModal.hidden = true;
  setPreviewLoading(false);
  resultImg.removeAttribute("src");
  resultImg.hidden = false;
  resultMeta.replaceChildren();
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
  currentResult = null;
  btnDownload.disabled = true;
  btnExport.disabled = !editor.base;
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Gagal membaca gambar"));
    reader.readAsDataURL(blob);
  });
}

async function saveResult() {
  if (!currentResult) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `nimp-editphoto-${stamp}.png`;
  const bridge = window.NimpAndroid;
  if (bridge && typeof bridge.saveImage === "function") {
    btnDownload.disabled = true;
    try {
      const dataUrl = await blobToDataURL(currentResult.blob);
      const answer = bridge.saveImage(dataUrl, filename);
      toast(typeof answer === "string" && answer ? answer : "Foto disimpan ke Galeri.");
    } catch (error) {
      console.error(error);
      toast("Gagal menyimpan ke Galeri.", "err");
    } finally {
      btnDownload.disabled = false;
    }
    return;
  }
  downloadBlob(currentResult.blob, filename);
  toast("Hasil diunduh sebagai PNG.");
}

/* ---------------- drag & drop ---------------- */

stage.addEventListener("dragenter", (event) => {
  event.preventDefault();
  draggingDepth += 1;
  stage.classList.add("drop-active");
});
stage.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
stage.addEventListener("dragleave", (event) => {
  event.preventDefault();
  draggingDepth = Math.max(0, draggingDepth - 1);
  if (!draggingDepth) stage.classList.remove("drop-active");
});
stage.addEventListener("drop", async (event) => {
  event.preventDefault();
  draggingDepth = 0;
  stage.classList.remove("drop-active");
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    toast("Hanya file gambar yang bisa dijatuhkan.", "err");
    return;
  }
  if (!editor.base) {
    await loadPhotoFile(file);
  } else {
    await loadStickerFile(file);
  }
});

/* ---------------- keyboard ---------------- */

window.addEventListener("keydown", (event) => {
  const target = event.target;
  const typing =
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable);

  if (event.key === "Escape") {
    if (!exportModal.hidden) {
      closeExport();
      return;
    }
    if (typing) {
      target.blur();
      return;
    }
    if (editor.selection) editor.discardSelection();
    else if (editor.maskDirty) editor.clearMask();
    else editor.select(null);
    return;
  }

  if (typing) return;

  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "z") {
    event.preventDefault();
    if (event.shiftKey) editor.redo();
    else editor.undo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === "y") {
    event.preventDefault();
    editor.redo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === "o") {
    event.preventDefault();
    openPhoto();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === "Delete" || event.key === "Backspace") {
    if (editor.selected && editor.selected !== "base") {
      event.preventDefault();
      editor.deleteLayer(editor.selected);
    }
    return;
  }

  if (event.key === "[") {
    editor.brushSize = clamp(editor.brushSize - 6, 8, 220);
    renderToolOptions();
    return;
  }
  if (event.key === "]") {
    editor.brushSize = clamp(editor.brushSize + 6, 8, 220);
    renderToolOptions();
    return;
  }

  if (key === "v") editor.setTool("select");
  else if (key === "t") editor.setTool("text");
  else if (key === "s") editor.setTool("sticker");
  else if (key === "e") editor.setTool("erase");
  else if (key === "w") editor.setTool("wand");
  else if (key === "a") editor.setTool("split");
});

/* ---------------- Android shell ---------------- */

window.nimpAndroidBack = () => {
  if (!exportModal.hidden) {
    closeExport();
    return true;
  }
  if (sidebar.classList.contains("open")) {
    sidebar.classList.remove("open");
    return true;
  }
  if (editor.selection) {
    editor.discardSelection();
    return true;
  }
  if (editor.maskDirty) {
    editor.clearMask();
    return true;
  }
  if (editor.selected) {
    editor.select(null);
    return true;
  }
  return false;
};

/* ---------------- init ---------------- */

buildStickerGrid();
switchTab("layers");
syncUI();

// Akses editor untuk debugging & pengujian otomatis di browser.
window.nimpEditor = editor;
window.nimpUI = { toast, syncUI, loadSample, openExport, renderExport, saveResult, refreshSaveQuality };
