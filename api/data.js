// GET  /api/data            -> { orders, expenses, payments, me, links }
// POST /api/data {op:'save', collection, id?, data}  -> { id }
// POST /api/data {op:'delete', collection, id}        -> { ok }
import { requireUser, json, readJson } from '../lib/auth.js';
import { store, readAll, upsert, removeRow, nextOrderId, clean, TABS, nameReceiptFile } from '../lib/store.js';
import { randomUUID } from 'node:crypto';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const s = await store();
    if (req.method === 'GET') {
      const data = await readAll(s);
      return json(res, 200, { ...data, me: user, links: { sheet: s.sheetLink, folder: s.folderLink } });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

    const { op, collection, id, data } = await readJson(req);
    if (!TABS[collection]) return json(res, 400, { error: 'Unknown collection' });

    if (op === 'delete') {
      if (!id) return json(res, 400, { error: 'Missing id' });
      await removeRow(s, collection, id);
      return json(res, 200, { ok: true });
    }
    if (op !== 'save' || !data || typeof data !== 'object') return json(res, 400, { error: 'Bad request' });

    const rec = clean(collection, data);
    const now = new Date().toISOString();
    if (id) {
      rec.id = String(id);
      rec.updatedAt = now;
      rec.updatedBy = user.name;
      if (!rec.createdAt) rec.createdAt = now;
    } else {
      rec.id = collection === 'orders' ? await nextOrderId(s) : `${collection[0]}-${randomUUID().slice(0, 8)}`;
      rec.createdAt = now;
      rec.createdBy = user.name;
    }
    await upsert(s, collection, rec);

    // Give the receipt file a readable name in Drive
    if (collection === 'expenses' && rec.receiptId) nameReceiptFile(s, rec);
    return json(res, 200, { id: rec.id });
  } catch (e) {
    if (e.setup) return json(res, 503, { setup: true, isOwner: user.isOwner });
    console.error(e);
    return json(res, 500, { error: 'Could not reach Google Sheets. Try again in a moment.' });
  }
}
