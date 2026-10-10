// WhatsApp Cloud API webhook.
// GET  — Meta's one-time webhook verification.
// POST — incoming messages: a team member texts an order or payment in plain words, the app
//        reads it with Claude, saves it to the sheet and replies with what it recorded.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { store, readAll, upsert, nextOrderId, clean, orderTotal, saveReceiptFile, nameReceiptFile } from '../lib/store.js';
import { receiptText } from '../lib/ocr.js';
import { readReceipt } from '../public/receipt-read.js';
import { extract } from '../lib/extract.js';
import { parseMessage, parseExpenseText, TEMPLATES } from '../lib/parse.js';
import { PREP, prepTotals } from '../lib/prep.js';

const APP_URL = () => process.env.APP_URL || 'https://satvik-orders.vercel.app';
const GRAPH = () => `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v25.0'}`;

/** "61412345678:Pranjal, 61498765432:Mum" -> { '61412345678': 'Pranjal', ... } */
function senders() {
  const out = {};
  (process.env.WHATSAPP_ALLOWED_NUMBERS || '').split(/[,\n]+/).map((s) => s.trim()).filter(Boolean).forEach((p) => {
    const [num, ...name] = p.split(':');
    const n = num.replace(/\D/g, '');
    if (n) out[n] = name.join(':').trim() || ('+' + n);
  });
  return out;
}

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function validSignature(req, raw) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  const sig = String(req.headers['x-hub-signature-256'] || '');
  if (!secret || !sig.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(sig);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

async function send(to, msg) {
  const r = await fetch(`${GRAPH()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, ...msg }),
  });
  if (!r.ok) console.error('WhatsApp reply failed', r.status, await r.text());
}
const reply = (to, body) => send(to, { type: 'text', text: { preview_url: false, body: body.slice(0, 4000) } });
const cut = (str, n) => (str.length > n ? str.slice(0, n - 1) + '…' : str);

const money = (n) => '$' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const niceDate = (iso) => (iso ? new Date(iso + 'T00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : 'no date');
const niceTime = (t) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`; };
const todayBrisbane = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const validTime = (s) => /^\d{2}:\d{2}$/.test(String(s || ''));

const HELP = '*Adding orders*\nForward or paste the order as you\'d write it, e.g. your confirmation message, or "1kg sev khamni, Sunday, Kunalbhai". You can also send *catering* or *farsan* for a form.\n'
  + 'Fix a detail: *#1023 name Kunalbhai*, *#1023 date 24/10*, *#1023 guests 50*\n\n'
  + '*What\'s on*\nSend *today*, *tomorrow*, *Sunday* or *24/10*\n\n'
  + '*Equipment*\nSend *equipment* to see what\'s out, *returned #1004* when it\'s back\n\n'
  + '*Expenses*\nSend a photo of the receipt (add *#1004* in the caption if you know the order). Or type *spent $84.20 Woolworths #1004*. Fix the last one with *receipt $84.20* or *receipt #1004 #1005*\n\n'
  + '*Payments*\n'
  + '*owing* to pick from orders still to pay\n*Paid $500 cash #1004* for a part payment\n*paid in full before today* for many at once';

const paidFor = (data, id) => data.payments.filter((p) => p.orderId === id).reduce((t, p) => t + (Number(p.amount) || 0), 0);
const owingOrders = (data) => data.orders
  .filter((o) => o.status !== 'cancelled' && orderTotal(o) > 0)
  .map((o) => ({ ...o, balance: Math.round((orderTotal(o) - paidFor(data, o.id)) * 100) / 100 }))
  .filter((o) => o.balance > 0.005)
  .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));

const equipmentOut = (data) => data.orders
  .filter((o) => o.equipment && String(o.equipment).trim() && !o.returnedAt && o.status !== 'cancelled' && o.date)
  .sort((a, b) => a.date.localeCompare(b.date));

