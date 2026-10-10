// Free, rule-based reader for WhatsApp messages (no AI service needed).
// Understands the fill-in templates the bot sends back for "catering" / "farsan",
// plus payments like "Paid $500 cash #1004".

export const TEMPLATES = {
  catering: 'CATERING\nName: \nPhone: \nOccasion: \nDate: \nTime: \nGuests: \nPrice per guest: \nPickup or delivery: \nAddress: \nDelivery fee: \nMenu: \nNotes: ',
  farsan: 'FARSAN\nName: \nPhone: \nDate: \nTime: \nPickup or delivery: \nAddress: \nItems:\n2kg sev khamani\n1 box mohanthal $25\nNotes: ',
};

const KEYS = {
  name: 'customer', customer: 'customer', client: 'customer',
  phone: 'phone', mobile: 'phone', number: 'phone', ph: 'phone',
  occasion: 'occasion', event: 'occasion',
  date: 'date', day: 'date',
  time: 'time',
  guests: 'guests', guest: 'guests', people: 'guests', pax: 'guests', 'guest count': 'guests',
  'price per guest': 'perGuest', 'price per head': 'perGuest', 'per guest': 'perGuest', 'per head': 'perGuest', price: 'perGuest', rate: 'perGuest', pp: 'perGuest',
  'pickup or delivery': 'fulfilment', pickup: 'fulfilment', delivery: 'fulfilment', 'delivery or pickup': 'fulfilment', collection: 'fulfilment',
  address: 'address', location: 'address', venue: 'address',
  'delivery fee': 'deliveryFee', 'delivery charge': 'deliveryFee',
  'other charges': 'otherAmount', extra: 'otherAmount', extras: 'otherAmount',
  menu: 'menu', items: 'items', order: 'items',
  notes: 'notes', note: 'notes', other: 'notes', details: 'notes',
  status: 'status', type: 'type',
};
const UNITS = { kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', g: 'kg', gm: 'kg', pc: 'pcs', pcs: 'pcs', piece: 'pcs', pieces: 'pcs', nos: 'pcs', box: 'box', boxes: 'box', tray: 'tray', trays: 'tray', plate: 'plate', plates: 'plate' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Standard farsan prices (AUD per kg), used when a message doesn't give a price.
// Keep in step with STANDARD_PRICES in public/index.html.
export const STANDARD_PRICES = [
  { match: /\bsev\s*kham/i, perKg: 30 },
  { match: /\bvati\w*\s*(na\s*)?kham/i, perKg: 30 },
  { match: /\bnylon\s*kham/i, perKg: 30 },
];
export function standardPrice(name, unit) {
  if (unit !== 'kg') return 0;
  const p = STANDARD_PRICES.find((x) => x.match.test(String(name || '')));
  return p ? p.perKg : 0;
}

const num = (s) => { const m = String(s || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : 0; };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** "18/10", "18/10/2026", "18 Oct", "Oct 18", "Saturday", "sat", "today", "tomorrow", "2026-10-18" -> YYYY-MM-DD */
export function parseDate(text, today) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return '';
  const base = new Date(today + 'T00:00');
  let m;
  if ((m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(new Date(+m[1], +m[2] - 1, +m[3]));
  if (/\btoday\b/.test(t)) return today;
  if (/\btomorrow\b|\btmrw\b/.test(t)) { base.setDate(base.getDate() + 1); return iso(base); }
  if ((m = t.match(/(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?/))) {
    let y = m[3] ? +m[3] : base.getFullYear(); if (y < 100) y += 2000;
    const d = new Date(y, +m[2] - 1, +m[1]);
    if (!m[3] && d < base) d.setFullYear(y + 1);
    return iso(d);
  }
  const mi = MONTHS.findIndex((mo) => new RegExp('\\b' + mo).test(t));
  if (mi >= 0 && (m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/))) {
    const yr = (t.match(/\b(20\d{2})\b/) || [])[1];
    const d = new Date(yr ? +yr : base.getFullYear(), mi, +m[1]);
    if (!yr && d < base) d.setFullYear(d.getFullYear() + 1);
    return iso(d);
  }
  const di = DAYS.findIndex((dy) => new RegExp('\\b' + dy).test(t));
  if (di >= 0) {
    let add = (di - base.getDay() + 7) % 7;
    if (/\bnext\b/.test(t) && add === 0) add = 7;
    base.setDate(base.getDate() + add);
    return iso(base);
  }
  return '';
}

/** "6:30pm", "6.30 pm", "18:30", "4pm", "noon" -> HH:MM */
export function parseTime(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/\bnoon\b|\bmidday\b/.test(t)) return '12:00';
  const m = t.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/);
  if (!m || (!m[2] && !m[3])) return '';
  let h = +m[1]; const min = m[2] ? +m[2] : 0;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** "2kg sev khamani $28", "sev khamani 2 kg @ 28", "1 box mohanthal 25", "50 samosa $1.5" -> item */
export function parseItem(line) {
  let s = String(line || '').trim().replace(/^[-•*]\s*/, '').replace(/^\d+[.)]\s+(?=\S)/, '').trim();
  if (!s) return null;
  let price = 0;
  const pm = s.match(/(?:@|\$|x\s*\$?)\s*(\d+(?:\.\d+)?)\s*(?:\/\s*\w+|each|ea|per\s+\w+)?\s*$/i) || s.match(/\s(\d+(?:\.\d+)?)\s*(?:\/\s*\w+|each|ea|per\s+\w+)\s*$/i);
  if (pm) { price = +pm[1]; s = s.slice(0, pm.index).trim(); }
  let qty = 0, unit = 'pcs';
  const lead = s.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?\b\s*(.*)$/i);
  const trail = s.match(/^(.*?)\s+(\d+(?:\.\d+)?)\s*([a-z]+)?$/i);
  let name = s;
  if (lead) {
    qty = +lead[1];
    if (lead[2] && UNITS[lead[2].toLowerCase()]) { unit = UNITS[lead[2].toLowerCase()]; name = lead[3]; }
    else name = ((lead[2] || '') + ' ' + lead[3]).trim();
  } else if (trail) {
    name = trail[1]; qty = +trail[2];
    if (trail[3] && UNITS[trail[3].toLowerCase()]) unit = UNITS[trail[3].toLowerCase()];
  }
  if (/\b\d+\s*g\b|\bgm\b/i.test(line) && unit === 'kg' && qty >= 50) qty = qty / 1000; // grams -> kg
  if (!price) { const tp = name.match(/\s\$?(\d+(?:\.\d+)?)$/); if (tp && qty) { price = +tp[1]; name = name.slice(0, tp.index); } }
  name = name.replace(/\s+/g, ' ').replace(/^(of|x)\s+/i, '').trim();
  if (!name || !qty) return null;
  if (!price) price = standardPrice(name, unit);
  return { name: name.charAt(0).toUpperCase() + name.slice(1), qty, unit, price };
}

