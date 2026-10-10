import { SignJWT, jwtVerify } from 'jose';
import { OAuth2Client } from 'google-auth-library';

const COOKIE = 'satvik_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export const REQUIRED_ENV = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET', 'OWNER_EMAIL', 'ALLOWED_EMAILS'];
export const missingEnv = () => REQUIRED_ENV.filter((k) => !process.env[k]);

export const ownerEmail = () => (process.env.OWNER_EMAIL || '').trim().toLowerCase();
export const allowedEmails = () => {
  const list = (process.env.ALLOWED_EMAILS || '').split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (ownerEmail()) list.push(ownerEmail());
  return [...new Set(list)];
};

const key = () => new TextEncoder().encode(process.env.SESSION_SECRET);

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** Verify a Google Identity Services credential (ID token) and return the person. */
export async function verifyGoogleCredential(credential) {
  const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  const ticket = await client.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
  const p = ticket.getPayload();
  if (!p || !p.email || !p.email_verified) throw new Error('Unverified Google account');
  return { email: p.email.toLowerCase(), name: p.given_name || p.name || p.email };
}

export async function setSession(res, user) {
  const token = await new SignJWT({ email: user.email, name: user.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(key());
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`);
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

export function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export async function getUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    const email = String(payload.email || '').toLowerCase();
    if (!allowedEmails().includes(email)) return null; // removed from the team list
    return { email, name: String(payload.name || email), isOwner: email === ownerEmail() };
  } catch {
    return null;
  }
}

/** Returns the signed-in team member, or answers the request (401 / config error) and returns null. */
export async function requireUser(req, res) {
  const missing = missingEnv();
  if (missing.length) { json(res, 500, { config: missing }); return null; }
  const user = await getUser(req);
  if (!user) { json(res, 401, { signin: true }); return null; }
  return user;
}