/** "tomorrow" -> the day's orders, in time order, with the kg of each farsan to make. */
function dayReport(data, date, today) {
  const orders = data.orders.filter((o) => o.date === date && o.status !== 'cancelled')
    .sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
  const label = date === today ? 'Today' : niceDate(date);
  if (!orders.length) return `📅 ${label}${date === today ? ' (' + niceDate(date) + ')' : ''}: no orders.`;
  const tot = prepTotals(orders);
  const lines = [`📅 *${label}${date === today ? ' · ' + niceDate(date) : ''}* · ${orders.length} order${orders.length > 1 ? 's' : ''}`];
  const make = PREP.filter((p) => tot[p.key].kg > 0).map((p) => `• ${p.label}: *${Math.round(tot[p.key].kg * 100) / 100} kg*`);
  if (make.length) lines.push('', 'To make:', ...make);
  const noQty = PREP.flatMap((p) => tot[p.key].noQty.map((o) => `#${o.id} ${o.customer} (${p.label.toLowerCase()})`));
  if (noQty.length) lines.push(`Not counted, no kg given: ${[...new Set(noQty)].join(', ')}`);
  lines.push('');
  for (const o of orders) {
    const owe = Math.round((orderTotal(o) - paidFor(data, o.id)) * 100) / 100;
    const what = o.type === 'farsan' ? (o.items || []).map((i) => `${i.qty}${i.unit} ${i.name}`).join(', ') : `${o.guests || '?'} guests`;
    lines.push(`*${o.time ? niceTime(o.time) : 'No time'}* #${o.id} ${o.customer || '(no name)'} · ${o.fulfilment === 'delivery' ? 'Delivery' : 'Pickup'}\n${what}${owe > 0.005 ? ` · owes ${money(owe)}` : ' · paid'}`);
  }
  return lines.join('\n');
}

/** WhatsApp list message (max 10 rows): the orders still owing, oldest first, with a "More" row to page on. */
async function sendOwingList(to, data, offset = 0) {
  const all = owingOrders(data);
  if (!all.length) return reply(to, '🎉 Nothing owing. Every order is fully paid.');
  const more = all.length - offset > 10;
  const page = all.slice(offset, offset + (more ? 9 : 10));
  const rows = page.map((o) => ({
    id: `pay:${o.id}`,
    title: cut(`#${o.id} ${o.customer || ''}`.trim(), 24),
    description: cut(`${niceDate(o.date)} · owes ${money(o.balance)}`, 72),
  }));
  if (more) rows.push({ id: `owing:${offset + 9}`, title: 'More orders…', description: `${all.length - offset - 9} more still owing` });
  const total = all.reduce((t, o) => t + o.balance, 0);
  return send(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: cut(`${all.length} order${all.length > 1 ? 's' : ''} still owing, ${money(total)} in total.${offset ? ` (showing from #${offset + 1})` : ''}\nTap below, pick the order, then choose how they paid.`, 1024) },
      action: { button: 'Choose order', sections: [{ title: 'Still owing', rows }] },
    },
  });
}

const CATS = ['Groceries', 'Vegetables', 'Dairy', 'Spices & dry goods', 'Packaging', 'Gas & fuel', 'Staff', 'Hire & equipment', 'Other'];
const expenseLine = (e, data) => {
  const ords = (e.orderIds || []).map((id) => data.orders.find((o) => o.id === id)).filter(Boolean);
  return [
    `🧾 *${e.amount ? money(e.amount) : 'Amount not read'}*${e.vendor ? ' · ' + e.vendor : ''} · ${niceDate(e.date)}`,
    `Category: ${e.category}`,
    `For: ${ords.length ? ords.map((o) => `#${o.id} ${o.customer}`).join(', ') : 'not linked to an order yet'}`,
  ].join('\n');
};

/** List of nearby orders to link a receipt to (WhatsApp lists hold 10 rows). */
function sendLinkList(to, e, data, today) {
  const t = new Date(today + 'T00:00');
  const near = data.orders.filter((o) => o.status !== 'cancelled' && o.date)
    .map((o) => ({ o, d: Math.abs((new Date(o.date + 'T00:00') - t) / 86400000) }))
    .filter((x) => x.d <= 14).sort((a, b) => a.d - b.d).slice(0, 9).map((x) => x.o)
    .sort((a, b) => a.date.localeCompare(b.date));
  const rows = near.map((o) => ({ id: `exp:${e.id}:${o.id}`, title: cut(`#${o.id} ${o.customer || ''}`.trim(), 24), description: cut(`${niceDate(o.date)} · ${o.type === 'farsan' ? 'Farsan/Sweet' : (o.guests || '?') + ' guests'}`, 72) }));
  rows.push({ id: `exp:${e.id}:none`, title: 'Not for an order', description: 'General kitchen cost' });
  return send(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: 'Which order is this for? Tap below.\nFor several orders, reply e.g. *receipt #1004 #1005*' },
      action: { button: 'Choose order', sections: [{ title: 'Orders near this date', rows }] },
    },
  });
}