const methodOf = (t, fallback) => /\bcard|eftpos|tap\b/.test(t) ? 'Card' : /\b(transfer|bank|payid|osko)\b/.test(t) ? 'Bank transfer' : /\bcash\b/.test(t) ? 'Cash' : fallback;

/** "paid in full #1004 #1006", "paid in full #1004-1010 cash", "paid in full before today", "paid in full before 10/10 card" */
function parsePaidInFull(text, today) {
  const t = text.toLowerCase();
  if (!/\b(paid in full|fully paid|full payment|all paid|paid all|paid off)\b/.test(t)) return null;
  const ids = [];
  for (const m of text.matchAll(/#?\s*(\d{4,})\s*(?:-|to)\s*#?\s*(\d{4,})/g)) {
    const a = +m[1], b = +m[2];
    if (b >= a && b - a < 500) for (let i = a; i <= b; i++) ids.push(String(i));
  }
  for (const m of text.replace(/#?\s*\d{4,}\s*(?:-|to)\s*#?\s*\d{4,}/g, ' ').matchAll(/#\s*(\d{3,})/g)) ids.push(m[1]);
  let before = '';
  const bm = t.match(/\b(?:before|until|up to|upto|till)\s+(.+)$/);
  if (bm) {
    // "before today" and "up to yesterday" both mean every order dated before today
    if (/\b(yesterday|today|now)\b/.test(bm[1])) before = today;
    else before = parseDate(bm[1], today);
    // "before 10/10" with no year means this year, not next year
    if (before > today && !/\b20\d{2}\b/.test(bm[1])) before = String(+before.slice(0, 4) - 1) + before.slice(4);
    // "up to 9/10" includes the 9th
    if (before && !/^before\b/.test(bm[0]) && !/\b(yesterday|today|now)\b/.test(bm[1])) {
      const d = new Date(before + 'T00:00'); d.setDate(d.getDate() + 1); before = iso(d);
    }
  }
  const all = !ids.length && !before && /\b(past|old|previous|earlier)\b/.test(t);
  if (all) before = today;
  const missing = !ids.length && !before ? 'Which orders? e.g. *paid in full #1004 #1006*, *paid in full #1004-1010*, or *paid in full before today*.' : '';
  return { kind: 'payfull', ids: [...new Set(ids)], before, method: methodOf(t, 'Other'), date: today, missing };
}

function parsePayment(text, today) {
  const t = text.toLowerCase();
  if (!/\b(paid|payment|received|deposit|got)\b/.test(t)) return null;
  const id = (text.match(/#\s*(\d{3,})/) || text.match(/\border\s*(\d{3,})/i) || [])[1];
  const amt = (text.replace(/#\s*\d+/g, '').match(/\$?\s*(\d+(?:,\d{3})*(?:\.\d+)?)/) || [])[1];
  const method = /\bcard|eftpos|tap\b/.test(t) ? 'Card' : /\b(transfer|bank|payid|osko)\b/.test(t) ? 'Bank transfer' : /\bcash\b/.test(t) ? 'Cash' : 'Cash';
  const missing = !id ? 'Which order is it for? Add the order number, e.g. #1004.' : !amt ? 'How much was paid?' : '';
  return { kind: 'payment', payment: { orderId: id || '', amount: amt ? num(amt) : 0, method, date: today, note: /deposit/.test(t) ? 'Deposit' : '' }, missing };
}

export function parseMessage(text, { today }) {
  const raw = String(text || '').trim();
  const first = raw.split('\n')[0].trim().toLowerCase();

  if (/^(catering|farsan|sweet|sweets|template|form|new order|new)\s*\??$/i.test(raw)) {
    return { kind: 'template', which: /farsan|sweet/.test(first) ? 'farsan' : /catering/.test(first) ? 'catering' : 'both' };
  }

  const full = parsePaidInFull(raw, today);
  if (full) return full;

  const pay = parsePayment(raw, today);
  if (pay && !/\n\s*(name|guests|items|menu)\s*:/i.test(raw)) return pay;

  // key: value lines; Menu / Items / Notes may run over several lines
  const fields = {}; let current = null; const extraLines = [];
  for (const line of raw.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    const km = l.match(/^([a-z][a-z ]{1,25}?)\s*[:=-]\s*(.*)$/i);
    const key = km && KEYS[km[1].trim().toLowerCase()];
    if (key) { current = key; fields[key] = (fields[key] ? fields[key] + '\n' : '') + km[2].trim(); }
    else if (current && ['menu', 'items', 'notes', 'address'].includes(current)) fields[current] += '\n' + l;
    else if (/^(catering|farsan|sweets?)\b/i.test(l)) fields.type = fields.type || l;
    else extraLines.push(l);
  }
  if (!Object.keys(fields).length) return { kind: 'other', missing: '' };

  const typeText = (fields.type || first).toLowerCase();
  const items = (fields.items || '').split('\n').map(parseItem).filter(Boolean);
  const isFarsan = /farsan|sweet/.test(typeText) || (!/catering/.test(typeText) && items.length && !fields.guests);
  const fulText = (fields.fulfilment || '').toLowerCase();
  const fulfilment = /deliver/.test(fulText) || (fields.address && !/pick|collect/.test(fulText)) ? 'delivery' : 'pickup';
  const address = fields.address || (fulfilment === 'delivery' && fulText.replace(/^\s*delivery\s*(to)?\s*/i, '').trim()) || '';

  const order = {
    type: isFarsan ? 'farsan' : 'catering',
    customer: (fields.customer || '').trim(),
    phone: (fields.phone || '').trim(),
    occasion: (fields.occasion || '').trim(),
    date: parseDate(fields.date, today),
    time: parseTime(fields.time),
    status: /enquir|inquir|tentative/.test((fields.status || '').toLowerCase()) ? 'enquiry' : 'confirmed',
    fulfilment, address: address.trim(),
    guests: num(fields.guests), perGuest: num(fields.perGuest),
    menu: (fields.menu || '').split(/\n|,/).map((s) => s.trim()).filter(Boolean).join('\n'),
    items: isFarsan ? items : [],
    deliveryFee: num(fields.deliveryFee), otherAmount: num(fields.otherAmount),
    notes: [fields.notes, ...extraLines].filter(Boolean).join('\n').trim(),
  };
  if (!order.time && fields.date) order.time = parseTime(fields.date.replace(/\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?/, ''));

  const miss = [];
  if (!order.customer) miss.push('the customer name (Name: …)');
  if (!order.date) miss.push('the date (Date: 18/10 or Saturday)');
  if (isFarsan && !items.length) miss.push('the items (e.g. 2kg sev khamani $28)');
  if (!isFarsan && !order.guests) miss.push('the guest count');
  return { kind: 'order', order, missing: miss.length ? `Please add ${miss.join(', ')}.` : '' };
}
