/* Ship PDF Studio — splice lab: crop, merge & split PDFs in the browser. */
"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const { PDFDocument } = PDFLib;

const GOLD = "#d9b544";
const GOLD_BRIGHT = "#f4d878";
const SILVER = "#c9d4e3";

// ── State ───────────────────────────────────────────────────────────
// docs: [{ id, name, bytes(Uint8Array), pdf(pdfjs doc), spliced,
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

const reducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
      await addBytesAsDoc(new Uint8Array(buf).slice(), file.name);
    } catch (err) {
      console.error(err);
      toast(`Could not read "${file.name}" — is it a valid PDF?`);
    }
  }
  refreshUI();
}

async function addBytesAsDoc(bytes, name, opts = {}) {
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice().buffer }).promise;
  const doc = { id: ++docSeq, name, bytes, pdf, spliced: !!opts.spliced, pages: [] };
  for (let n = 1; n <= pdf.numPages; n++) {
    doc.pages.push({ n, proxy: await pdf.getPage(n), selected: true, crop: null });
  }
  docs.push(doc);
  renderDoc(doc);
  return doc;
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
      ? `${docs.length} strand${docs.length > 1 ? "s" : ""} · ${sel}/${total} pages` +
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
  card.className = "doc-card" + (doc.spliced ? " spliced" : "");
  card.dataset.docId = doc.id;

  const head = document.createElement("div");
  head.className = "doc-head";
  head.innerHTML = `
    ${doc.spliced ? '<span class="spliced-badge">&#10038; SPLICED STRAND</span>' : ""}
    <span class="doc-name"></span>
    <span class="doc-meta">${doc.pages.length} page${doc.pages.length > 1 ? "s" : ""}</span>
    <div class="doc-tools">
      ${doc.spliced ? '<button class="btn btn-sm btn-gold" data-act="download">Download PDF</button>' : ""}
      <button class="btn btn-sm" data-act="up" title="Move up in splice order">&#9650;</button>
      <button class="btn btn-sm" data-act="down" title="Move down in splice order">&#9660;</button>
      <button class="btn btn-sm" data-act="all">Select all</button>
      <button class="btn btn-sm" data-act="none">None</button>
      <button class="btn btn-sm btn-danger" data-act="remove">Remove</button>
    </div>`;
  head.querySelector(".doc-name").textContent = doc.name;
  head.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    const act = btn?.dataset.act;
    if (!act) return;
    if (act === "download") {
      withBusy(btn, async () => {
        download(doc.bytes, doc.name);
        toast(`✓ ${doc.name} downloaded`);
      });
    } else if (act === "remove") removeDoc(doc);
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

    drawThumb(page);
    updateThumbState(page, thumb);
  });
}

// Render the page thumbnail. When a crop is set, the thumbnail shows the
// EDITED preview — only the cropped region, exactly what will be exported.
async function drawThumb(page) {
  const canvas = page.el.querySelector("canvas");
  const cropKey = page.crop ? JSON.stringify(page.crop) : "";
  if (page.renderedCrop === cropKey && canvas.width > 1) return;
  page.renderedCrop = cropKey;

  const vp1 = page.proxy.getViewport({ scale: 1 });
  const c = page.crop || { x: 0, y: 0, w: 1, h: 1 };
  // scale so the visible (cropped) region is ~200px wide
  const scale = 200 / (vp1.width * c.w);
  const vp = page.proxy.getViewport({ scale });
  const full = document.createElement("canvas");
  full.width = Math.ceil(vp.width);
  full.height = Math.ceil(vp.height);
  await page.proxy.render({ canvasContext: full.getContext("2d"), viewport: vp }).promise;

  const sx = Math.floor(c.x * full.width);
  const sy = Math.floor(c.y * full.height);
  const sw = Math.max(1, Math.floor(c.w * full.width));
  const sh = Math.max(1, Math.floor(c.h * full.height));
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext("2d").drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
}