async function newExpense(s, data, who, msgId, fields) {
  const rec = clean('expenses', {
    date: fields.date || todayBrisbane(), amount: fields.amount || 0, vendor: fields.vendor || '',
    category: CATS.includes(fields.category) ? fields.category : 'Other', orderIds: fields.orderIds || [],
    note: ['via WhatsApp', fields.note].filter(Boolean).join(' · '),
    receiptId: fields.receiptId || '', receiptType: fields.receiptType || '', receiptLink: fields.receiptLink || '',
  });
  rec.id = 'e-' + randomUUID().slice(0, 8);
  rec.createdAt = new Date().toISOString();
  rec.createdBy = `${who} (WhatsApp)`;
  rec.source = msgId;
  await upsert(s, 'expenses', rec);
  nameReceiptFile(s, rec);
  data.expenses.push(rec);
  return rec;
}

/** A photo or PDF of a receipt: save it to Drive, read the total, add an expense, ask which order. */
async function handleMedia(from, who, m) {
  const media = m.image || m.document || {};
  const type = String(media.mime_type || '').split(';')[0];
  if (!/^image\/(jpeg|png|webp)$|^application\/pdf$/.test(type)) return reply(from, 'Send receipts as a photo or a PDF.');
  const s = await store();
  const data = await readAll(s);
  if (data.expenses.some((e) => e.source === m.id)) return;
  const auth = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const meta = await (await fetch(`${GRAPH()}/${media.id}`, { headers: auth })).json();
  if (!meta.url) throw new Error('No media URL: ' + JSON.stringify(meta).slice(0, 200));
  const buf = Buffer.from(await (await fetch(meta.url, { headers: auth })).arrayBuffer());
  const today = todayBrisbane();
  const [file, text] = await Promise.all([
    saveReceiptFile(s, buf, type === 'image/webp' ? 'image/webp' : type, `${who} (WhatsApp)`),
    type.startsWith('image/') ? receiptText(buf) : Promise.resolve(''),
  ]);
  const scanned = readReceipt(text, today);
  const cap = parseExpenseText(media.caption || '');
  const e = await newExpense(s, data, who, m.id, {
    date: scanned.date || today, amount: cap.amount || scanned.amount, vendor: cap.vendor || scanned.vendor,
    category: (cap.vendor && readReceipt(cap.vendor, today).category) || scanned.category, orderIds: cap.orderIds.filter((id) => data.orders.some((o) => o.id === id)),
    receiptId: file.id, receiptType: file.contentType, receiptLink: file.link,
  });
  const lines = ['Receipt saved:', expenseLine(e, data)];
  if (!e.amount) lines.push('', `I couldn't read the total. Reply e.g. *receipt $84.20*`);
  else if (!cap.amount) lines.push('', `Wrong amount? Reply e.g. *receipt $84.20*`);
  await reply(from, lines.join('\n'));
  if (!e.orderIds.length) return sendLinkList(from, e, data, today);
}

