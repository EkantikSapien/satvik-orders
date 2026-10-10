// GET /api/setup/start — owner only. Sends the owner to Google to allow the app to keep
// its own spreadsheet and receipts folder in the owner's Drive (drive.file permission only).
import { randomBytes } from 'node:crypto';
import { requireUser, json } from '../../lib/auth.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!user.isOwner) return json(res, 403, { error: 'Only the owner can connect Google Drive.' });
  const state = randomBytes(16).toString('hex');
  const redirect = `https://${req.headers.host}/api/setup/callback`;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file',
    access_type: 'offline',
    prompt: 'consent',
    login_hint: user.email,
    state,
  }).toString();
  res.setHeader('Set-Cookie', `satvik_setup=${state}; Path=/api/setup; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  res.statusCode = 302;
  res.setHeader('Location', url.toString());
  res.end();
}
