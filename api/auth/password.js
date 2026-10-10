// POST /api/auth/password { username, password } — signs in with a username/password from APP_USERS.
import { timingSafeEqual, createHash } from 'node:crypto';
import { appUsers, userKey, setSession, json, readJson, missingEnv } from '../../lib/auth.js';

const same = (a, b) => {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const missing = missingEnv();
  if (missing.length) return json(res, 500, { config: missing });
  try {
    const { username, password } = await readJson(req);
    const name = String(username || '').trim().toLowerCase();
    const user = appUsers().find((u) => u.name.toLowerCase() === name);
    // Always compare, so a wrong username takes as long as a wrong password.
    const ok = same(user ? user.password : '\u0000no-user', String(password || '')) && !!user;
    if (!ok) { await pause(800); return json(res, 401, { error: 'That username and password don’t match.' }); }
    await setSession(res, { email: userKey(user.name), name: user.name });
    return json(res, 200, { name: user.name });
  } catch (e) {
    console.error(e);
    return json(res, 400, { error: 'Sign-in failed. Please try again.' });
  }
}
