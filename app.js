const express = require('express');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/whatsapp/webhook', async (req, res) => {
  const phoneNumber = req.body.From?.replace('whatsapp:', '') || '';
  const userMessage = req.body.Body || '';
  
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_PHONE}`,
      to: `whatsapp:${phoneNumber}`,
      body: 'Hi! I am Hakeem, your crop processing teacher. Type START to begin learning how to reduce post-harvest losses and increase your income.'
    });
    res.status(200).send('OK');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error');
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Hakeem Bot running on port ' + (process.env.PORT || 3000));
});
