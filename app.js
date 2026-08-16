/* Ship PDF Studio — crop, merge & split PDFs entirely in the browser. */
"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const { PDFDocument } = PDFLib;

// ── State ───────────────────────────────────────────────────────────
// docs: [{ id, name, bytes(Uint8Array), pdf(pdfjs doc),
//          pages: [{ n, proxy, selected, crop:{x,y,w,h}|null }] }]
// crop is normalized to the page's viewport (0..1, top-left origin) so the
// same crop maps onto every page/document regardless of pixel size.
let docs = [];
let docSeq = 0;

const $ = (id) => document.getElementById(id);
const dropzone = $("dropzone");
const fileInput = $("fileInput");
const toolbar = $("toolbar");
const docsEl = $("docs");
const statusEl = $("status");

// ── File intake ─────────────────────────────────────────────────────
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") fileInput.click();
});
fileInput.addEventListener("change", () => {
  addFiles([...fileInput.files]);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "drop" || e.target === document.documentElement)
      dropzone.classList.remove("dragover");
  })
);
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])].filter(
    (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name)
  );
  if (files.length) addFiles(files);
});

async function addFiles(files) {
  for (const file of files) {
    if (!(file.type === "application/pdf" || /\.pdf$/i.test(file.name))) continue;
    setStatus(`Loading ${file.name}…`);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf).slice(); // keep a copy for pdf-lib
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const doc = { id: ++docSeq, name: file.name, bytes, pdf, pages: [] };
      for (let n = 1; n <= pdf.numPages; n++) {
        doc.pages.push({ n, proxy: await pdf.getPage(n), selected: true, crop: null });
      }
      docs.push(doc);
      renderDoc(doc);
    } catch (err) {
      console.error(err);
      toast(`Could not read "${file.name}" — is it a valid PDF?`);
    }
  }
  refreshUI();
}

