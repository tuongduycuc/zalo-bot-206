require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// TXT verify
app.get('/zalodomainverify.txt', (req, res) => {
  res.type('text/plain').send('zalo-domain-verification=' + (process.env.VERIFY_TOKEN || ''));
});

// HTML verify (exact filename from Zalo)
app.get('/CyU78lIr33n_e8ePfgaWBqVNbN6hg40gDZC.html', (req, res) => {
  res.type('text/html').send('zalo-domain-verification=' + (process.env.VERIFY_TOKEN || ''));
});

// Webhook endpoint
app.post('/webhook', (req, res) => {
  console.log('Webhook hit:', JSON.stringify(req.body));
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('Zalo bot 206 is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server listening on ' + PORT);
});
