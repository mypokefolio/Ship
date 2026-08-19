# Ship PDF Studio

A single-page web app for preparing **labels and pick lists**: drag PDFs into the
browser, crop them (one crop applied across every document at once), merge them
into a single file, or split them apart — then download. Everything runs locally
in your browser; no files are ever uploaded.

## Use it

No build step and no server required — just open `index.html` in any modern
browser (Chrome, Edge, Firefox, Safari). Hosting the repo on GitHub Pages or any
static host works too.

## Workflow

1. **Drop** one or more PDFs onto the page (or click the drop zone to browse).
2. **Crop** — click any page thumbnail to open the crop editor, drag a box over
   the area you want to keep (dimensions shown in inches), then:
   - *Apply to This Page* — crop just that page
   - *Apply to Whole Doc* — same crop on every page of that document
   - *Apply to ALL Docs* — same crop on every page of every loaded document
     (the fast path for a stack of identical shipping labels)
3. **Select** — the ✓ toggle on each thumbnail includes/excludes a page; use
   *Select all* / *None* per document. Reorder documents with ▲ / ▼ to control
   merge order.
4. **Splice** — *Splice & Merge* fuses every selected page (crops applied)
   into a single strand, with a DNA-splicing animation. The sources disappear
   and one gold **SPLICED STRAND** card remains — that card *is* the merged
   document. Load more PDFs and splice again to grow it in rounds.
5. **Download** — the *Download PDF* button lives on the spliced card.
   *Split pages* (one file per selected page) and *Save each doc* download
   immediately. Thumbnails always show the edited preview: after a crop, the
   thumbnail is the cropped region itself, labeled with its size in inches.

## Tech

Plain HTML/CSS/JS with two libraries vendored in `vendor/` (works offline):

- [pdf.js](https://mozilla.github.io/pdf.js/) 3.11.174 — renders page previews
- [pdf-lib](https://pdf-lib.js.org/) 1.17.1 — applies crops, merges and splits pages

Crops are stored as normalized rectangles and converted to PDF user-space
through pdf.js viewports, so rotated pages and offset origins crop correctly.
Both the MediaBox and CropBox are set, so crops are respected by viewers and
printers alike.
