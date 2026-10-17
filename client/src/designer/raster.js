// Turns an uploaded PDF / JPG / PNG into a JPEG data URL the server can store.
// PDFs are rendered client-side with pdf.js, loaded on demand from cdnjs.

const PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/';
const MAX_SIDE = 4096;
const JPEG_QUALITY = 0.85;

let pdfjsLoading = null;
function pdfjs() {
  pdfjsLoading ??= import(/* @vite-ignore */ `${PDFJS_BASE}pdf.min.mjs`).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.min.mjs`;
    return lib;
  });
  return pdfjsLoading;
}

function toJpeg(source, width, height) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // flatten transparency: plans are drawn on paper
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY), widthPx: canvas.width, heightPx: canvas.height };
}

const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

/**
 * Opens a plan file. Returns { pages, render(pageNumber) } where render
 * resolves to { dataUrl, widthPx, heightPx }. Images have a single page.
 */
export async function openPlanFile(file) {
  if (isPdf(file)) {
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    return {
      pages: doc.numPages,
      async render(pageNumber = 1) {
        const page = await doc.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        // Render sharp enough to trace walls, capped at MAX_SIDE.
        const viewport = page.getViewport({ scale: Math.min(4, MAX_SIDE / Math.max(base.width, base.height)) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        return toJpeg(canvas, canvas.width, canvas.height);
      },
    };
  }
  if (!/^image\/(jpeg|png)$/.test(file.type) && !/\.(jpe?g|png)$/i.test(file.name)) {
    throw new Error('Use a PDF, JPG or PNG file');
  }
  const bitmap = await createImageBitmap(file);
  return {
    pages: 1,
    async render() {
      return toJpeg(bitmap, bitmap.width, bitmap.height);
    },
  };
}
