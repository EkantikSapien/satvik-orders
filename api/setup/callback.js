// GET /api/setup/callback — finishes the owner's Google Drive connection, creates the
// "Satvik Orders" sheet and "Satvik Receipts" folder, and shows the one value to paste into Vercel.
import { OAuth2Client } from 'google-auth-library';
import { getUser, readCookie, missingEnv } from '../../lib/auth.js';
import { store, ownerAuth } from '../../lib/store.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(res, status, title, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#EFE4D0;color:#3D2117;margin:0;padding:24px 16px;line-height:1.5}main{max-width:620px;margin:0 auto;background:#FFFAF1;border:1px solid #DAC6A5;border-radius:16px;padding:22px}
h1{font-size:22px;margin:0 0 10px;color:#762B16}textarea{width:100%;min-height:90px;font:13px ui-monospace,monospace;padding:10px;border-radius:10px;border:1px solid #DAC6A5;background:#fff;box-sizing:border-box}
button,a.btn{display:inline-block;background:#762B16;color:#FBF3E6;border:0;border-radius:10px;padding:10px 16px;font-weight:600;text-decoration:none;cursor:pointer;margin-top:8px}ol{padding-left:20px}code{background:#E6D8BF;padding:1px 5px;border-radius:5px}</style></head><body><main>${body}</main></body></html>`);
}

export default async function handler(req, res) {
  if (missingEnv().length) return page(res, 500, 'Setup', '<h1>Settings missing</h1><p>Add the Vercel environment variables listed in the README, then redeploy.</p>');
  const user = await getUser(req);
  if (!user || !user.isOwner) return page(res, 403, 'Owner only', '<h1>Owner only</h1><p>Sign in to the app as the owner first, then try again.</p><a class="btn" href="/">Open the app</a>');
  const q = new URL(req.url, 'http://x').searchParams;
  if (q.get('error')) return page(res, 400, 'Not connected', `<h1>Google Drive wasn’t connected</h1><p>Google said: ${esc(q.get('error'))}.</p><a class="btn" href="/">Back to the app</a>`);
  if (!q.get('state') || q.get('state') !== readCookie(req, 'satvik_setup')) return page(res, 400, 'Expired', '<h1>That link expired</h1><p>Start the connection again from the app.</p><a class="btn" href="/">Back to the app</a>');

  try {
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `https://${req.headers.host}/api/setup/callback`);
    const { tokens } = await client.getToken(q.get('code'));
    if (!tokens.refresh_token) return page(res, 400, 'Try again', '<h1>Google didn’t return a long-term key</h1><p>Remove “Satvik Orders” from your Google account’s third-party access page, then connect again.</p><a class="btn" href="/api/setup/start">Connect again</a>');
    const s = await store(ownerAuth(tokens.refresh_token)); // creates the sheet + folder now
    return page(res, 200, 'Almost done', `<h1>Google Drive connected</h1>
<p>The app created <a href="${esc(s.sheetLink)}" target="_blank" rel="noopener">Satvik Orders</a> (a Google Sheet) and <a href="${esc(s.folderLink)}" target="_blank" rel="noopener">Satvik Receipts</a> (a Drive folder) in your Google Drive.</p>
<p><b>One last step.</b> This key lets the app keep using those two files. Treat it like a password.</p>
<textarea id="k" readonly>${esc(tokens.refresh_token)}</textarea>
<button type="button" onclick="navigator.clipboard.writeText(document.getElementById('k').value).then(()=>this.textContent='Copied',()=>{document.getElementById('k').select()})">Copy key</button>
<ol><li>In Vercel, open the project → <b>Settings → Environment Variables</b>.</li><li>Add <code>GOOGLE_REFRESH_TOKEN</code> and paste the key as its value.</li><li>Go to <b>Deployments</b>, open the menu on the latest one and choose <b>Redeploy</b>.</li><li>Open the app. Orders will now save to the sheet.</li></ol>`);
  } catch (e) {
    console.error(e);
    return page(res, 500, 'Error', '<h1>Something went wrong</h1><p>Check that the Google Drive API and Google Sheets API are both enabled in your Google Cloud project, then try again.</p><a class="btn" href="/api/setup/start">Try again</a>');
  }
}
