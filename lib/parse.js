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
  equipment: 'equipment', equip: 'equipment',
};
const UNITS = { kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', g: 'kg', gm: 'kg', gms: 'kg', gram: 'kg', grams: 'kg', pc: 'pcs', pcs: 'pcs', piece: 'pcs', pieces: 'pcs', nos: 'pcs', box: 'box', boxes: 'box', tray: 'tray', trays: 'tray', plate: 'plate', plates: 'plate' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_RE = [/\bsun(day)?\b/, /\bmon(day)?\b/, /\btue(s|sday)?\b/, /\bwed(nesday)?\b/, /\bthu(r|rs|rsday)?\b/, /\bfri(day)?\b/, /\bsat(urday)?\b/];
const MONTH_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\b/;
const weekdayOf = (t) => DAY_RE.findIndex((r) => r.test(t));

// Standard farsan prices (AUD per kg), used when a message doesn't give a price.
// Keep in step with STANDARD_PRICES in public/index.html.
export const STANDARD_PRICES = [
  { match: /\bsev\s*kham|\bkhama?ni\b/i, perKg: 30 },
  { match: /\bvati\s*\w*\s*(na\s*)?kh?aman/i, perKg: 30 },
  { match: /\bnylon\s*kham/i, perKg: 30 },
];
export function standardPrice(name, unit) {
  if (unit !== 'kg') return 0;
  const p = STANDARD_PRICES.find((x) => x.match.test(String(name || '')));
  return p ? p.perKg : 0;
}

const num = (s) => { const m = String(s || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : 0; };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const DAY_MS = 86400000;
/** A day and month with no year: pick the year whose weekday matches when one is given ("Saturday 3 Oct"),
 *  otherwise this year, unless that's more than 4 months ago (then next year). */
function withYear(day, mon, t, base) {
  const wd = weekdayOf(t);
  const cands = [-1, 0, 1].map((k) => new Date(base.getFullYear() + k, mon, day)).filter((d) => d.getDate() === day);
  if (wd >= 0) {
    const hit = cands.filter((d) => d.getDay() === wd).sort((a, b) => Math.abs(a - base) - Math.abs(b - base))[0];
    if (hit) return hit;
  }
  const d = new Date(base.getFullYear(), mon, day);
  if (d < base && base - d > 122 * DAY_MS) d.setFullYear(d.getFullYear() + 1);
  return d;
}

/** "18/10", "18/10/2026", "7/8/26", "18 Oct", "Sunday 4th Oct", "Oct 18", "Saturday", "today", "tomorrow", "2026-10-18" -> YYYY-MM-DD */
export function parseDate(text, today) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return '';
  const base = new Date(today + 'T00:00');
  let m;
  if ((m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(new Date(+m[1], +m[2] - 1, +m[3]));
  if (/\btoday\b|\btonight\b/.test(t)) return today;
  if (/\btomorrow\b|\btmrw?\b|\btomo\b/.test(t)) { base.setDate(base.getDate() + 1); return iso(base); }
  if ((m = t.match(/(?:^|[^\d$.])(\d{1,2})\s*[\/-]\s*(\d{1,2})(?:\s*[\/-]\s*(\d{2,4}))?(?![\d:])/)) && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) {
    if (m[3]) { let y = +m[3]; if (y < 100) y += 2000; return iso(new Date(y, +m[2] - 1, +m[1])); }
    return iso(withYear(+m[1], +m[2] - 1, t, base));
  }
  const mm = t.match(MONTH_RE);
  if (mm) {
    const mi = MONTHS.indexOf(mm[1]);
    const near = t.replace(/\d{1,2}[:.]\d{2}|\d{1,2}\s*(am|pm)\b/g, ' ');
    if ((m = near.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/)) && +m[1] >= 1 && +m[1] <= 31) {
      const yr = (t.match(/\b(20\d{2})\b/) || [])[1];
      return iso(yr ? new Date(+yr, mi, +m[1]) : withYear(+m[1], mi, t, base));
    }
  }
  const di = weekdayOf(t);
  if (di >= 0) {
    let add = (di - base.getDay() + 7) % 7;
    if (/\bnext\b/.test(t) && add === 0) add = 7;
    base.setDate(base.getDate() + add);
    return iso(base);
  }
  return '';
}

/** "6:30pm", "6.30 pm", "18:30", "4pm", "4 PM", "noon" -> HH:MM (looks through the whole text) */
export function parseTime(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/\bnoon\b|\bmidday\b/.test(t)) return '12:00';
  for (const m of t.matchAll(/(?<![\d\/.$-])(\d{1,2})(?:([:.])(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?![\d\/])/g)) {
    const ap = m[4] ? m[4][0] : '';
    if (!m[3] && !ap) continue;           // a bare number is not a time
    if (m[2] === '.' && !ap) continue;    // "8.30" only with am/pm
    let h = +m[1]; const min = m[3] ? +m[3] : 0;
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    if (h > 23 || min > 59) continue;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  return '';
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
  if (/\d\s*(g|gm|gms|grams?)\b/i.test(line) && unit === 'kg' && qty >= 50) qty = qty / 1000; // grams -> kg
  if (!price) { const tp = name.match(/\s\$?(\d+(?:\.\d+)?)$/); if (tp && qty) { price = +tp[1]; name = name.slice(0, tp.index); } }
  name = name.replace(/\s+/g, ' ').replace(/^(of|x)\s+/i, '').replace(/[\s:.,–-]+$/, '').trim();
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


// ---------------------------------------------------------------------------
// Loose reader: messages as people actually write or forward them, e.g.
//   "Hi Ketan … Menu: … Details: Saturday 03 October, $25 pp, 15 people"
//   "1kg sev khamni / Sunday kunalbhai"
//   "Saturday 5/9 / 500gm vatidal khaman / Kalpanaben / 1kg sev khamani / Urvishbhai"
// ---------------------------------------------------------------------------
const GREETING = /^(hi|hii+|hello|hey|dear|namaste|jai shree krishna|jsk|good\s+(morning|afternoon|evening))\b[\s,!.]*/i;
const BOILER = /thank(s| you)|look forward|order is confirmed|please (review|let us know|note)|let us know if|as per (the )?talk|we will let you know|regards|for choosing|for contacting|rinse|return within|^(ok|okay|noted|done|confirmed)\b/i;
const HEADER = /^(menu|details|order details|event details|pick\s*-?\s*up details|delivery details|pick\s*-?\s*up address|pick address|delivery address|address|venue|location|equipment|items|order|notes?)\s*[:\-–]?\s*(.*)$/i;
const EQUIP = /\b(bucket|buckets|tray|trays|container|containers|bain[\s-]*maries?|chafing|dish(es)?|pot|pots|tub|tubs|ladle|ladles|vessel|vessels|tiffin|esky)\b/i;
const MONEY_LINE = /\$|\b\d+\s*(pp|pl|p\/p|pax|people|persons|guests?|ppl|adults)\b|\bper\s*(person|head|plate)\b|\btotal\b|\b(guests?|people|pax)\s*[:\-–]?\s*\d|\btentative/i;
const TIMEWORD = /^(morning|evening|afternoon|lunch|dinner|breakfast|night|tonight)\b/i;
const DATEISH = (l) => /\b(today|tomorrow|tmrw?|tonight)\b/i.test(l) || weekdayOf(l.toLowerCase()) >= 0
  || /(?:^|[^\d$.])\d{1,2}\s*[\/-]\s*\d{1,2}(?![\d:])/.test(l) || (MONTH_RE.test(l.toLowerCase()) && /\b\d{1,2}(st|nd|rd|th)?\b/.test(l));
const strongDate = (l) => /(?:^|[^\d$.])\d{1,2}\s*[\/-]\s*\d{1,2}(?![\d:])/.test(l) || (MONTH_RE.test(l.toLowerCase()) && /\b\d{1,2}(st|nd|rd|th)?\b/.test(l));
const isNameLine = (l) => l.length <= 40 && /^[a-z][a-z .'&()-]*$/i.test(l) && l.split(/\s+/).length <= 4 && !DATEISH(l) && !TIMEWORD.test(l) && !EQUIP.test(l)
  && !/^(order|pick\s*-?\s*up|pickup|delivery|deliver|collect|menu|details|total|note|notes|paid|cash|card)\b/i.test(l);
const stripDate = (l) => l
  .replace(/\b(pick\s*-?\s*up|pickup|delivery|deliver|date|time|on|at|by|for)\b\s*[:\-–]?/gi, ' ')
  .replace(/\b(today|tomorrow|tmrw?|tonight|next)\b/gi, ' ')
  .replace(/\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(day|sday|nesday|rsday|urday)?\b\.?/gi, ' ')
  .replace(/\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?/gi, ' ')
  .replace(/(?:^|\s)\d{1,2}\s*[\/-]\s*\d{1,2}(\s*[\/-]\s*\d{2,4})?\.?(?=\s|$)/g, ' ')
  .replace(/\b\d{1,2}([:.]\d{2})?\s*(am|pm)\b|\b\d{1,2}:\d{2}\b/gi, ' ')
  .replace(/[|,]/g, ' ').replace(/\s+/g, ' ').trim();
const titleCase = (n) => String(n || '').replace(/\b([a-z])/g, (c) => c.toUpperCase());
const cleanLine = (l) => l.replace(/[⁠​‎‏﻿]/g, '').replace(/[*_~]/g, '').replace(/^\s*(?:[-•▪●]\s*|\d+[.)]\s+|\d+\)\s*)/, '').replace(/\s+/g, ' ').trim();

function moneyDetails(text) {
  const t = text.replace(/,(?=\d{3}\b)/g, '');
  const used = [];
  const take = (re) => { const m = t.match(re); if (m) used.push(m.index); return m; };
  let guests = 0, perGuest = 0, deliveryFee = 0, total = 0, guestNote = '';
  let m = take(/\b(\d+)\s*(?:-|to)\s*(\d+)\s*(people|persons|guests?|pax|ppl|adults)\b/i);
  if (m) { guests = +m[1]; guestNote = `Tentatively ${m[1]} to ${m[2]} guests`; }
  if (!guests && (m = t.match(/\btentative(?:ly)?\s*(\d+)\s*(?:-|to)\s*(\d+)/i))) { guests = +m[1]; guestNote = `Tentatively ${m[1]} to ${m[2]} guests`; }
  if (!guests && (m = take(/\b(\d+)\s*(people|persons|guests?|pax|ppl|adults)\b/i))) guests = +m[1];
  if (!guests && (m = t.match(/\bguests?\s*[:\-–]?\s*(\d+)/i))) guests = +m[1];
  if ((m = t.match(/\$\s*(\d+(?:\.\d+)?)\s*(?:pp|pl|p\/p|per\s*(?:person|head|plate|guest)|\/\s*(?:head|person|plate|pp)|each|a head|per)\b/i))) perGuest = +m[1];
  const bare = t.match(/(?<![$\d.])(\d+(?:\.\d+)?)\s*(?:pp|pl|p\/p|per\s*(?:person|head|plate))\b/i);
  if ((m = t.match(/\$\s*(\d+(?:\.\d+)?)\s*(?:for\s*)?delivery\b/i) || t.match(/\bdelivery\s*(?:fee|charge|cost)?\s*[:\-–]?\s*\$\s*(\d+(?:\.\d+)?)/i))) deliveryFee = +m[1];
  if ((m = t.match(/\btotal\s*(?:amount)?\s*[:\-–=]?\s*\$?\s*(\d+(?:\.\d+)?)/i) || t.match(/=\s*\$?\s*(\d+(?:\.\d+)?)/))) total = +m[1];
  if (!total) {
    // a lone dollar amount that isn't the per-head price or the delivery fee is the total
    const amounts = [...t.matchAll(/\$\s*(\d+(?:\.\d+)?)(?![\d.])(?!\s*(?:pp|pl|p\/p|per|each|\/|for\s*delivery|delivery))/gi)].map((x) => +x[1]).filter((v) => v !== deliveryFee || !deliveryFee);
    if (amounts.length) total = Math.max(...amounts);
  }
  if (bare && !perGuest) {
    if (!guests && total && Number.isInteger(+bare[1]) && +bare[1] > 0) { guests = +bare[1]; } // "10 pp, $170" = 10 people
    else perGuest = +bare[1];
  }
  if (guests && !perGuest && total) perGuest = Math.round(((total - deliveryFee) / guests) * 10000) / 10000;
  let otherAmount = 0;
  if (total && guests && perGuest) { const rest = Math.round((total - guests * perGuest - deliveryFee) * 100) / 100; if (rest > 0.005) otherAmount = rest; }
  else if (total && !guests) otherAmount = total;
  return { guests, perGuest, deliveryFee, otherAmount, total, guestNote };
}

/** "Rameshbhai 2kg nylon khaman" -> { item: 2kg Nylon khaman, name: "Rameshbhai" } (only for the standard farsan names) */
function splitItemName(str) {
  const q = str.match(/(\d+(?:\.\d+)?)\s*(kg|kgs|kilo|kilos|g|gm|gms|grams?)\b\s*(?:of\s+)?/i);
  if (!q) return null;
  const after = str.slice(q.index + q[0].length);
  const m = after.match(/^((sev\s*)?khama?ni|se\s*khama?ni|vati\s*\w*\s*(na\s*)?kh?aman(\s+palak)?|nylon\s*kh?aman)\b/i);
  if (!m) return null;
  const item = parseItem(q[0] + m[0]);
  const name = (str.slice(0, q.index) + ' ' + after.slice(m[0].length)).replace(/[-–:,.|]/g, ' ').replace(/\s+/g, ' ').trim();
  return item ? { item, name } : null;
}

export function parseLoose(text, { today, team = [] }) {
  const teamRe = team.length ? new RegExp('^(' + team.map((n) => n.replace(/[^a-z]/gi, '')).filter(Boolean).join('|') + ')\\b', 'i') : null;
  const src = String(text || '');
  // a one-line note like "1kg sev khamni, Sunday, Kunalbhai" reads like separate lines
  const lines = (src.includes('\n') || /\$/.test(src) ? src.split('\n') : src.split(/\s*,\s*/)).map(cleanLine);
  let customer = '', section = '', dateLine = '', timeLine = '', address = '', fulText = '';
  const menu = [], items = [], equipment = [], notes = [], moneyLines = [], dateCands = [], loose = [];
  const groups = []; let cur = { name: '', items: [] }; let nameFirst = null; const dateNames = [];

  lines.forEach((l, idx) => {
    if (!l) return;
    if (/^order\s*#?\s*\d+\s*[-:–]?$/i.test(l) || /^forwarded$/i.test(l)) return;
    let g;
    if ((g = l.match(GREETING))) {
      const who = l.slice(g[0].length).replace(/[^a-z .'-]/gi, ' ').replace(/\s+/g, ' ').trim();
      if (who && !(teamRe && teamRe.test(who)) && !customer) customer = who.split(' ').slice(0, 3).join(' ');
      return;
    }
    if (BOILER.test(l) && !DATEISH(l) && !MONEY_LINE.test(l)) return;
    if (/musgrave|coopers plains/i.test(l)) return; // Satvik's own pick-up address
    if (/complimentary/i.test(l)) { notes.push(l); return; }
    const h = l.match(HEADER);
    if (h && !(h[1].toLowerCase() === 'order' && !/[:\-–]/.test(l))) {
      const key = h[1].toLowerCase().replace(/\s+/g, ' ');
      const rest = h[2].trim();
      if (/^menu|^items$|^order$/.test(key)) { section = 'menu'; if (rest) menu.push(rest); return; }
      if (/pick ?-?up address|pick address/.test(key)) { section = 'skipaddr'; return; }
      if (/delivery address|^address|venue|location/.test(key)) { section = 'address'; fulText += ' delivery'; if (rest) address = rest; return; }
      if (/equipment/.test(key)) { section = 'equipment'; if (rest) equipment.push(rest); return; }
      if (/^notes?$/.test(key)) { section = 'notes'; if (rest) notes.push(rest); return; }
      if (/pick ?-?up details/.test(key)) fulText += ' pickup';
      if (/delivery details/.test(key)) fulText += ' delivery';
      section = 'details';
      if (!rest) return;
      l = rest;
    }
    if (section === 'skipaddr') { if (!DATEISH(l) && !MONEY_LINE.test(l)) return; section = 'details'; }
    if (section === 'address' && !DATEISH(l) && !MONEY_LINE.test(l)) { address = address ? address + ', ' + l : l; return; }
    if (/^pick\s*-?\s*up\b|^pickup\b|^collect/i.test(l)) fulText += ' pickup';
    if (/^deliver/i.test(l) || /\bdelivery\b/i.test(l)) fulText += ' delivery';

    if (EQUIP.test(l) && !MONEY_LINE.test(l)) { equipment.push(l); return; }
    if (MONEY_LINE.test(l)) { moneyLines.push(l); if (!DATEISH(l)) return; }
    const startsWithDish = /^[a-z]/i.test(l) && !/^(pick|deliver|date|time|on|for|sat|sun|mon|tue|wed|thu|fri|today|tomorrow|tmrw|tonight|morning|evening)/i.test(l);
    if (section === 'menu' && startsWithDish && !/\$/.test(l)) {
      const it = parseItem(l);
      menu.push(l);
      if (it && it.unit === 'kg' && STANDARD_PRICES.some((p) => p.match.test(it.name))) items.push({ ...it, fromMenu: true });
      return;
    }
    if (DATEISH(l)) {
      dateCands.push({ l, idx, strong: strongDate(l), keyed: /pick|deliver|date|event/i.test(l) });
      if (parseTime(l)) timeLine = timeLine || l;
      const restOf = stripDate(l);
      const sp = restOf && splitItemName(restOf);
      if (sp) { items.push(sp.item); if (nameFirst === null) nameFirst = false; cur.items.push(sp.item); if (sp.name && isNameLine(sp.name)) dateNames.push(sp.name); return; }
      const it2 = restOf && parseItem(restOf);
      if (it2 && (it2.unit === 'kg' || STANDARD_PRICES.some((p) => p.match.test(it2.name)))) { items.push(it2); if (nameFirst === null) nameFirst = false; cur.items.push(it2); }
      else if (restOf && isNameLine(restOf) && !(teamRe && teamRe.test(restOf))) dateNames.push(restOf);
      return;
    }
    if (parseTime(l) && l.length < 40) { timeLine = timeLine || l; return; }
    if (TIMEWORD.test(l) && l.length < 25) { notes.push(l.charAt(0).toUpperCase() + l.slice(1)); return; }
    const sp = splitItemName(l);
    if (sp && sp.name && isNameLine(sp.name)) { items.push(sp.item); if (nameFirst === null) nameFirst = false; cur.items.push(sp.item); dateNames.push(sp.name); return; }
    const it = parseItem(l);
    if (it && (it.unit === 'kg' || STANDARD_PRICES.some((p) => p.match.test(it.name)))) {
      items.push(it);
      if (nameFirst === null) nameFirst = false;
      cur.items.push(it);
      return;
    }
    if (isNameLine(l)) {
      if (teamRe && teamRe.test(l) && l.split(' ').length <= 2) return;
      if (nameFirst === null) nameFirst = true;
      if (nameFirst) { if (cur.name || cur.items.length) groups.push(cur); cur = { name: l, items: [] }; }
      else { cur.name = l; groups.push(cur); cur = { name: '', items: [] }; }
      loose.push(l);
      return;
    }
    if (section === 'menu' || section === 'details' || startsWithDish) { loose.push(l); return; }
    notes.push(l);
  });
  if (cur.name || cur.items.length) groups.push(cur);
  if (!customer && dateNames.length) customer = dateNames[0];
  customer = titleCase(customer); groups.forEach((g) => { g.name = titleCase(g.name); });

  // date: prefer a full date ("10 Oct", "5/9") on a pick-up / delivery line, then any full date, then a weekday
  dateCands.sort((a, b) => (b.strong - a.strong) || (b.keyed - a.keyed) || (a.idx - b.idx));
  dateLine = dateCands.length ? dateCands[0].l : '';
  const date = parseDate(dateLine, today);
  const time = parseTime(dateLine) || parseTime(timeLine);
  const md = moneyDetails(moneyLines.join('\n'));
  const fulfilment = /delivery/.test(fulText) && !/pickup/.test(fulText.replace(/.*delivery/, '')) ? 'delivery' : (md.deliveryFee ? 'delivery' : 'pickup');
  const isCatering = !!(md.guests || md.perGuest || (menu.length && !groups.some((g) => g.items.length)));
  const base = { date, time, status: 'confirmed', fulfilment, address, deliveryFee: md.deliveryFee, otherAmount: 0, phone: '', occasion: '', equipment: equipment.join('\n') };

  if (isCatering) {
    // short lines that were not the name are dishes when there's no Menu: header (e.g. Charul's message)
    const names = loose.filter(isNameLine);
    if (!customer && names.length && lines.findIndex((x) => x === names[0]) <= lines.findIndex((x) => x && !GREETING.test(x))) customer = names.shift();
    const rest = loose.filter((x) => x !== customer);
    const allMenu = [...menu, ...rest.filter((x) => !menu.includes(x))];
    const order = {
      ...base, type: 'catering', customer,
      guests: md.guests, perGuest: md.perGuest, otherAmount: md.otherAmount,
      menu: allMenu.join('\n'), items: [],
      notes: [md.guestNote, ...notes].filter(Boolean).join('\n'),
    };
    if (md.otherAmount && !md.deliveryFee && /\$\s*\d+\s*for\s+(\w[\w ]*)/i.test(moneyLines.join('\n'))) order.notes = [order.notes, `Other charges: ${moneyLines.join(' ').match(/\$\s*\d+\s*for\s+[\w ]+/i)[0]}`].filter(Boolean).join('\n');
    return { kind: 'order', orders: [order], missing: missingFor(order) };
  }

  const farsanGroups = groups.filter((g) => g.items.length);
  if (farsanGroups.length) {
    if (!farsanGroups.some((g) => g.name) && customer) farsanGroups[0].name = customer;
    const orders = farsanGroups.map((g) => ({
      ...base, type: 'farsan', customer: g.name, guests: 0, perGuest: 0, menu: '',
      items: g.items, notes: notes.join('\n'),
    }));
    return { kind: 'order', orders, missing: orders.map(missingFor).filter(Boolean).join(' ') };
  }
  return { kind: 'other', missing: '' };
}

function missingFor(o) {
  const miss = [];
  if (!o.customer) miss.push('name');
  if (!o.date) miss.push('date');
  if (o.type === 'catering' && !o.guests) miss.push('guests');
  return miss.join(',');
}

/** "#1023 name Kunal", "name #1023 Kunal", "#1023 date 24/10", "#1023 guests 150", "#1023 time 9am" */
function parseSet(text, today) {
  const F = '(name|customer|date|time|guests|people|pax|price|pp|address|phone|notes?|occasion)';
  const m = text.match(new RegExp(`^\\s*#\\s*(\\d{4,})\\s+${F}\\b\\s*[:\\-–=]?\\s*([\\s\\S]+)$`, 'i'))
    || text.match(new RegExp(`^\\s*${F}\\s+(?:for\\s+)?#\\s*(\\d{4,})\\s*[:\\-–=]?\\s*([\\s\\S]+)$`, 'i'));
  if (!m) return null;
  const [id, field, value] = /^\d/.test(m[1]) ? [m[1], m[2], m[3]] : [m[2], m[1], m[3]];
  const f = field.toLowerCase();
  const v = value.trim();
  const changes = {};
  if (/name|customer/.test(f)) changes.customer = v;
  else if (f === 'date') changes.date = parseDate(v, today);
  else if (f === 'time') changes.time = parseTime(v);
  else if (/guests|people|pax/.test(f)) changes.guests = num(v);
  else if (/price|pp/.test(f)) changes.perGuest = num(v);
  else if (f === 'address') { changes.address = v; changes.fulfilment = 'delivery'; }
  else if (f === 'phone') changes.phone = v;
  else if (f === 'occasion') changes.occasion = v;
  else changes.notes = v;
  const bad = (changes.date === '' && 'date') || (changes.time === '' && 'time');
  return { kind: 'set', id, changes, missing: bad ? `I couldn't read that ${bad}.` : '' };
}


/** "spent $84.20 Woolworths #1004", "expense $45 gas #1003 #1004", "bought $30 vegetables" */
export function parseExpenseText(text) {
  const t = String(text || '');
  const amt = t.replace(/#\s*\d+/g, ' ').match(/\$\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)|\b(\d+(?:,\d{3})*\.\d{2})\b|\b(\d+)\s*(?:dollars|aud)\b/i);
  const amount = amt ? num(amt[1] || amt[2] || amt[3]) : 0;
  const orderIds = [...t.matchAll(/#\s*(\d{4,})/g)].map((m) => m[1]);
  const vendor = t.replace(/^\s*(spent|spend|expense|exp|bought|purchased?|receipt|paid to)\b/i, ' ')
    .replace(/#\s*\d+/g, ' ').replace(/\$\s*[\d,.]+/g, ' ').replace(/\b\d+(?:\.\d+)?\s*(dollars|aud)?\b/gi, ' ')
    .replace(/\b(at|from|for|on|to|order|orders|and|cash|card|eftpos)\b/gi, ' ').replace(/[^a-z0-9&' -]/gi, ' ').replace(/\s+/g, ' ').trim();
  return { amount, orderIds: [...new Set(orderIds)], vendor: vendor.slice(0, 40).replace(/\b([a-z])/g, (c) => c.toUpperCase()) };
}

export function parseMessage(text, { today, team = [] }) {
  const raw = String(text || '').trim();
  const first = raw.split('\n')[0].trim().toLowerCase();

  if (/^(catering|farsan|sweet|sweets|template|form|new order|new)\s*\??$/i.test(raw)) {
    return { kind: 'template', which: /farsan|sweet/.test(first) ? 'farsan' : /catering/.test(first) ? 'catering' : 'both' };
  }

  const full = parsePaidInFull(raw, today);
  if (full) return full;

  const set = parseSet(raw, today);
  if (set) return set;

  if (/^\s*receipt\b/i.test(raw) && raw.length < 120) return { kind: 'receipt-edit', ...parseExpenseText(raw) };
  if (/^\s*(spent|spend|expense|exp|bought|purchased?|paid to)\b/i.test(raw) && raw.length < 160) {
    const e = parseExpenseText(raw);
    return { kind: 'expense', ...e, missing: e.amount ? '' : 'How much was it? e.g. *spent $84.20 Woolworths #1004*' };
  }

  let rm;
  if ((rm = raw.match(/^\s*(?:returned|back|equipment (?:returned|back))\s*#?\s*(\d{4,})\s*$/i) || raw.match(/^\s*#?\s*(\d{4,})\s+(?:returned|back|equipment returned|equipment back)\s*$/i))) return { kind: 'returned', id: rm[1] };
  if (/^\s*(equipment|equip|buckets|what'?s out|equipment out)\s*\??\s*$/i.test(raw)) return { kind: 'equipment' };
  if (raw.length <= 30 && !/\n/.test(raw)) {
    const q = raw.replace(/^(orders?|what'?s on|show|list|prep|make)\s*(for|on)?\s*/i, '').replace(/[?!.]+$/, '').trim();
    if (q && q.split(/\s+/).length <= 3 && /^(today|tomorrow|tmrw?|tonight|next\s+\w+|\w+day|mon|tue|tues|wed|thu|thur|fri|sat|sun|\d{1,2}\s*[\/-]\s*\d{1,2}(\s*[\/-]\s*\d{2,4})?|\d{1,2}(st|nd|rd|th)?\s+[a-z]+|[a-z]+\s+\d{1,2})$/i.test(q)) {
      const d = parseDate(q, today);
      if (d) return { kind: 'day', date: d };
    }
  }

  const pay = parsePayment(raw, today);
  if (pay && raw.split('\n').filter((l) => l.trim()).length <= 3 && !/\n\s*(name|guests|items|menu)\s*:/i.test(raw)) return pay;

  const isForm = /^(catering|farsan|sweets?)\s*$/i.test(first) || /^\s*name\s*:/im.test(raw);
  if (!isForm) return parseLoose(raw, { today, team });

  // key: value lines; Menu / Items / Notes may run over several lines
  const fields = {}; let current = null; const extraLines = [];
  for (const line of raw.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    const km = l.match(/^([a-z][a-z ]{1,25}?)\s*[:=-]\s*(.*)$/i);
    const key = km && KEYS[km[1].trim().toLowerCase()];
    if (key) { current = key; fields[key] = (fields[key] ? fields[key] + '\n' : '') + km[2].trim(); }
    else if (current && ['menu', 'items', 'notes', 'address', 'equipment'].includes(current)) fields[current] += '\n' + l;
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
    equipment: (fields.equipment || '').trim(),
  };
  if (!order.time && fields.date) order.time = parseTime(fields.date.replace(/\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?/, ''));

  if (isFarsan && !items.length) return { kind: 'other', missing: 'I couldn\'t see any items, e.g. 2kg sev khamani.' };
  return { kind: 'order', orders: [order], missing: missingFor(order) };
}