/** Taps on the list ("pay:1004", "owing:9") and on the payment buttons ("paid:1004:Cash"). */
async function handleTap(from, who, tapId, msgId) {
  const s = await store();
  const data = await readAll(s);
  if (data.payments.some((p) => p.source === msgId)) return;
  const [what, id, method] = tapId.split(':');
  if (what === 'owing') return sendOwingList(from, data, Number(id) || 0);
  if (what === 'exp') {
    const e = data.expenses.find((x) => x.id === id);
    if (!e) return reply(from, 'I can\'t find that receipt any more.');
    const orderIds = method === 'none' ? [] : [method];
    const upd = clean('expenses', { ...e, orderIds, updatedAt: new Date().toISOString(), updatedBy: `${who} (WhatsApp)` });
    await upsert(s, 'expenses', upd);
    nameReceiptFile(s, upd);
    const o = data.orders.find((x) => x.id === method);
    return reply(from, method === 'none' ? `🧾 ${money(e.amount)} kept as a general cost.` : `🧾 ${money(e.amount)} linked to #${o ? o.id + ' ' + o.customer : method}.\nFor more than one order, reply e.g. *receipt #${method} #1005*`);
  }
  const o = data.orders.find((x) => x.id === id);
  if (!o) return reply(from, `I can't find order #${id}.`);
  const owing = Math.round((orderTotal(o) - paidFor(data, o.id)) * 100) / 100;
  if (owing <= 0.005) return reply(from, `#${o.id} ${o.customer} is already fully paid.`);
  if (what === 'pay') {
    return send(from, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: `#${o.id} ${o.customer}\n${niceDate(o.date)} · owes ${money(owing)}\n\nHow did they pay the ${money(owing)}?\n(For a part payment, send e.g. *Paid $200 cash #${o.id}*)` },
        action: { buttons: [
          { type: 'reply', reply: { id: `paid:${o.id}:Cash`, title: 'Cash' } },
          { type: 'reply', reply: { id: `paid:${o.id}:Card`, title: 'Card' } },
          { type: 'reply', reply: { id: `paid:${o.id}:Bank transfer`, title: 'Bank transfer' } },
        ] },
      },
    });
  }
  if (what === 'paid') {
    const m = ['Cash', 'Card', 'Bank transfer'].includes(method) ? method : 'Other';
    const rec = clean('payments', { orderId: o.id, amount: owing, method: m, date: todayBrisbane(), note: 'Paid in full · via WhatsApp' });
    rec.id = 'p-' + msgId.slice(-10).replace(/[^A-Za-z0-9]/g, '');
    rec.createdAt = new Date().toISOString();
    rec.createdBy = `${who} (WhatsApp)`;
    rec.source = msgId;
    await upsert(s, 'payments', rec);
    const left = owingOrders({ ...data, payments: [...data.payments, rec] });
    return reply(from, `💰 ${money(owing)} ${m.toLowerCase()} recorded. #${o.id} ${o.customer} is fully paid.\n\n${left.length ? `${left.length} order${left.length > 1 ? 's' : ''} still owing. Send *owing* to see them.` : 'Nothing else is owing. 🎉'}`);
  }
}

