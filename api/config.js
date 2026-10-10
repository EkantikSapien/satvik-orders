// GET /api/config -> what the sign-in screen needs (the Google client ID is public by design).
import { json, missingEnv } from '../lib/auth.js';

export default function handler(req, res) {
  json(res, 200, { clientId: process.env.GOOGLE_CLIENT_ID || null, missing: missingEnv() });
}
