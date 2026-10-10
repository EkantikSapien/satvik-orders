# Satvik Orders

The order book for Satvik Catering: catering and farsan/sweet orders, a calendar, a dashboard, receipt photos and payments. Built for phones.

- **Hosting:** Vercel (static page in `public/`, server functions in `api/`).
- **Sign-in:** Google accounts. Only the emails you list in `ALLOWED_EMAILS` (plus `OWNER_EMAIL`) can get in.
- **Data:** a Google Sheet called **Satvik Orders** in the owner's Google Drive, with tabs for Orders, Expenses and Payments. You can open and read it like any other sheet.
- **Receipts:** photos and PDFs go into a Google Drive folder called **Satvik Receipts** in the owner's Drive, named like `2026-10-10 Patel Brothers $84.20 (#1001).jpg`.
- The app only asks Google for the `drive.file` permission, so it can see the sheet and folder it created and nothing else in your Drive.

## One-time setup (about 20 minutes)

### 1. Google Cloud (sign-in + Drive access)

1. Go to <https://console.cloud.google.com/>, signed in as the owner, and create a project called **Satvik Orders**.
2. **APIs & Services → Library**: enable **Google Drive API** and **Google Sheets API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**, app name **Satvik Orders**, your email as support and developer contact.
   - Data access / scopes: add `.../auth/drive.file` (plus the default `openid`, `email`, `profile`).
   - Audience: click **Publish app** so it's **In production**. (In "Testing" mode Google expires the Drive connection every 7 days.) No verification is needed for these scopes.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Type **Web application**, name **Satvik Orders web**.
   - **Authorised JavaScript origins:** your Vercel address, e.g. `https://satvik-orders.vercel.app` (add your custom domain too if you use one, e.g. `https://orders.satvikcatering.com.au`).
   - **Authorised redirect URIs:** the same address + `/api/setup/callback`, e.g. `https://satvik-orders.vercel.app/api/setup/callback`.
   - Copy the **Client ID** and **Client secret**.

### 2. Vercel

1. In Vercel: **Add New → Project → Import** this GitHub repo. Framework preset **Other**, no build command. Deploy.
2. **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | the OAuth client secret |
| `OWNER_EMAIL` | the owner's Google email (whose Drive holds the data) |
| `ALLOWED_EMAILS` | (optional) other Google emails that may sign in with Google, separated by commas |
| `APP_USERS` | (optional, Secret) username/password logins, e.g. `Mum:mango42, Dad:jalebi99` |
| `SESSION_SECRET` | any long random text (the app shows you one to use if it's missing) |

3. **Deployments → ⋯ → Redeploy** so the variables take effect.

### 3. Connect Google Drive (owner, once)

1. Open the app and sign in as the owner. It shows **Connect Google Drive**.
2. Allow access. The app creates the **Satvik Orders** sheet and **Satvik Receipts** folder and shows a key.
3. Add that key in Vercel as `GOOGLE_REFRESH_TOKEN`, then redeploy once more.

Done. Share the link with the team. To let family see the receipts folder or sheet directly in Drive, share them from Google Drive as usual.

## WhatsApp order bot (optional)

Free to run. Only numbers in `WHATSAPP_ALLOWED_NUMBERS` are listened to. Send *help* to the bot for the full list.

- **Orders:** forward or paste the order as written (a confirmation message, or a note like "1kg sev khamni, Sunday, Kunalbhai"; one message can hold several farsan customers). *catering* / *farsan* still sends a form. Missing details: `#1023 name Kunalbhai`, `#1023 date 24/10`, `#1023 guests 50`.
- **What's on:** `today`, `tomorrow`, `Sunday`, `24/10`: the orders and the kg of sev khamani / vatidar / nylon khaman to make.
- **Equipment:** `equipment` lists what's out; `returned #1004` marks it back.
- **Payments:** `owing` (tap-to-pick list), `Paid $500 cash #1004`, `paid in full before today`.

1. *(Optional, paid)* To accept free-form messages instead of the form, add an Anthropic API key as `ANTHROPIC_API_KEY`. Without it the free form reader is used.
2. **Meta WhatsApp Cloud API** at <https://developers.facebook.com/apps>: create an app (use case "Connect with customers through WhatsApp"), open **WhatsApp → API Setup**. Note the **Phone number ID**, add each team member's mobile under **To** and confirm the code WhatsApp sends them.
3. **Webhook**: WhatsApp → Configuration → Callback URL `https://<your-app>/api/whatsapp`, Verify token = the value you put in `WHATSAPP_VERIFY_TOKEN`. Subscribe to the **messages** field.
4. **Permanent token**: Meta Business Settings → Users → System users → add one (Admin) → Add assets → your app → Generate token with `whatsapp_business_messaging` and `whatsapp_business_management`, expiry "Never".
5. Vercel environment variables, then redeploy:

| Name | Value |
|---|---|
| `WHATSAPP_TOKEN` (Secret) | from step 4 |
| `WHATSAPP_APP_SECRET` (Secret) | App settings → Basic → App secret |
| `WHATSAPP_VERIFY_TOKEN` (Secret) | any random text, same as in step 3 |
| `WHATSAPP_PHONE_NUMBER_ID` | from step 2 |
| `WHATSAPP_ALLOWED_NUMBERS` | `61412345678:Pranjal, 61498765432:Mum` (country code, no + or spaces) |

## Adding or removing people

Edit `ALLOWED_EMAILS` in Vercel and redeploy. Removed people are signed out on their next visit.

## Limits

- Receipt files up to about 4 MB (photos are shrunk on the phone before upload, so this rarely matters).
- The app refreshes every 30 seconds and whenever you come back to it, so other people's changes show up within half a minute.
- Deleting a receipt moves the file to the Drive bin, where it can be restored for 30 days.