// ── Rendering ───────────────────────────────────────────────────────
function refreshUI() {
  const any = docs.length > 0;
  toolbar.classList.toggle("hidden", !any);
  dropzone.classList.toggle("compact", any);
  const sel = selectedItems().length;
  const total = docs.reduce((s, d) => s + d.pages.length, 0);
  const cropped = docs.reduce((s, d) => s + d.pages.filter((p) => p.crop).length, 0);
  setStatus(
    any
      ? `${docs.length} doc${docs.length > 1 ? "s" : ""} · ${sel}/${total} pages selected` +
        (cropped ? ` · ${cropped} cropped` : "")
      : ""
  );
  $("btnMerge").disabled = sel === 0;
  $("btnSplit").disabled = sel === 0;
  $("btnPerDoc").disabled = sel === 0;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function renderDoc(doc) {
  const card = document.createElement("section");
  card.className = "doc-card";
  card.dataset.docId = doc.id;

  const head = document.createElement("div");
  head.className = "doc-head";
  head.innerHTML = `
    <span class="doc-name"></span>
    <span class="doc-meta">${doc.pages.length} page${doc.pages.length > 1 ? "s" : ""}</span>
    <div class="doc-tools">
      <button class="btn btn-sm" data-act="up" title="Move up in merge order">▲</button>
      <button class="btn btn-sm" data-act="down" title="Move down in merge order">▼</button>
      <button class="btn btn-sm" data-act="all">Select all</button>
      <button class="btn btn-sm" data-act="none">None</button>
      <button class="btn btn-sm btn-danger" data-act="remove">Remove</button>
    </div>`;
  head.querySelector(".doc-name").textContent = doc.name;
  head.addEventListener("click", (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    if (act === "remove") removeDoc(doc);
    else if (act === "up" || act === "down") moveDoc(doc, act === "up" ? -1 : 1);
    else {
      doc.pages.forEach((p) => (p.selected = act === "all"));
      card.querySelectorAll(".page-thumb").forEach((el, i) => updateThumbState(doc.pages[i], el));
      refreshUI();
    }
  });
  card.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "page-grid";
  card.appendChild(grid);
  docsEl.appendChild(card);

  doc.pages.forEach((page) => {
    const thumb = document.createElement("div");
    thumb.className = "page-thumb";
    thumb.innerHTML = `
      <div class="thumb-check on" title="Include page">✓</div>
      <div class="thumb-wrap"><canvas></canvas></div>
      <div class="thumb-label"></div>`;
    grid.appendChild(thumb);
    page.el = thumb;

    thumb.querySelector(".thumb-check").addEventListener("click", () => {
      page.selected = !page.selected;
      updateThumbState(page, thumb);
      refreshUI();
    });
    thumb.querySelector(".thumb-wrap").addEventListener("click", () => openCrop(doc, page));

    drawThumb(page, thumb.querySelector("canvas"));
    updateThumbState(page, thumb);
  });
}

async function drawThumb(page, canvas) {
  const vp1 = page.proxy.getViewport({ scale: 1 });
  const scale = 150 / vp1.width;
  const vp = page.proxy.getViewport({ scale });
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await page.proxy.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
}

function updateThumbState(page, thumb) {
  thumb.classList.toggle("deselected", !page.selected);
  thumb.querySelector(".thumb-check").classList.toggle("on", page.selected);
  const label = thumb.querySelector(".thumb-label");
  label.innerHTML = `p.${page.n}` + (page.crop ? ` · <span class="cropped-tag">cropped</span>` : "");
  let box = thumb.querySelector(".thumb-crop");
  if (page.crop) {
    if (!box) {
      box = document.createElement("div");
      box.className = "thumb-crop";
      thumb.querySelector(".thumb-wrap").appendChild(box);
    }
    const c = page.crop;
    box.style.left = c.x * 100 + "%";
    box.style.top = c.y * 100 + "%";
    box.style.width = c.w * 100 + "%";
    box.style.height = c.h * 100 + "%";
  } else if (box) {
    box.remove();
  }
}

function removeDoc(doc) {
  docs = docs.filter((d) => d !== doc);
  docsEl.querySelector(`[data-doc-id="${doc.id}"]`)?.remove();
  refreshUI();
}

function moveDoc(doc, delta) {
  const i = docs.indexOf(doc);
  const j = i + delta;
  if (j < 0 || j >= docs.length) return;
  [docs[i], docs[j]] = [docs[j], docs[i]];
  const card = docsEl.querySelector(`[data-doc-id="${doc.id}"]`);
  const other = docsEl.querySelector(`[data-doc-id="${docs[i].id}"]`);
  if (delta < 0) docsEl.insertBefore(card, other);
  else docsEl.insertBefore(other, card);
}

$("btnClear").addEventListener("click", () => {
  if (!docs.length || !confirm("Remove all loaded documents?")) return;
  docs = [];
  docsEl.innerHTML = "";
  refreshUI();
});

// ── Crop editor ─────────────────────────────────────────────────────
const cropModal = $("cropModal");
const cropCanvas = $("cropCanvas");
const cropRectEl = $("cropRect");
const cropStage = $("cropStage");
let cropCtx = null; // { doc, page, drag:{x,y}|null, rect:{x,y,w,h}|null (canvas px) }

async function openCrop(doc, page) {
  cropCtx = { doc, page, drag: null, rect: null };
  $("cropTitle").textContent = `Crop — ${doc.name} · page ${page.n}`;
  cropModal.classList.remove("hidden");

  const vp1 = page.proxy.getViewport({ scale: 1 });
  const maxW = Math.min(880, window.innerWidth - 90);
  const maxH = window.innerHeight * 0.62;
  const scale = Math.min(maxW / vp1.width, maxH / vp1.height);
  const vp = page.proxy.getViewport({ scale });
  cropCanvas.width = Math.ceil(vp.width);
  cropCanvas.height = Math.ceil(vp.height);
  cropCanvas.style.width = cropCanvas.width + "px";
  cropCanvas.style.height = cropCanvas.height + "px";
  await page.proxy.render({ canvasContext: cropCanvas.getContext("2d"), viewport: vp }).promise;

  if (page.crop) {
    cropCtx.rect = {
      x: page.crop.x * cropCanvas.width,
      y: page.crop.y * cropCanvas.height,
      w: page.crop.w * cropCanvas.width,
      h: page.crop.h * cropCanvas.height,
    };
  }
  drawCropRect();
}

function canvasPoint(e) {
  const r = cropCanvas.getBoundingClientRect();
  return {
    x: Math.min(Math.max(e.clientX - r.left, 0), r.width),
    y: Math.min(Math.max(e.clientY - r.top, 0), r.height),
  };
}

cropCanvas.addEventListener("pointerdown", (e) => {
  if (!cropCtx) return;
  cropCanvas.setPointerCapture(e.pointerId);
  cropCtx.drag = canvasPoint(e);
  cropCtx.rect = { ...cropCtx.drag, w: 0, h: 0 };
  drawCropRect();
});
cropCanvas.addEventListener("pointermove", (e) => {
  if (!cropCtx?.drag) return;
  const p = canvasPoint(e);
  const d = cropCtx.drag;
  cropCtx.rect = {
    x: Math.min(d.x, p.x),
    y: Math.min(d.y, p.y),
    w: Math.abs(p.x - d.x),
    h: Math.abs(p.y - d.y),
  };
  drawCropRect();
});
cropCanvas.addEventListener("pointerup", () => {
  if (!cropCtx) return;
  cropCtx.drag = null;
  if (cropCtx.rect && (cropCtx.rect.w < 8 || cropCtx.rect.h < 8)) {
    cropCtx.rect = null;
    drawCropRect();
  }
});

function drawCropRect() {
  const r = cropCtx?.rect;
  if (!r || r.w <= 0 || r.h <= 0) {
    cropRectEl.classList.add("hidden");
    $("cropDims").textContent = "Drag on the page to draw a crop box";
    return;
  }
  // Position relative to the stage (canvas may be centered/scrolled).
  const cr = cropCanvas.getBoundingClientRect();
  const sr = cropStage.getBoundingClientRect();
  cropRectEl.style.left = cr.left - sr.left + cropStage.scrollLeft + r.x + "px";
  cropRectEl.style.top = cr.top - sr.top + cropStage.scrollTop + r.y + "px";
  cropRectEl.style.width = r.w + "px";
  cropRectEl.style.height = r.h + "px";
  cropRectEl.classList.remove("hidden");

  const vp1 = cropCtx.page.proxy.getViewport({ scale: 1 });
  const wPt = (r.w / cropCanvas.width) * vp1.width;
  const hPt = (r.h / cropCanvas.height) * vp1.height;
  $("cropDims").textContent =
    `${(wPt / 72).toFixed(2)}″ × ${(hPt / 72).toFixed(2)}″  (${Math.round(wPt)} × ${Math.round(hPt)} pt)`;
}

function currentNormRect() {
  const r = cropCtx?.rect;
  if (!r || r.w < 8 || r.h < 8) return null;
  return {
    x: r.x / cropCanvas.width,
    y: r.y / cropCanvas.height,
    w: r.w / cropCanvas.width,
    h: r.h / cropCanvas.height,
  };
}

function applyCrop(scope) {
  const norm = currentNormRect();
  if (!norm) {
    toast("Draw a crop box first — click and drag on the page.");
    return;
  }
  const targets =
    scope === "page" ? [cropCtx.page]
    : scope === "doc" ? cropCtx.doc.pages
    : docs.flatMap((d) => d.pages);
  targets.forEach((p) => (p.crop = { ...norm }));
  docs.forEach((d) => d.pages.forEach((p) => p.el && updateThumbState(p, p.el)));
  refreshUI();
  closeCrop();
  targets.forEach((p) => p.el && flashThumb(p.el));
  toast(`✓ Crop applied to ${targets.length} page${targets.length > 1 ? "s" : ""}`);
}

$("cropApplyPage").addEventListener("click", () => applyCrop("page"));
$("cropApplyDoc").addEventListener("click", () => applyCrop("doc"));
$("cropApplyAll").addEventListener("click", () => applyCrop("all"));
$("cropClearPage").addEventListener("click", () => {
  cropCtx.page.crop = null;
  cropCtx.rect = null;
  updateThumbState(cropCtx.page, cropCtx.page.el);
  drawCropRect();
  refreshUI();
});
$("cropClearAll").addEventListener("click", () => {
  docs.forEach((d) => d.pages.forEach((p) => {
    p.crop = null;
    p.el && updateThumbState(p, p.el);
  }));
  cropCtx.rect = null;
  drawCropRect();
  refreshUI();
});
$("cropClose").addEventListener("click", closeCrop);
cropModal.addEventListener("click", (e) => {
  if (e.target === cropModal) closeCrop();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCrop();
});

function closeCrop() {
  cropModal.classList.add("hidden");
  cropRectEl.classList.add("hidden");
  cropCtx = null;
}

// ── Export ──────────────────────────────────────────────────────────
function selectedItems() {
  return docs.flatMap((doc) => doc.pages.filter((p) => p.selected).map((page) => ({ doc, page })));
}

// Convert the normalized (viewport, top-left) crop into PDF user-space
// via pdf.js, which accounts for page rotation and origin offsets.
function cropToPdfBox(page) {
  const c = page.crop;
  const vp = page.proxy.getViewport({ scale: 1 });
  const [x1, y1] = vp.convertToPdfPoint(c.x * vp.width, c.y * vp.height);
  const [x2, y2] = vp.convertToPdfPoint((c.x + c.w) * vp.width, (c.y + c.h) * vp.height);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

// items: [{doc, pageIdx, box|null}] — box is a resolved PDF-space crop, captured
// at the moment the page was queued, so later edits/removals can't change it.
async function buildPdf(items) {
  const out = await PDFDocument.create();
  const libCache = new Map();
  for (const { doc, pageIdx, box } of items) {
    if (!libCache.has(doc.id))
      libCache.set(doc.id, await PDFDocument.load(doc.bytes, { ignoreEncryption: true }));
    const [copied] = await out.copyPages(libCache.get(doc.id), [pageIdx]);
    if (box) {
      copied.setMediaBox(box.x, box.y, box.w, box.h);
      copied.setCropBox(box.x, box.y, box.w, box.h);
    }
    out.addPage(copied);
  }
  return out.save();
}

function toEntry({ doc, page }) {
  return { doc, pageIdx: page.n - 1, box: page.crop ? cropToPdfBox(page) : null };
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function outBase() {
  return ($("outName").value.trim() || "output").replace(/\.pdf$/i, "");
}

async function withBusy(btn, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Working…";
  try {
    await fn();
  } catch (err) {
    console.error(err);
    toast("Something went wrong: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    refreshUI();
  }
}

// ── Output tray ─────────────────────────────────────────────────────
// "Merge Selected → Output" queues pages here; nothing downloads until the
// user hits Download / Share. Queued entries keep their own bytes + crop box,
// so you can clear docs, load new ones, and keep adding.
let output = [];

function updateOutputBar() {
  $("outputBar").classList.toggle("hidden", output.length === 0);
  $("outCount").textContent = `${output.length} page${output.length === 1 ? "" : "s"}`;
}

$("btnMerge").addEventListener("click", () => {
  const items = selectedItems();
  if (!items.length) return;
  items.forEach((it) => output.push(toEntry(it)));
  updateOutputBar();
  pulse($("outputBar"));
  flashButton($("btnMerge"), "✓ Added to output");
  items.forEach(({ page }) => page.el && flashThumb(page.el));
  toast(`✓ ${items.length} page${items.length > 1 ? "s" : ""} merged into output — ` +
    `add more PDFs or hit Download / Share when you're done`);
});

$("btnDownload").addEventListener("click", (e) =>
  withBusy(e.target, async () => {
    if (!output.length) return;
    const name = `${outBase()}.pdf`;
    download(await buildPdf(output), name);
    pulse($("outputBar"));
    toast(`✓ Merge complete — ${output.length} page${output.length > 1 ? "s" : ""} in ${name}`);
  })
);

$("btnOutClear").addEventListener("click", () => {
  output = [];
  updateOutputBar();
  toast("Output emptied.");
});

$("btnSplit").addEventListener("click", (e) =>
  withBusy(e.target, async () => {
    const items = selectedItems();
    for (let i = 0; i < items.length; i++) {
      const { doc, page } = items[i];
      const base = doc.name.replace(/\.pdf$/i, "");
      download(await buildPdf([toEntry(items[i])]), `${base}-p${page.n}.pdf`);
      await new Promise((r) => setTimeout(r, 350)); // let the browser queue each download
    }
  })
);

$("btnPerDoc").addEventListener("click", (e) =>
  withBusy(e.target, async () => {
    for (const doc of docs) {
      const items = doc.pages.filter((p) => p.selected).map((page) => ({ doc, page }));
      if (!items.length) continue;
      download(await buildPdf(items.map(toEntry)), doc.name.replace(/\.pdf$/i, "") + "-edited.pdf");
      await new Promise((r) => setTimeout(r, 350));
    }
  })
);

// ── Completion feedback ─────────────────────────────────────────────
function flashThumb(el) {
  el.classList.remove("flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("flash");
  el.addEventListener("animationend", () => el.classList.remove("flash"), { once: true });
}

function pulse(el) {
  el.classList.remove("pulse");
  void el.offsetWidth;
  el.classList.add("pulse");
  el.addEventListener("animationend", () => el.classList.remove("pulse"), { once: true });
}

function flashButton(btn, label) {
  if (btn.dataset.flashing) return;
  const old = btn.textContent;
  btn.dataset.flashing = "1";
  btn.textContent = label;
  setTimeout(() => {
    btn.textContent = old;
    delete btn.dataset.flashing;
  }, 1200);
}

let toastTimer;
function toast(msg, ms = 4200) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}
