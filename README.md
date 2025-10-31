# Zalo Webhook Proxy

Public endpoint (Render/Vercel/etc.) that **forwards** Zalo webhook requests to your **local bot** URL (exposed via cloudflared/localtunnel/ngrok).

## Configure
- Copy `.env.example` to `.env` and fill:
  - `FORWARD_URL` = your local webhook URL (e.g., `https://<trycloudflare>.com/webhook`)
  - `PROXY_TOKEN` = optional shared secret; proxy sends header `X-Proxy-Token`

## Run locally
```
npm install
npm start
```

## Deploy to Render
- Create a new Web Service from this folder (push to GitHub).
- Build Command: `npm install`
- Start Command: `npm start`
- Set environment variables in Render dashboard:
  - `FORWARD_URL=https://<trycloudflare>.com/webhook`
  - `PROXY_TOKEN=some-secret`
- Use the Render URL `/webhook` as your Zalo Webhook URL.
