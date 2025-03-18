const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
require('dotenv').config();

// ✅ Log ENV ตรงนี้ ตรวจสอบค่าก่อนใช้งาน
console.log('LINE_CHANNEL_ACCESS_TOKEN:', process.env.LINE_CHANNEL_ACCESS_TOKEN);
console.log('LINE_CHANNEL_SECRET:', process.env.LINE_CHANNEL_SECRET);
console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY);

const app = express();
app.use(express.json());  // ✅ สำคัญมาก อ่าน body ได้

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new line.Client(config);
app.use(line.middleware(config)); // ✅ ต้องมี middleware

// ✅ Route /webhook ต้องตอบ 200 เสมอ
app.post('/webhook', async (req, res) => {
  console.log(JSON.stringify(req.body));  // ✅ log เช็คว่ามา
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Handle Event Error:', err);
    res.status(500).end();
  }
});

// ✅ ฟังก์ชันรับ event และยิง AI
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userMessage = event.message.text;
  if (userMessage.includes('@Bot')) {
    const prompt = userMessage.replace('@Bot', '').trim();
    const aiReply = await getGPTResponse(prompt);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: aiReply
    });
  }
}

// ✅ ฟังก์ชันเรียก GPT
async function getGPTResponse(prompt) {
  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4',
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