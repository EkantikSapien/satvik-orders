// POST   /api/receipt   (raw image/PDF body)  -> { id, contentType, link }   uploads into the "Satvik Receipts" Drive folder
// GET    /api/receipt?id=...                   -> the file, for showing in the app
// DELETE /api/receipt?id=...                   -> moves the file to Drive's bin (recoverable for 30 days)
import { requireUser, json } from '../lib/auth.js';
import { store, saveReceiptFile } from '../lib/store.js';

const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const MAX = 4.3 * 1024 * 1024; // Vercel's request limit is 4.5 MB

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const id = new URL(req.url, 'http://x').searchParams.get('id');
  try {
    const s = await store();
    if (req.method === 'GET') {
      if (!id) return json(res, 400, { error: 'Missing id' });
      const meta = (await s.drive.files.get({ fileId: id, fields: 'mimeType,parents' })).data;
      if (!(meta.parents || []).includes(s.folderId)) return json(res, 404, { error: 'Not found' });
      const file = await s.drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'stream' });
      res.statusCode = 200;
      res.setHeader('Content-Type', meta.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      file.data.pipe(res);
      return;
    }
    if (req.method === 'DELETE') {
      if (!id) return json(res, 400, { error: 'Missing id' });
      await s.drive.files.update({ fileId: id, requestBody: { trashed: true } });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST') {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (!TYPES.includes(type)) return json(res, 415, { error: 'Use a photo (JPG, PNG) or a PDF.' });
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > MAX) return json(res, 413, { error: 'That file is too big. Keep receipts under 4 MB.' }); chunks.push(c); }
      if (!size) return json(res, 400, { error: 'Empty file' });
      const r = await saveReceiptFile(s, Buffer.concat(chunks), type, user.name);
      return json(res, 200, r);
    }
    return json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    if (e.setup) return json(res, 503, { setup: true, isOwner: user.isOwner });
    console.error(e);
    return json(res, 500, { error: 'Could not reach Google Drive. Try again in a moment.' });
  }
}
