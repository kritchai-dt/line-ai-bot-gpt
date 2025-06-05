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

// เก็บรูปก่อนหน้าแบบ simple (Production ใช้ Redis/Database)
let lastImageMessageId = null;

async function handleEvent(event) {
  if (event.type !== 'message') return;

  if (event.message.type === 'image') {
    console.log('📸 Image received');
    lastImageMessageId = event.message.id;
    return;
  }

  if (event.message.type === 'text') {
    const userMessage = event.message.text;
    const triggerKeywords = ['@dt helper', 'dt helper'];
    const lowerCaseMessage = userMessage.toLowerCase();
    const isTrigger = triggerKeywords.some(keyword => lowerCaseMessage.includes(keyword));

    // ✅ ตรวจสอบสถานะการชำระเงิน
    if (userMessage.toLowerCase().includes('ตรวจสอบการชำระเงิน')) {
      const match = userMessage.match(/\d{5,}/);

      if (!match) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: 'กรุณาระบุหมายเลขการชำระเงิน เช่น: ตรวจสอบการชำระเงิน 574981'
        });
      }

      const paymentAttemptId = match[0];
      const result = await checkPaymentStatus(paymentAttemptId);

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: result.message
      });
    }

    // ✅ OCR รูป
    if (isTrigger && lastImageMessageId) {
      console.log('📝 DT Helper trigger detected, start OCR on last image...');
      const stream = await client.getMessageContent(lastImageMessageId);
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));

      const imageBuffer = await new Promise((resolve, reject) => {
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });

      const [result] = await visionClient.textDetection({ image: { content: imageBuffer } });
      const detections = result.textAnnotations;
      const text = detections.length > 0 ? detections[0].description : '❌ ไม่พบข้อความในภาพ';

      console.log('📝 OCR Result:', text);
      lastImageMessageId = null;

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `🤖 DT Helper อ่านให้แล้วครับ:\n\n${text}`
      });
    }

    // ✅ ตอบ GPT
if (isTrigger) {
  const prompt = triggerKeywords.reduce((msg, keyword) => msg.replace(new RegExp(keyword, 'gi'), ''), userMessage).trim();

  // 🔹 เรียก Flex Typing Indicator ก่อน
  await client.replyMessage(event.replyToken, {
  "type": "flex",
  "altText": "Typing...",
  "contents": {
    "type": "bubble",
    "size": "micro",
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": "● ● ●",
          "align": "center",
          "gravity": "center",
          "color": "#BBBBBB",
          "size": "lg"
        }
      ]
    }
  }
}
  );

  // 🔹 delay เล็กน้อย (1.5 วินาที)
  await new Promise(resolve => setTimeout(resolve, 1500));

  // 🔹 ดึงคำตอบจาก GPT
  const aiReply = await getGPTResponse(prompt);

  // 🔹 ตอบกลับด้วย replyMessage อีกรอบโดยใช้ push ไปยัง group
  return client.pushMessage(event.source.groupId, {
    type: 'text',
    text: aiReply
  });
}
  }
}

async function checkPaymentStatus(paymentAttemptId) {
  const omiseKey = process.env.OMISE_SECRET_KEY;

  try {
    // ✅ ในกรณีนี้เราจำลองว่า charge_id กับ paymentAttemptId เป็น mapping ที่รู้กัน
    // ถ้ามีระบบหลังบ้านจริง คุณควร fetch จาก Database หรือ API ของคุณเอง
    const chargeIdMap = {
      "774518": "chrg_test_633qnxoq4tsp8la6mpy", // ตัวอย่างจำลอง success case
      "489767": "chrg_test_60tizjzvq9y685jcxkt", // ตัวอย่างจำลอง success case
      "818471": "chrg_test_63busw01lwtq7myho4x" // ตัวอย่างจำลอง fail case
    };

    const chargeId = chargeIdMap[paymentAttemptId];
    if (!chargeId) {
      return { found: false, message: `ไม่พบข้อมูลการชำระเงินหมายเลข ${paymentAttemptId}` };
    }

    // ✅ เรียก Omise API
    const response = await axios.get(`https://api.omise.co/charges/${chargeId}`, {
      auth: {
        username: omiseKey,
        password: ''
      }
    });

    const charge = response.data;
    const status = charge.status;
    const result = charge.metadata?.x_result;

    if (status !== 'successful' || result !== 'successful') {
      return {
        found: true,
        message: `❌ การชำระเงินหมายเลข ${paymentAttemptId} ไม่สำเร็จ\nสถานะล่าสุด: ${status}`
      };
    }

    return {
      found: true,
      message: `✅ การชำระเงินหมายเลข ${paymentAttemptId} สำเร็จเรียบร้อยครับ\nสถานะล่าสุด: ${status}`
    };

  } catch (error) {
    console.error("Omise API Error:", error);
    return {
      found: false,
      message: "⚠️ ไม่สามารถเชื่อมต่อกับระบบ Omise ได้ กรุณาลองใหม่อีกครั้ง"
    };
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