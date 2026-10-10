// Orders, expenses and payments live in a Google Sheet; receipt photos in a Drive folder.
// Both are created in the owner's Google Drive the first time the owner connects Drive,
// using the narrow "drive.file" permission (the app can only see files it created itself).
import { OAuth2Client } from 'google-auth-library';
import { drive as driveApi } from '@googleapis/drive';
import { sheets as sheetsApi } from '@googleapis/sheets';

export const TABS = {
  orders: {
    title: 'Orders',
    cols: ['id', 'type', 'customer', 'phone', 'occasion', 'date', 'time', 'status', 'fulfilment', 'address', 'guests', 'perGuest', 'items', 'menu', 'deliveryFee', 'otherAmount', 'notes', 'total', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'source', 'equipment', 'returnedAt'],
    labels: ['Order #', 'Type', 'Customer', 'Phone', 'Occasion', 'Date', 'Time', 'Status', 'Delivery / pickup', 'Address', 'Guests', 'Price per guest', 'Items (farsan/sweet)', 'Menu', 'Delivery fee', 'Other charges', 'Other details', 'Order total', 'Created', 'Taken by', 'Updated', 'Updated by', 'Source', 'Equipment lent', 'Equipment returned'],
  },
  expenses: {
    title: 'Expenses',
    cols: ['id', 'date', 'amount', 'vendor', 'category', 'orderIds', 'note', 'receiptId', 'receiptType', 'receiptLink', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'],
    labels: ['Expense ID', 'Date', 'Amount', 'Shop / paid to', 'Category', 'For orders', 'Note', 'Receipt file ID', 'Receipt type', 'Receipt link', 'Created', 'Added by', 'Updated', 'Updated by'],
  },
  payments: {
    title: 'Payments',
    cols: ['id', 'orderId', 'date', 'amount', 'method', 'note', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'source'],
    labels: ['Payment ID', 'Order #', 'Date', 'Amount', 'Method', 'Note', 'Created', 'Added by', 'Updated', 'Updated by', 'Source'],
  },
};
const NUMBER_FIELDS = new Set(['guests', 'perGuest', 'deliveryFee', 'otherAmount', 'total', 'amount']);
const STRING_ID_FIELDS = new Set(['id', 'orderId', 'phone', 'date', 'time', 'returnedAt']);

const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? 0 : Number(v));
const colLetter = (n) => { let s = ''; n += 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

export function orderTotal(o) {
  const extra = num(o.deliveryFee) + num(o.otherAmount);
  if (o.type === 'farsan') return (o.items || []).reduce((s, i) => s + num(i.qty) * num(i.price), 0) + extra;
  return num(o.guests) * num(o.perGuest) + extra;
}

/** One record -> one sheet row (in column order). */
export function toRow(collection, rec) {
  return TABS[collection].cols.map((c) => {
    const v = rec[c];
    if (c === 'items') return JSON.stringify(Array.isArray(v) ? v : []);
    if (c === 'orderIds') return (Array.isArray(v) ? v : []).join(', ');
    if (NUMBER_FIELDS.has(c)) return num(v);
    return v == null ? '' : String(v);
  });
}

/** One sheet row -> one record. */
export function fromRow(collection, row) {
  const rec = {};
  TABS[collection].cols.forEach((c, i) => {
    const v = row[i];
    if (c === 'items') { try { rec.items = v ? JSON.parse(v) : []; } catch { rec.items = []; } }
    else if (c === 'orderIds') rec.orderIds = String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (NUMBER_FIELDS.has(c)) rec[c] = num(v);
    else if (STRING_ID_FIELDS.has(c)) rec[c] = v == null ? '' : String(v);
    else rec[c] = v ?? '';
  });
  return rec;
}

/** Keep only known fields with sensible types. */
export function clean(collection, data) {
  const out = {};
  for (const c of TABS[collection].cols) if (c in data) out[c] = data[c];
  if (collection === 'orders') {
    out.type = out.type === 'farsan' ? 'farsan' : 'catering';
    out.items = Array.isArray(out.items)
      ? out.items.slice(0, 100).map((i) => ({ name: String(i.name || '').slice(0, 120), qty: num(i.qty), unit: String(i.unit || '').slice(0, 20), price: num(i.price) })).filter((i) => i.name)
      : [];
    out.total = Math.round(orderTotal(out) * 100) / 100;
  }
  if (collection === 'expenses') out.orderIds = Array.isArray(out.orderIds) ? out.orderIds.map(String).slice(0, 50) : [];
  for (const k of Object.keys(out)) if (typeof out[k] === 'string') out[k] = out[k].slice(0, 5000);
  return out;
}

export function ownerAuth(refreshToken = process.env.GOOGLE_REFRESH_TOKEN) {
  if (!refreshToken) return null;
  const c = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  c.setCredentials({ refresh_token: refreshToken });
  return c;
}

let cached = null;

/** Connect to the owner's sheet + receipts folder, creating them if this is the first run. */
export async function store(auth) {
  const oneOff = !!auth;
  if (cached && !oneOff) return cached;
  auth = auth || ownerAuth();
  if (!auth) { const e = new Error('Owner has not connected Google Drive yet'); e.setup = true; throw e; }
  const drive = driveApi({ version: 'v3', auth });
  const sheets = sheetsApi({ version: 'v4', auth });

  const find = async (value) => (await drive.files.list({
    q: `appProperties has { key='satvik' and value='${value}' } and trashed=false`,
    fields: 'files(id,name,webViewLink)', spaces: 'drive', pageSize: 5,
  })).data.files[0];

  let sheet = await find('orders-db');
  if (!sheet) {
    sheet = (await drive.files.create({
      requestBody: { name: 'Satvik Orders', mimeType: 'application/vnd.google-apps.spreadsheet', appProperties: { satvik: 'orders-db' } },
      fields: 'id,name,webViewLink',
    })).data;
  }
  let folder = await find('receipts');
  if (!folder) {
    folder = (await drive.files.create({
      requestBody: { name: 'Satvik Receipts', mimeType: 'application/vnd.google-apps.folder', appProperties: { satvik: 'receipts' } },
      fields: 'id,name,webViewLink',
    })).data;
  }
  const sheetIds = await ensureTabs(sheets, sheet.id);
  const s = { drive, sheets, spreadsheetId: sheet.id, sheetLink: sheet.webViewLink, folderId: folder.id, folderLink: folder.webViewLink, sheetIds };
  if (!oneOff) cached = s;
  return s;
}

async function ensureTabs(sheets, spreadsheetId) {
  const meta = async () => (await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' })).data.sheets.map((x) => x.properties);
  let props = await meta();
  const titles = Object.values(TABS).map((t) => t.title);
  const requests = [];
  const missing = titles.filter((t) => !props.some((p) => p.title === t));
  if (missing.length) {
    const spare = props.find((p) => !titles.includes(p.title)); // the default "Sheet1"
    missing.forEach((t, i) => {
      if (i === 0 && spare) requests.push({ updateSheetProperties: { properties: { sheetId: spare.sheetId, title: t }, fields: 'title' } });
      else requests.push({ addSheet: { properties: { title: t } } });
    });
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    props = await meta();
    // Header rows, bold and frozen, so the sheet is easy to read on its own.
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: Object.values(TABS).map((t) => ({ range: `${t.title}!A1`, values: [t.labels] })) },
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: Object.values(TABS).flatMap((t) => {
          const id = props.find((p) => p.title === t.title).sheetId;
          return [
            { updateSheetProperties: { properties: { sheetId: id, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
            { repeatCell: { range: { sheetId: id, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
          ];
        }),
      },
    });
  }
  // Keep the header rows in step with the columns (cheap, and covers columns added later).
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data: Object.values(TABS).map((t) => ({ range: `${t.title}!A1`, values: [t.labels] })) },
  });
  return Object.fromEntries(props.map((p) => [p.title, p.sheetId]));
}

export async function readAll(s) {
  const keys = Object.keys(TABS);
  const r = await s.sheets.spreadsheets.values.batchGet({
    spreadsheetId: s.spreadsheetId,
    ranges: keys.map((k) => `${TABS[k].title}!A2:${colLetter(TABS[k].cols.length - 1)}`),
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const out = {};
  keys.forEach((k, i) => {
    out[k] = (r.data.valueRanges[i].values || []).filter((row) => row[0] !== '' && row[0] != null).map((row) => fromRow(k, row));
  });
  return out;
}

async function idColumn(s, collection) {
  const r = await s.sheets.spreadsheets.values.get({ spreadsheetId: s.spreadsheetId, range: `${TABS[collection].title}!A:A`, valueRenderOption: 'UNFORMATTED_VALUE' });
  return (r.data.values || []).map((row) => String(row[0] ?? ''));
}

export async function nextOrderId(s) {
  const ids = await idColumn(s, 'orders');
  return String(Math.max(1000, ...ids.map((x) => parseInt(x, 10) || 0)) + 1);
}

export async function upsert(s, collection, rec) {
  const t = TABS[collection];
  const ids = await idColumn(s, collection);
  const idx = ids.findIndex((x, i) => i > 0 && x === String(rec.id));
  const row = toRow(collection, rec);
  if (idx > 0) {
    await s.sheets.spreadsheets.values.update({ spreadsheetId: s.spreadsheetId, range: `${t.title}!A${idx + 1}`, valueInputOption: 'RAW', requestBody: { values: [row] } });
  } else {
    await s.sheets.spreadsheets.values.append({ spreadsheetId: s.spreadsheetId, range: `${t.title}!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [row] } });
  }
}

export async function removeRow(s, collection, id) {
  const ids = await idColumn(s, collection);
  const idx = ids.findIndex((x, i) => i > 0 && x === String(id));
  if (idx <= 0) return false;
  await s.sheets.spreadsheets.batchUpdate({
    spreadsheetId: s.spreadsheetId,
    requestBody: { requests: [{ deleteDimension: { range: { sheetId: s.sheetIds[TABS[collection].title], dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 } } }] },
  });
  return true;
}
