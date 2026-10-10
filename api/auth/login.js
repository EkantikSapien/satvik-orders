// POST /api/auth/login { credential }  — exchanges a Google sign-in for a 30-day session cookie.
import { verifyGoogleCredential, setSession, allowedEmails, json, readJson, missingEnv, ownerEmail } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const missing = missingEnv();
  if (missing.length) return json(res, 500, { config: missing });
  try {
    const { credential } = await readJson(req);
    const user = await verifyGoogleCredential(credential);
    if (!allowedEmails().includes(user.email)) return json(res, 403, { error: 'not_allowed', email: user.email });
    await setSession(res, user);
    return json(res, 200, { email: user.email, name: user.name, isOwner: user.email === ownerEmail() });
  } catch (e) {
    console.error(e);
    return json(res, 400, { error: 'Google sign-in failed. Please try again.' });
  }
}