async function handleText(from, who, text, msgId) {
  const s = await store();
  const data = await readAll(s);

  // Meta can deliver the same message twice; skip anything already saved.
  if (data.orders.some((o) => o.source === msgId) || data.payments.some((p) => p.source === msgId) || data.expenses.some((e) => e.source === msgId)) return;

  if (/^\s*(help|hi|hello|hey|menu|\?)\s*$/i.test(text)) return reply(from, HELP);
  if (/^\s*(owing|owe|owed|pending|unpaid|due|payments?|pay|balance|balances)\s*\??\s*$/i.test(text)) return sendOwingList(from, data);

  const paid = (id) => data.payments.filter((p) => p.orderId === id).reduce((t, p) => t + (Number(p.amount) || 0), 0);
  const openOrders = data.orders.filter((o) => o.status !== 'cancelled')
    .map((o) => ({ id: o.id, customer: o.customer, date: o.date, balance: Math.max(0, orderTotal(o) - paid(o.id)) }))
    .filter((o) => o.balance > 0.005).slice(-40);

  const today = todayBrisbane();
  // Free rule-based reader by default; uses Claude only if an API key has been added.
  const res = process.env.ANTHROPIC_API_KEY ? await extract(text, { today, openOrders }) : parseMessage(text, { today, team: Object.values(senders()) });

  if (res.kind === 'template') {
    if (res.which === 'both') { await reply(from, 'Copy the form you need, fill it in and send it back:'); await reply(from, TEMPLATES.catering); return reply(from, TEMPLATES.farsan); }
    await reply(from, 'Copy this, fill it in and send it back:');
    return reply(from, TEMPLATES[res.which]);
  }

  if (res.kind === 'order' && (res.orders || res.order)) {
    const out = [];
    let n = 0;
    for (const src of res.orders || [res.order]) {
      const o = clean('orders', {
        ...src,
        status: src.status === 'enquiry' ? 'enquiry' : 'confirmed',
        fulfilment: src.fulfilment === 'delivery' ? 'delivery' : 'pickup',
        date: validDate(src.date) ? src.date : '',
        time: validTime(src.time) ? src.time : '',
        notes: [src.notes, `Added from WhatsApp by ${who}`].filter(Boolean).join('\n'),
      });
      // the same message forwarded twice (or by two people) shouldn't make two orders
      const dup = o.customer && data.orders.find((x) => x.status !== 'cancelled' && x.type === o.type && x.date === o.date
        && x.customer.trim().toLowerCase() === o.customer.trim().toLowerCase() && Math.abs(orderTotal(x) - o.total) < 0.01);
      if (dup) { out.push(`⚠️ ${o.customer} on ${niceDate(o.date)} is already in as #${dup.id}, so I didn't add it again.`); continue; }
      o.id = await nextOrderId(s);
      o.createdAt = new Date().toISOString();
      o.createdBy = `${who} (WhatsApp)`;
      o.source = n++ ? `${msgId}#${n}` : msgId;
      await upsert(s, 'orders', o);
      data.orders.push(o);
      const what = o.type === 'farsan'
        ? (o.items || []).map((i) => `${i.qty}${i.unit} ${i.name}`).join(', ') || 'no items'
        : `${o.guests || '?'} guests × ${money(o.perGuest)}${o.deliveryFee ? ` + ${money(o.deliveryFee)} delivery` : ''}${o.otherAmount ? ` + ${money(o.otherAmount)} other` : ''}`;
      const lines = [
        `✅ #${o.id} ${o.customer || '(no name yet)'} · ${o.type === 'farsan' ? 'Farsan/Sweet' : 'Catering'}`,
        `${o.date ? niceDate(o.date) : '(no date yet)'}${o.time ? ' ' + niceTime(o.time) : ''} · ${o.fulfilment === 'delivery' ? 'Delivery' + (o.address ? ' to ' + o.address : '') : 'Pickup'}`,
        what,
        `Total ${money(o.total)}`,
      ];
      if (o.equipment) lines.push(`Equipment: ${o.equipment.split('\n').join(', ')}`);
      const fix = [];
      if (!o.customer) fix.push(`*#${o.id} name Kunalbhai*`);
      if (!o.date) fix.push(`*#${o.id} date 24/10*`);
      if (o.type === 'catering' && !o.guests) fix.push(`*#${o.id} guests 50*`);
      if (fix.length) lines.push(`Missing ${fix.length > 1 ? 'some details' : 'a detail'}. Reply e.g. ${fix.join(' or ')}`);
      out.push(lines.join('\n'));
    }
    if (out.length > 1) out.unshift(`Added ${n} order${n === 1 ? '' : 's'} from that message:`);
    out.push(`Check or change anything in the app: ${APP_URL()}`);
    return reply(from, out.join('\n\n'));
  }

  if (res.kind === 'set') {
    if (res.missing) return reply(from, res.missing);
    const o = data.orders.find((x) => x.id === res.id);
    if (!o) return reply(from, `I can't find order #${res.id}.`);
    const upd = clean('orders', { ...o, ...res.changes, updatedAt: new Date().toISOString(), updatedBy: `${who} (WhatsApp)` });
    await upsert(s, 'orders', upd);
    const what = Object.entries(res.changes).filter(([k]) => k !== 'fulfilment').map(([k, v]) =>
      k === 'date' ? `date ${niceDate(v)}` : k === 'time' ? `time ${niceTime(v)}` : k === 'customer' ? `name ${v}` : k === 'perGuest' ? `price ${money(v)} per guest` : `${k} ${v}`).join(', ');
    return reply(from, `✏️ #${o.id} updated: ${what}.${['guests', 'perGuest'].some((k) => k in res.changes) ? `\nTotal now ${money(upd.total)}.` : ''}`);
  }

  if (res.kind === 'returned') {
    const o = data.orders.find((x) => x.id === res.id);
    if (!o) return reply(from, `I can't find order #${res.id}.`);
    await upsert(s, 'orders', clean('orders', { ...o, returnedAt: today, updatedAt: new Date().toISOString(), updatedBy: `${who} (WhatsApp)` }));
    const left = equipmentOut(data).filter((x) => x.id !== o.id);
    return reply(from, `📦 Equipment back from #${o.id} ${o.customer}.${left.length ? `\n${left.length} order${left.length > 1 ? 's' : ''} still have equipment out. Send *equipment* to see.` : '\nNothing else is out.'}`);
  }

  if (res.kind === 'equipment') {
    const out = equipmentOut(data);
    if (!out.length) return reply(from, '📦 All equipment is back.');
    return reply(from, ['📦 Equipment still out:', ...out.map((o) => {
      const days = Math.round((new Date(today + 'T00:00') - new Date(o.date + 'T00:00')) / 86400000);
      return `\n#${o.id} ${o.customer} · ${niceDate(o.date)}${days > 3 ? ` · ⚠️ ${days} days` : days >= 0 ? ` · ${days} day${days === 1 ? '' : 's'}` : ' · not yet'}\n${o.equipment.split('\n').join(', ')}`;
    }), '\nWhen it comes back, send e.g. *returned #' + out[0].id + '*'].join('\n'));
  }

  if (res.kind === 'day') return reply(from, dayReport(data, res.date, today));

  if (res.kind === 'expense') {
    if (res.missing) return reply(from, res.missing);
    const e = await newExpense(s, data, who, msgId, { amount: res.amount, vendor: res.vendor, category: readReceipt(res.vendor, today).category, orderIds: res.orderIds.filter((id) => data.orders.some((o) => o.id === id)) });
    await reply(from, ['Expense added (no receipt photo):', expenseLine(e, data), '', 'Tip: send a photo of the receipt instead and I\'ll read the amount and keep the photo.'].join('\n'));
    if (!e.orderIds.length) return sendLinkList(from, e, data, today);
    return;
  }

  if (res.kind === 'receipt-edit') {
    const mine = data.expenses.filter((e) => e.createdBy === `${who} (WhatsApp)`).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (!mine) return reply(from, 'I can\'t find a receipt from you to change. Send a photo of the receipt first.');
    const ch = {};
    if (res.amount) ch.amount = res.amount;
    if (res.orderIds.length) ch.orderIds = res.orderIds.filter((id) => data.orders.some((o) => o.id === id));
    if (res.vendor && !/^\d/.test(res.vendor)) { ch.vendor = res.vendor; const c = readReceipt(res.vendor, today).category; if (c && (!mine.category || mine.category === 'Other')) ch.category = c; }
    if (!Object.keys(ch).length) return reply(from, 'Send e.g. *receipt $84.20*, *receipt #1004 #1005* or *receipt Costco* to change your last receipt.');
    const upd = clean('expenses', { ...mine, ...ch, updatedAt: new Date().toISOString(), updatedBy: `${who} (WhatsApp)` });
    await upsert(s, 'expenses', upd);
    nameReceiptFile(s, upd);
    return reply(from, ['Updated your last receipt:', expenseLine(upd, data)].join('\n'));
  }

  if (res.kind === 'payfull') {
    if (res.missing) return reply(from, res.missing);
    const targets = res.ids.length
      ? res.ids.map((id) => data.orders.find((o) => o.id === id) || { id, missing: true })
      : data.orders.filter((o) => o.date && o.date < res.before && o.status !== 'cancelled').sort((a, b) => a.date.localeCompare(b.date));
    const done = [], skipped = [];
    let n = 0, total = 0;
    for (const o of targets) {
      if (o.missing) { skipped.push(`#${o.id} (no such order)`); continue; }
      if (o.status === 'cancelled') { skipped.push(`#${o.id} (cancelled)`); continue; }
      const owing = Math.round((orderTotal(o) - paid(o.id)) * 100) / 100;
      if (orderTotal(o) <= 0) { skipped.push(`#${o.id} ${o.customer} (total is $0, add prices first)`); continue; }
      if (owing <= 0.005) continue;
      const rec = clean('payments', { orderId: o.id, amount: owing, method: res.method, date: res.date, note: ['Paid in full', res.method === 'Other' ? 'method not given' : '', 'via WhatsApp'].filter(Boolean).join(' · ') });
      rec.id = 'p-' + msgId.slice(-10).replace(/[^A-Za-z0-9]/g, '') + '-' + (++n);
      rec.createdAt = new Date().toISOString();
      rec.createdBy = `${who} (WhatsApp)`;
      rec.source = msgId;
      await upsert(s, 'payments', rec);
      done.push(`#${o.id} ${o.customer} ${money(owing)}`); total += owing;
    }
    const lines = done.length
      ? [`💰 Marked ${done.length} order${done.length > 1 ? 's' : ''} as paid in full (${money(total)}${res.method !== 'Other' ? ' ' + res.method.toLowerCase() : ''}):`, ...done]
      : ['Nothing to record. Those orders are already fully paid.'];
    if (skipped.length) lines.push('', 'Skipped:', ...skipped);
    return reply(from, lines.join('\n'));
  }

  if (res.kind === 'payment' && res.payment) {
    const p = res.payment;
    const order = data.orders.find((x) => x.id === String(p.orderId || '').replace(/\D/g, ''));
    if (!order || !(Number(p.amount) > 0)) return reply(from, `I couldn't record that payment. ${res.missing || 'Please include the order number (e.g. #1004) and the amount.'}`);
    const rec = clean('payments', {
      orderId: order.id, amount: Number(p.amount), method: ['Cash', 'Card', 'Bank transfer', 'Other'].includes(p.method) ? p.method : 'Cash',
      date: validDate(p.date) ? p.date : today, note: [p.note, 'via WhatsApp'].filter(Boolean).join(' · '),
    });
    rec.id = 'p-' + msgId.slice(-10).replace(/[^A-Za-z0-9]/g, '');
    rec.createdAt = new Date().toISOString();
    rec.createdBy = `${who} (WhatsApp)`;
    rec.source = msgId;
    await upsert(s, 'payments', rec);
    const left = Math.max(0, orderTotal(order) - paid(order.id) - rec.amount);
    return reply(from, `💰 ${money(rec.amount)} ${rec.method.toLowerCase()} recorded for #${order.id} (${order.customer}).\n${left > 0.005 ? `Still owing ${money(left)}.` : 'Fully paid.'}`);
  }

  return reply(from, (res.missing ? res.missing + '\n\n' : '') + HELP);
}

