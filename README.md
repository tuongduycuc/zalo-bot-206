# Zalo Bot 206 (Render minimal)

Minimal Express app for Zalo OA webhook on Render.
Includes built‑in domain verify route: `/zalodomainverify.txt`.

## Env Vars
APP_ID, APP_SECRET, ACCESS_TOKEN, REFRESH_TOKEN, GROUP_ID (blank first), VERIFY_TOKEN, TZ=Asia/Bangkok, PORT=3000

## Deploy
Build: `npm install` • Start: `npm start`

## Verify
Open `https://<app>.onrender.com/zalodomainverify.txt` → must show `zalo-domain-verification=<YOUR_TOKEN>`
Then click **Kiểm tra** in Zalo Developer.

## Webhook
Use `https://<app>.onrender.com/webhook` as Webhook URL.