function updateThumbState(page, thumb) {
  thumb.classList.toggle("deselected", !page.selected);
  thumb.querySelector(".thumb-check").classList.toggle("on", page.selected);
  const label = thumb.querySelector(".thumb-label");
  if (page.crop) {
    const vp1 = page.proxy.getViewport({ scale: 1 });
    const wIn = ((page.crop.w * vp1.width) / 72).toFixed(1);
    const hIn = ((page.crop.h * vp1.height) / 72).toFixed(1);
    label.innerHTML = `p.${page.n} · <span class="cropped-tag">✂ ${wIn}×${hIn}″</span>`;
  } else {
    label.textContent = `p.${page.n}`;
  }
  drawThumb(page);
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
  toast(`✓ Crop applied to ${targets.length} page${targets.length > 1 ? "s" : ""} — previews updated`);
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

// items: [{doc, pageIdx, box|null}] — box is a resolved PDF-space crop.
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

// ── Splice & Merge: the DNA moment ──────────────────────────────────
// Selected pages are spliced into ONE new strand that replaces every source
// document. It stays in the lab as a single card — download it from there,
// or load more PDFs and splice again.
$("btnMerge").addEventListener("click", (e) =>
  withBusy(e.target, async () => {
    const items = selectedItems();
    if (!items.length) return;
    const entries = items.map(toEntry);
    const name = `${outBase()}.pdf`;
    const animation = spliceAnimation(docs.length);
    const bytes = await buildPdf(entries);
    await animation;
    docs = [];
    docsEl.innerHTML = "";
    const doc = await addBytesAsDoc(bytes, name, { spliced: true });
    refreshUI();
    toast(`✓ Splice complete — ${doc.pages.length} page${doc.pages.length > 1 ? "s" : ""} in one strand. ` +
      `Download it, or load more PDFs and splice again.`);
  })
);

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

// ── DNA splice animation ────────────────────────────────────────────
// Phase 1: one wavy strand per source document drifts toward the centre.
// Phase 2: they wind into a double helix with base-pair rungs, spinning up.
// Phase 3: the helix pinches into a single bright thread — the document.
function spliceAnimation(strandCount) {
  if (reducedMotion()) return Promise.resolve();
  return new Promise((resolve) => {
    const overlay = $("spliceOverlay");
    const label = $("spliceLabel");
    const cv = $("spliceCanvas");
    const ctx = cv.getContext("2d");
    cv.width = window.innerWidth;
    cv.height = window.innerHeight;
    const W = cv.width, H = cv.height, cy = H / 2;
    const N = Math.max(2, Math.min(strandCount, 6));
    const DUR = 3200;
    overlay.classList.remove("hidden", "fading");
    label.textContent = "UNWINDING STRANDS";

    const ease = (t) => t * t * (3 - 2 * t);
    const start = performance.now();

    function strandPath(yBase, amp, wavelength, phase, color, alpha, lw) {
      ctx.beginPath();
      for (let x = -20; x <= W + 20; x += 6) {
        const y = yBase + Math.sin(x / wavelength + phase) * amp;
        x === -20 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = lw;
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function frame(now) {
      const t = Math.min((now - start) / DUR, 1);
      ctx.clearRect(0, 0, W, H);
      const spin = now / 240;

      if (t < 0.42) {
        // Phase 1 — separate strands converge on the centre line
        const k = ease(t / 0.42);
        for (let i = 0; i < N; i++) {
          const y0 = ((i + 1) / (N + 1)) * H;
          const y = y0 + (cy - y0) * k;
          const color = i % 2 ? SILVER : GOLD;
          strandPath(y, 16 + 6 * Math.sin(i * 2.1), 70 + i * 14, spin + i * 1.7, color, 0.5 + 0.5 * k, 2);
        }
      } else if (t < 0.8) {
        // Phase 2 — double helix winds up at the centre
        label.textContent = "SPLICING";
        const k = ease((t - 0.42) / 0.38);
        const amp = 44 * (1 - 0.15 * k);
        const wl = 88;
        const speed = spin * (1 + 2.2 * k);
        // base-pair rungs
        for (let x = 30; x < W - 10; x += 26) {
          const p = x / wl + speed;
          const y1 = cy + Math.sin(p) * amp;
          const y2 = cy + Math.sin(p + Math.PI) * amp;
          const depth = (Math.cos(p) + 1) / 2;
          ctx.beginPath();
          ctx.moveTo(x, y1);
          ctx.lineTo(x, y2);
          ctx.strokeStyle = GOLD;
          ctx.globalAlpha = 0.12 + 0.3 * depth;
          ctx.lineWidth = 1.4;
          ctx.shadowBlur = 0;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        strandPath(cy, amp, wl, speed, GOLD, 0.95, 2.6);
        strandPath(cy, amp, wl, speed + Math.PI, SILVER, 0.85, 2.6);
      } else {
        // Phase 3 — pinch into a single bright thread
        label.textContent = "STRAND COMPLETE";
        const k = ease((t - 0.8) / 0.2);
        const amp = 37 * (1 - k);
        const speed = spin * 3.2;
        strandPath(cy, amp, 88, speed, GOLD, 1, 2.6 + 1.6 * k);
        strandPath(cy, amp, 88, speed + Math.PI, k > 0.6 ? GOLD_BRIGHT : SILVER, 1, 2.6 + 1.6 * k);
        if (k > 0.5) {
          // flash of light as the thread fuses
          ctx.globalAlpha = (k - 0.5) * 0.9;
          const g = ctx.createLinearGradient(0, cy - 40, 0, cy + 40);
          g.addColorStop(0, "rgba(244,216,120,0)");
          g.addColorStop(0.5, "rgba(244,216,120,.55)");
          g.addColorStop(1, "rgba(244,216,120,0)");
          ctx.fillStyle = g;
          ctx.fillRect(0, cy - 40, W, 80);
          ctx.globalAlpha = 1;
        }
      }

      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        overlay.classList.add("fading");
        setTimeout(() => {
          overlay.classList.add("hidden");
          resolve();
        }, 460);
      }
    }
    requestAnimationFrame(frame);
  });
}

// ── Header helix — small ambient motif ──────────────────────────────
(function helixMini() {
  const cv = $("helixMini");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height, cx = W / 2;
  function draw(phase) {
    ctx.clearRect(0, 0, W, H);
    for (let y = 4; y <= H - 4; y += 3) {
      const p = y / 8 + phase;
      const x1 = cx + Math.sin(p) * 14;
      const x2 = cx + Math.sin(p + Math.PI) * 14;
      const d1 = (Math.cos(p) + 1) / 2;
      if (y % 9 < 3) {
        ctx.strokeStyle = "rgba(217,181,68,.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.stroke();
      }
      ctx.fillStyle = GOLD;
      ctx.globalAlpha = 0.4 + 0.6 * d1;
      ctx.fillRect(x1 - 1.2, y - 1.2, 2.4, 2.4);
      ctx.fillStyle = SILVER;
      ctx.globalAlpha = 0.4 + 0.6 * (1 - d1);
      ctx.fillRect(x2 - 1.2, y - 1.2, 2.4, 2.4);
      ctx.globalAlpha = 1;
    }
  }
  if (reducedMotion()) {
    draw(0);
  } else {
    (function loop(now) {
      draw(now / 900);
      requestAnimationFrame(loop);
    })(0);
  }
})();

// ── Completion feedback ─────────────────────────────────────────────
function flashThumb(el) {
  el.classList.remove("flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("flash");
  el.addEventListener("animationend", () => el.classList.remove("flash"), { once: true });
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
