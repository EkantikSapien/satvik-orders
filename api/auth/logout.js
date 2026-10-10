import { clearSession, json } from '../../lib/auth.js';

export default function handler(req, res) {
  clearSession(res);
  json(res, 200, { ok: true });
}
