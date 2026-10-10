// Reads the text on a receipt photo with Tesseract (free, runs inside the server function).
// The English language data (~10 MB) is downloaded on first use and kept in /tmp while the function stays warm.
import Tesseract from 'tesseract.js';

let workerP = null;
function worker() {
  if (!workerP) {
    workerP = (async () => {
      const w = await Tesseract.createWorker('eng', 1, { cachePath: '/tmp/tesseract-cache' });
      await w.setParameters({ tessedit_pageseg_mode: '6' }); // read the receipt as one block so prices stay on their lines
      return w;
    })().catch((e) => { workerP = null; throw e; });
  }
  return workerP;
}

/** Text on the image, or '' if it couldn't be read within the time limit. */
export async function receiptText(buf, ms = 30000) {
  let timer;
  try {
    return await Promise.race([
      (async () => { const w = await worker(); const r = await w.recognize(buf); return r.data.text || ''; })(),
      new Promise((resolve) => { timer = setTimeout(() => resolve(''), ms); }),
    ]);
  } catch (e) {
    console.error('Receipt OCR failed', e);
    return '';
  } finally { clearTimeout(timer); }
}
