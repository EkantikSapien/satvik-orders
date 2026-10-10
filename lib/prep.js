// Kilos of the standard farsan to make across a set of orders. Keep in step with PREP in public/index.html.
export const PREP = [
  { key: 'sev', label: 'Sev khamani', match: /\bsev\s*kham|\bkhama?ni\b/i },
  { key: 'vatidar', label: 'Vatidar khaman', match: /\bvati\s*\w*\s*(na\s*)?kh?aman/i },
  { key: 'nylon', label: 'Nylon khaman', match: /\bnylon\s*kh?aman/i },
];
const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? 0 : Number(v));

export function prepTotals(orders) {
  const out = Object.fromEntries(PREP.map((p) => [p.key, { kg: 0, orders: new Set(), noQty: [] }]));
  for (const o of orders) {
    if (o.type === 'farsan') {
      for (const i of o.items || []) {
        const p = PREP.find((x) => x.match.test(i.name || '')); if (!p) continue;
        if ((i.unit || 'kg') === 'kg') { out[p.key].kg += num(i.qty); out[p.key].orders.add(o.id); } else out[p.key].noQty.push(o);
      }
    } else {
      for (const line of String(o.menu || '').split('\n')) {
        const p = PREP.find((x) => x.match.test(line)); if (!p) continue;
        const m = line.match(/(\d+(?:\.\d+)?)\s*(kg|kgs|kilo|kilos|g|gm|gms|grams?)\b/i);
        if (m) { out[p.key].kg += /^g/i.test(m[2]) ? num(m[1]) / 1000 : num(m[1]); out[p.key].orders.add(o.id); } else out[p.key].noQty.push(o);
      }
    }
  }
  return out;
}
