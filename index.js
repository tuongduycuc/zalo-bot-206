require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// Verify route for Zalo domain check (Method A)
app.get('/zalodomainverify.txt', (req, res) => {
  const token = process.env.VERIFY_TOKEN || '';
  res.type('text/plain').send('zalo-domain-verification=' + token);
});

// Webhook endpoint
app.post('/webhook', (req, res) => {
  console.log('Webhook hit:', JSON.stringify(req.body));
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('Zalo bot is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Bot listening on port ' + PORT);
  console.log('Verify token present?', !!process.env.VERIFY_TOKEN);
});
