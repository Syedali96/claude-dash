# Going live: Cloudflare + Google setup

Status: Cloudflare is done and the server is live at
`https://claude-dash.claude-g2-dashboard.workers.dev`. Next: part 2.

About 15 minutes, one time. Do parts 1 and 2, then tell Claude. Claude does part 3.

## 1. Cloudflare (hosts the always-on server, free)

1. Make a free account at https://dash.cloudflare.com/sign-up (skip if you have one).
2. In this project's terminal, run this and approve in the browser window it opens:
   ```bash
   npx wrangler login
   ```

## 2. Google (lets the dashboard read your calendar and mail)

Sign in to https://console.cloud.google.com as **ali@echonos.ai**.

1. **New project:** use the project picker at the top, then **New project**, and name it `Claude Dash`.
2. **Turn on the APIs:** in **APIs & Services → Library**, enable **Google Calendar API** and **Gmail API**.
3. **Consent screen:** in **APIs & Services → OAuth consent screen**, choose
   **Internal**. Internal means only echonos.ai accounts can use it, and Google doesn't
   need to review it. Name it `Claude Dash` and use ali@echonos.ai for the emails.
4. **Client:** in **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URI (copy exactly):
     `https://claude-dash.claude-g2-dashboard.workers.dev/auth/google/callback`
5. Copy the **Client ID** and **Client secret** into `.dev.vars`, after
   `GOOGLE_CLIENT_ID=` and `GOOGLE_CLIENT_SECRET=`. Don't paste them in chat.

## 3. Claude does the rest

a. Creates the token storage and deploys the server, which gives you your server URL.
b. Uploads your secrets (Claude key, access token, Google client) to Cloudflare.
c. Gives you the server URL and access token for the phone's settings page.

## 4. Connect your accounts (on your Mac)

On the phone settings page, open **Connection → open setup page** on your **Mac's browser**,
not inside the Even app, because Google blocks sign-in there. Click **Connect** for ali@ and for hello@.
Access is read-only.
