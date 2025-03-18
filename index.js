const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
require('dotenv').config();

console.log('LINE_CHANNEL_ACCESS_TOKEN:', process.env.LINE_CHANNEL_ACCESS_TOKEN);
console.log('LINE_CHANNEL_SECRET:', process.env.LINE_CHANNEL_SECRET);
console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY);

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);

// ✅ Webhook route ตรงนี้สำคัญมาก
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    console.log('LINE Webhook Received:', req.body.events);
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Handle Event Error:', err);
    res.status(500).end();
  }
});

// ✅ ส่วนนี้ใช้ json ได้เฉพาะ route อื่น
app.use(express.json());

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userMessage = event.message.text;
  if (userMessage.includes('@DT-bot')) {
    const prompt = userMessage.replace('@DT-bot', '').trim();
    const aiReply = await getGPTResponse(prompt);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: aiReply
    });
  }
}

async function getGPTResponse(prompt) {
  console.log('✅ ENV OPENAI_API_KEY:', process.env.OPENAI_API_KEY); 
  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    return response.data.choices[0].message.content.trim();
  } catch (err) {
    console.error('GPT Error:', err.response?.data || err.message);
    return 'ขออภัย ระบบ AI ตอบไม่ได้ในตอนนี้';
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));