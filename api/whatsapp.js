// WhatsApp Cloud API webhook.
// GET  — Meta's one-time webhook verification.
// POST — incoming messages: a team member texts an order or payment in plain words, the app
//        reads it with Claude, saves it to the sheet and replies with what it recorded.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { store, readAll, upsert, nextOrderId, clean, orderTotal } from '../lib/store.js';
import { extract } from '../lib/extract.js';
import { parseMessage, TEMPLATES } from '../lib/parse.js';

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

const HELP = 'Hi! To add an order, send *catering* or *farsan* and I\'ll send a form to copy, fill in and send back.\n\n'
  + 'To record a payment, send e.g. *Paid $500 cash #1004*\n\n'
  + 'To mark orders fully paid: *paid in full #1004 #1006* or *paid in full before today*\n\n'
  + 'Send *owing* to pick from a list of orders still to be paid.';

const paidFor = (data, id) => data.payments.filter((p) => p.orderId === id).reduce((t, p) => t + (Number(p.amount) || 0), 0);
const owingOrders = (data) => data.orders
  .filter((o) => o.status !== 'cancelled' && orderTotal(o) > 0)
  .map((o) => ({ ...o, balance: Math.round((orderTotal(o) - paidFor(data, o.id)) * 100) / 100 }))
  .filter((o) => o.balance > 0.005)
  .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));

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

/** Taps on the list ("pay:1004", "owing:9") and on the payment buttons ("paid:1004:Cash"). */
async function handleTap(from, who, tapId, msgId) {
  const s = await store();
  const data = await readAll(s);
  if (data.payments.some((p) => p.source === msgId)) return;
  const [what, id, method] = tapId.split(':');
  if (what === 'owing') return sendOwingList(from, data, Number(id) || 0);
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
  if (data.orders.some((o) => o.source === msgId) || data.payments.some((p) => p.source === msgId)) return;

  if (/^\s*(help|hi|hello|hey|menu|\?)\s*$/i.test(text)) return reply(from, HELP);
  if (/^\s*(owing|owe|owed|pending|unpaid|due|payments?|pay|balance|balances)\s*\??\s*$/i.test(text)) return sendOwingList(from, data);

  const paid = (id) => data.payments.filter((p) => p.orderId === id).reduce((t, p) => t + (Number(p.amount) || 0), 0);
  const openOrders = data.orders.filter((o) => o.status !== 'cancelled')
    .map((o) => ({ id: o.id, customer: o.customer, date: o.date, balance: Math.max(0, orderTotal(o) - paid(o.id)) }))
    .filter((o) => o.balance > 0.005).slice(-40);

  const today = todayBrisbane();
  // Free rule-based reader by default; uses Claude only if an API key has been added.
  const res = process.env.ANTHROPIC_API_KEY ? await extract(text, { today, openOrders }) : parseMessage(text, { today });

  if (res.kind === 'template') {
    if (res.which === 'both') { await reply(from, 'Copy the form you need, fill it in and send it back:'); await reply(from, TEMPLATES.catering); return reply(from, TEMPLATES.farsan); }
    await reply(from, 'Copy this, fill it in and send it back:');
    return reply(from, TEMPLATES[res.which]);
  }

  if (res.kind === 'order' && res.order) {
    const o = clean('orders', {
      ...res.order,
      status: res.order.status === 'enquiry' ? 'enquiry' : 'confirmed',
      fulfilment: res.order.fulfilment === 'delivery' ? 'delivery' : 'pickup',
      date: validDate(res.order.date) ? res.order.date : '',
      time: validTime(res.order.time) ? res.order.time : '',
      notes: [res.order.notes, `Added from WhatsApp by ${who}`].filter(Boolean).join('\n'),
    });
    if (!o.customer || !o.date) return reply(from, `I couldn't add that yet. ${res.missing || 'Please include the customer name and the date.'} Edit your message and send the whole order again.`);
    o.id = await nextOrderId(s);
    o.createdAt = new Date().toISOString();
    o.createdBy = `${who} (WhatsApp)`;
    o.source = msgId;
    await upsert(s, 'orders', o);
    const what = o.type === 'farsan'
      ? (o.items || []).map((i) => `${i.qty}${i.unit} ${i.name}`).join(', ') || 'no items'
      : `${o.guests || '?'} guests × ${money(o.perGuest)}`;
    const lines = [
      `✅ Order #${o.id} added`,
      `${o.customer} · ${o.type === 'farsan' ? 'Farsan/Sweet' : 'Catering'}`,
      `${niceDate(o.date)}${o.time ? ' ' + niceTime(o.time) : ''} · ${o.fulfilment === 'delivery' ? 'Delivery' + (o.address ? ' to ' + o.address : '') : 'Pickup'}`,
      what,
      `Total ${money(o.total)}`,
    ];
    if (res.missing) lines.push('', `Check: ${res.missing}`);
    lines.push('', `Fix anything in the app: ${APP_URL()}`);
    return reply(from, lines.join('\n'));
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