export default async function handler(req, res) {
  // Webhook verification when you click "Verify and save" in Meta.
  if (req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    if (q.get('hub.mode') === 'subscribe' && process.env.WHATSAPP_VERIFY_TOKEN && q.get('hub.verify_token') === process.env.WHATSAPP_VERIFY_TOKEN) {
      res.statusCode = 200; res.setHeader('Content-Type', 'text/plain'); return res.end(q.get('hub.challenge') || '');
    }
    res.statusCode = 403; return res.end('Forbidden');
  }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }

  const raw = await rawBody(req);
  if (!validSignature(req, raw)) { res.statusCode = 401; return res.end('Bad signature'); }

  let body; try { body = JSON.parse(raw.toString('utf8')); } catch { res.statusCode = 400; return res.end(); }
  const allowed = senders();
  const jobs = [];
  for (const entry of body.entry || []) for (const change of entry.changes || []) {
    for (const m of (change.value && change.value.messages) || []) {
      const from = String(m.from || '').replace(/\D/g, '');
      if (!allowed[from]) { console.log('Ignored message from unlisted number'); continue; }
      if (m.type === 'interactive') {
        const tap = (m.interactive && (m.interactive.list_reply || m.interactive.button_reply)) || {};
        if (tap.id) jobs.push(handleTap(from, allowed[from], tap.id, m.id).catch(async (e) => { console.error(e); await reply(from, 'Something went wrong. Please try again in a minute, or use the app.'); }));
        continue;
      }
      if (m.type === 'image' || m.type === 'document') {
        jobs.push(handleMedia(from, allowed[from], m).catch(async (e) => { console.error(e); await reply(from, e.setup ? 'The app isn’t connected to Google Drive yet.' : 'Something went wrong saving that receipt. Please try again, or add it in the app.'); }));
        continue;
      }
      if (m.type !== 'text') { jobs.push(reply(from, 'For now I can only read text messages. Type the order out and send it again.')); continue; }
      jobs.push(handleText(from, allowed[from], m.text.body || '', m.id).catch(async (e) => {
        console.error(e);
        await reply(from, e.setup ? 'The app isn’t connected to Google Drive yet.' : 'Something went wrong saving that. Please try again in a minute, or add it in the app.');
      }));
    }
  }
  await Promise.all(jobs);
  res.statusCode = 200; res.end('ok');
}
