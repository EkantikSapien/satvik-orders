// Turns a free-text WhatsApp message into a structured order or payment using the Claude API.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';

const TOOL = {
  name: 'record_message',
  description: 'Record what this WhatsApp message is: a new catering or farsan/sweet order, a payment received against an existing order, or something else.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['order', 'payment', 'other'] },
      order: {
        type: 'object',
        description: 'Only when kind is "order".',
        properties: {
          type: { type: 'string', enum: ['catering', 'farsan'], description: 'catering = an event with guests and price per guest; farsan = takeaway items like sev khamani, dhokla, laddu, sweets' },
          customer: { type: 'string' },
          phone: { type: 'string' },
          occasion: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD. Resolve words like "Saturday" or "next Friday" against today.' },
          time: { type: 'string', description: 'HH:MM, 24-hour' },
          status: { type: 'string', enum: ['enquiry', 'confirmed'] },
          fulfilment: { type: 'string', enum: ['pickup', 'delivery'] },
          address: { type: 'string' },
          guests: { type: 'number' },
          perGuest: { type: 'number', description: 'AUD per guest' },
          menu: { type: 'string', description: 'Catering menu, one dish per line' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                qty: { type: 'number' },
                unit: { type: 'string', enum: ['kg', 'pcs', 'box', 'tray', 'plate'] },
                price: { type: 'number', description: 'AUD per unit; 0 if not given' },
              },
              required: ['name', 'qty', 'unit'],
            },
          },
          deliveryFee: { type: 'number' },
          otherAmount: { type: 'number' },
          notes: { type: 'string', description: 'Anything else: dietary needs, deposit mentioned, special requests' },
        },
      },
      payment: {
        type: 'object',
        description: 'Only when kind is "payment".',
        properties: {
          orderId: { type: 'string', description: 'Order number from the list of open orders' },
          amount: { type: 'number' },
          method: { type: 'string', enum: ['Cash', 'Card', 'Bank transfer', 'Other'] },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          note: { type: 'string' },
        },
      },
      missing: { type: 'string', description: 'If something essential is missing or unclear (order: customer name or date; payment: which order or amount), a short question to ask back. Empty otherwise.' },
    },
    required: ['kind'],
  },
};

export async function extract(text, { today, openOrders }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const system = [
    'You file messages for Satvik, a Gujarati vegetarian catering business in Brisbane, Australia. Money is AUD.',
    `Today is ${today} (Australia/Brisbane).`,
    'Always answer by calling the record_message tool exactly once. Never invent details that are not in the message; leave fields out instead.',
    'A message listing items with quantities (kg, pieces, boxes) is a farsan order. A message with a guest count is a catering order.',
    'If a deposit or payment is mentioned inside a new order, put it in notes (it is recorded separately).',
    'Open orders, for matching payments (number | customer | date | balance):',
    ...(openOrders.length ? openOrders.map((o) => `#${o.id} | ${o.customer} | ${o.date} | owes ${o.balance}`) : ['(none)']),
  ].join('\n');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, tools: [TOOL], tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: text }] }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  const call = (data.content || []).find((b) => b.type === 'tool_use' && b.name === TOOL.name);
  return call ? call.input : { kind: 'other', missing: '' };
}
