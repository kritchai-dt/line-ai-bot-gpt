require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');


// ✅ Import Google Cloud Vision (ใส่ตรงนี้)
const vision = require('@google-cloud/vision');
const visionClient = new vision.ImageAnnotatorClient({
  credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
});

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
  if (event.type !== 'message') return;

  // ✅ ถ้าเป็น "รูปภาพ" → ดึงจาก LINE แล้วยิง Google Vision OCR
  if (event.message.type === 'image') {
    console.log('📸 Image received, start OCR...');

    const stream = await client.getMessageContent(event.message.id);
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));

    const imageBuffer = await new Promise((resolve, reject) => {
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });

    // ✅ ยิง Google Cloud Vision OCR
    const [result] = await visionClient.textDetection({ image: { content: imageBuffer } });
    const detections = result.textAnnotations;
    const text = detections.length > 0 ? detections[0].description : '❌ ไม่พบข้อความในภาพ';

    console.log('📝 OCR Result:', text);

    // ✅ ตอบกลับ OCR
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ ข้อความในภาพ:\n${text}`
    });
  }

  // ✅ ถ้าเป็นข้อความ
  if (event.message.type === 'text') {
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