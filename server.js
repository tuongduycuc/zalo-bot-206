require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

const FORWARD_URL = process.env.FORWARD_URL;
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';

if (!FORWARD_URL) {
  console.warn('⚠️ FORWARD_URL is not set. Set it to your local bot webhook URL (e.g., https://<trycloudflare>.com/webhook)');
}

app.get('/', (req, res) => res.status(200).send('Zalo Webhook Proxy is running'));

app.all('/webhook', async (req, res) => {
  try {
    if (!FORWARD_URL) {
      return res.status(200).send('FORWARD_URL not configured yet');
    }
    const headers = { 
      'Content-Type': req.get('content-type') || 'application/json',
      'X-Proxy-Token': PROXY_TOKEN
    };
    const method = (req.method || 'POST').toLowerCase();

    const axiosCfg = { headers, timeout: 10000, validateStatus: s => true };
    let response;
    if (method === 'get') {
      response = await axios.get(FORWARD_URL, axiosCfg);
    } else if (['post','put','patch','delete'].includes(method)) {
      response = await axios({ url: FORWARD_URL, method, data: req.body, headers, timeout: 10000, validateStatus: s=>true });
    } else {
      response = await axios.post(FORWARD_URL, req.body, axiosCfg);
    }

    res.status(200).send('OK');
  } catch (e) {
    console.error('Forward error:', e?.response?.status, e?.response?.data || e.message);
    res.status(200).send('OK');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook proxy listening on ${PORT}. Forwarding to: ${FORWARD_URL || '(unset)'}`);
});
