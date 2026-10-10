// Pulls the total, date and shop out of a receipt's scanned text.
// Shared by the app (in the browser) and the WhatsApp bot (on the server), so keep it plain JavaScript.

const SHOPS = [
  ['Woolworths', /wool\s*worths|woolies/i, 'Groceries'],
  ['Coles', /\bcoles\b/i, 'Groceries'],
  ['Aldi', /\baldi\b/i, 'Groceries'],
  ['IGA', /\biga\b/i, 'Groceries'],
  ['Costco', /costco/i, 'Groceries'],
  ['Harris Farm', /harris\s*farm/i, 'Vegetables'],
  ['Patel Brothers', /patel\s*bro/i, 'Spices & dry goods'],
  ['Bunnings', /bunnings/i, 'Hire & equipment'],
  ['Kmart', /\bkmart\b/i, 'Hire & equipment'],
  ['Big W', /\bbig\s*w\b/i, 'Hire & equipment'],
  ['Officeworks', /officeworks/i, 'Packaging'],
  ['Campbells', /campbells/i, 'Groceries'],
  ['Metro Petroleum', /metro\s*petrol/i, 'Gas & fuel'],
  ['BP', /\bbp\b/i, 'Gas & fuel'],
  ['Shell', /\bshell\b/i, 'Gas & fuel'],
  ['Ampol', /\bampol\b|caltex/i, 'Gas & fuel'],
  ['7-Eleven', /7\s*-?\s*eleven/i, 'Gas & fuel'],
];
const CATEGORY_WORDS = [
  [/\b(veg|veggies|vegetables?|fruits?|produce|markets?)\b/i, 'Vegetables'],
  [/\b(milk|dairy|paneer|yoghurt|yogurt|curd|ghee)\b/i, 'Dairy'],
  [/\b(spices?|masala|dal|rice|atta|flour|besan|indian|asian|grocers?|patel)\b/i, 'Spices & dry goods'],
  [/\b(container|foil|tray|packag|bag|box|cling)\b/i, 'Packaging'],
  [/\b(gas|fuel|petrol|diesel|unleaded|lpg)\b/i, 'Gas & fuel'],
];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');

function money(s) {
  // OCR often reads "84.20" as "84,20" or "84 . 20"
  const m = String(s).replace(/\s*([.,])\s*(?=\d{2}\b)/g, '.').match(/(\d{1,5}(?:,\d{3})*\.\d{2})(?!\d)/g);
  return m ? m.map((x) => Number(x.replace(/,/g, ''))) : [];
}

export function readReceipt(text, today) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const all = lines.join('\n');

  // Total: the biggest amount on a "total / amount due / card" line, skipping subtotal, GST, change, savings.
  const skip = /sub\s*-?\s*total|\bgst\b|\btax\b|change|rounding|discount|saving|saved|points|cash\s*tend|tendered|you\s*saved|incl/i;
  const strong = /\b(total|amount\s*due|balance\s*due|to\s*pay|grand\s*total|total\s*due|amount\s*paid|purchase|eftpos|visa|mastercard|debit|credit|card|paid)\b/i;
  let amount = 0;
  const totalLines = lines.map((l, i) => ({ l, i })).filter(({ l }) => /\btotal\b/i.test(l) && !skip.test(l));
  for (const { l, i } of totalLines) {
    const here = money(l).concat(money(lines[i + 1] || '')); // the amount is sometimes on the next line
    if (here.length) amount = Math.max(amount, here[0]);
  }
  if (!amount) {
    for (const l of lines) if (strong.test(l) && !skip.test(l)) { const v = money(l); if (v.length) amount = Math.max(amount, ...v); }
  }
  if (!amount) {
    const v = lines.filter((l) => !skip.test(l)).flatMap(money).filter((x) => x < 20000);
    if (v.length) amount = Math.max(...v);
  }

  // Date: 10/10/2026, 10-10-26, 10.10.26, 2026-10-10, 10 Oct 2026
  let date = '';
  const base = new Date((today || new Date().toISOString().slice(0, 10)) + 'T00:00');
  const ok = (y, m, d) => {
    if (y < 100) y += 2000;
    const dt = new Date(y, m - 1, d);
    if (dt.getMonth() !== m - 1 || dt > new Date(base.getTime() + 2 * 86400000) || base - dt > 400 * 86400000) return '';
    return `${y}-${pad(m)}-${pad(d)}`;
  };
  let m;
  for (const l of lines) {
    if ((m = l.match(/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/)) && (date = ok(+m[1], +m[2], +m[3]))) break;
    if ((m = l.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2}|\d{4})\b/)) && (date = ok(+m[3], +m[2], +m[1]))) break;
    if ((m = l.toLowerCase().match(/\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*,?\s*(\d{2,4})\b/)) && (date = ok(+m[3], MONTHS.indexOf(m[2]) + 1, +m[1]))) break;
  }

  // Shop: a known name anywhere, otherwise the first line that looks like a business name.
  let vendor = '', category = '';
  const shop = SHOPS.find(([, re]) => re.test(all));
  if (shop) { vendor = shop[0]; category = shop[2]; }
  else {
    const first = lines.slice(0, 6).find((l) => /[a-z]{3,}/i.test(l) && !/tax\s*invoice|receipt|invoice|abn|acn|phone|ph:|tel|www\.|http|@|welcome|thank|order|table|date|time/i.test(l) && (l.match(/[a-z]/gi) || []).length >= l.length * 0.5);
    if (first) vendor = first.replace(/[^a-z0-9&' .-]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 40).replace(/\b([a-z])([a-z]*)/gi, (_, a, b) => a.toUpperCase() + b.toLowerCase());
  }
  if (!category) { const c = CATEGORY_WORDS.find(([re]) => re.test(all)); category = c ? c[1] : ''; }

  return { amount: Math.round(amount * 100) / 100, date, vendor, category };
}
