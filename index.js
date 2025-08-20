require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

// Google Cloud Vision
const vision = require('@google-cloud/vision');
const visionClient = new vision.ImageAnnotatorClient({
  credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
});

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);

// -------- Utils: ส่งข้อความแบบปลอดภัย + ช่วยจัดการ source --------
function getSourceKey(source) {
  if (!source) return 'unknown';
  if (source.type === 'group') return `group:${source.groupId}`;
  if (source.type === 'room')  return `room:${source.roomId}`;
  return `user:${source.userId}`;
}

function getTargetId(source) {
  if (!source) return null;
  return source.groupId || source.roomId || source.userId || null;
}

async function safeReply(replyToken, messages) {
  try {
    await client.replyMessage(replyToken, Array.isArray(messages) ? messages : [messages]);
  } catch (err) {
    console.error('Reply Error:', err.response?.data || err.message);
  }
}

async function safePush(source, messages) {
  const targetId = getTargetId(source);
  if (!targetId) {
    console.error('Push Error: No targetId for source', source);
    return;
  }
  try {
    await client.pushMessage(targetId, Array.isArray(messages) ? messages : [messages]);
  } catch (err) {
    console.error('Push Error:', { targetId }, err.response?.data || err.message);
  }
}

// helper: ส่ง "กำลังพิมพ์…" (ตัวอักษร) แทน GIF
async function sendTypingHint(replyToken) {
  await safeReply(replyToken, { type: 'text', text: 'กำลังคิดคำตอบ…' });
}

// -------- Webhook (สำคัญ) --------
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Handle Event Error:', err);
    res.status(500).end();
  }
});

// ใช้ JSON ได้เฉพาะ route อื่น
app.use(express.json());

// เก็บรูป “รายห้อง/รายคน”
// key = `${source.type}:${id}` -> value = last image messageId
const lastImageBySource = new Map();

async function handleEvent(event) {
  if (event.type !== 'message') return;

  const { source, message, replyToken } = event;
  const skey = getSourceKey(source);

  // -------- ถ้าเป็นรูป: เก็บ messageId ตามห้อง/คน --------
  if (message.type === 'image') {
    lastImageBySource.set(skey, message.id);
    return;
  }

// -------- ถ้าเป็นข้อความ --------
if (message.type === 'text') {
  const userMessage = message.text || '';
  const triggerKeywords = ['@dt helper', 'dt helper'];

  // 1) ตัด trigger ออกก่อน เพื่อกัน regex สะดุด
  const cleaned = triggerKeywords
    .reduce((msg, k) => msg.replace(new RegExp(k, 'gi'), ''), userMessage)
    .trim();

  const lower = cleaned.toLowerCase();
  const isTrigger = triggerKeywords.some(k => (message.text || '').toLowerCase().includes(k));

  // 2) ตรวจ intent "ชำระเงิน" ให้ครอบคลุมหลายวิธีเขียน + เผื่อมีคำอื่นคั่น
  const PAYMENT_PATTERNS = [
    /ตรวจ(สอบ)?(.{0,8})?(รายการ)?(.{0,8})?(การ)?(.{0,8})?ชำระ(เงิน)?/i,  // ไทย ยอมให้มีตัวอักษรคั่นบ้าง
    /(เช็ค|เช็ก)(.{0,8})?ชำระ/i,
    /\b(check|verify)\b.{0,12}\b(payment|charge|transaction|status)\b/i,
    /payment\s*status/i
  ];
  const hasPaymentIntent = PAYMENT_PATTERNS.some(p => p.test(cleaned));

  // 3) หาเลขอ้างอิง (อย่างน้อย 5 หลัก) จากข้อความที่ถูกตัด trigger แล้ว
  const idMatch = cleaned.match(/\d{5,}/);

  // (optional) log ดีบักแบบไม่หลุดความลับ
  console.log('[INTENT]', { hasPaymentIntent, withTrigger: isTrigger, hasId: !!idMatch });

  // A) ตรวจสอบการชำระเงิน (ให้ทำก่อน GPT เสมอ)
  if (hasPaymentIntent) {
    if (!idMatch) {
      return safeReply(replyToken, {
        type: 'text',
        text: 'กรุณาระบุหมายเลขการชำระเงิน เช่น: ตรวจสอบการชำระเงิน 574981'
      });
    }
    const paymentAttemptId = idMatch[0];
    const result = await checkPaymentStatus(paymentAttemptId);
    return safeReply(replyToken, { type: 'text', text: result.message });
  }

  // B) OCR + GPT เมื่อมี trigger
  if (isTrigger) {
    const prompt = cleaned; // หลังตัด trigger แล้วใช้เป็น prompt ได้ตรง ๆ

    // ถ้ามีรูปค้างอยู่ ให้ทำ OCR ก่อน
    const skey = getSourceKey(source);
    const lastImgId = lastImageBySource.get(skey);
    if (lastImgId) {
      try {
        const stream = await client.getMessageContent(lastImgId);
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        const imageBuffer = await new Promise((resolve, reject) => {
          stream.on('end', () => resolve(Buffer.concat(chunks)));
          stream.on('error', reject);
        });

        const [visionRes] = await visionClient.textDetection({ image: { content: imageBuffer } });
        const detections = visionRes.textAnnotations;
        const text = detections.length > 0 ? detections[0].description : '❌ ไม่พบข้อความในภาพ';

        // เคลียร์รูปค้างของห้อง/คนนี้
        lastImageBySource.delete(skey);

        await safeReply(replyToken, {
          type: 'text',
          text: `🤖 DT Helper อ่านให้แล้วครับ:\n\n${text}`
        });
      } catch (err) {
        console.error('OCR Error:', err.response?.data || err.message);
        await safeReply(replyToken, { type: 'text', text: 'ขออภัย อ่านรูปไม่ได้ครับ' });
      }
    } else {
      // ไม่มีรูปค้าง: ส่งสัญญาณกำลังพิมพ์
      await sendTypingHint(replyToken);
    }

    // หน่วงสั้น ๆ เพื่อ UX
    await new Promise(r => setTimeout(r, 1200));

    // เรียก GPT และส่งกลับยังปลายทางที่ถูกต้อง (user / room / group)
    const aiReply = await getGPTResponse(prompt);
    return safePush(source, { type: 'text', text: aiReply });
  }
}
}

async function checkPaymentStatus(paymentAttemptId) {
  const omiseKey = process.env.OMISE_SECRET_KEY;
  try {
    // ตัวอย่าง mapping (ควรแทนที่ด้วยข้อมูลจริงจากระบบหลังบ้าน)
    const chargeIdMap = {
      "774518": "chrg_test_633qnxoq4tsp8la6mpy",
      "489767": "chrg_test_60tizjzvq9y685jcxkt",
      "818471": "chrg_test_63busw01lwtq7myho4x"
    };

    const chargeId = chargeIdMap[paymentAttemptId];
    if (!chargeId) {
      return { found: false, message: `ไม่พบข้อมูลการชำระเงินหมายเลข ${paymentAttemptId}` };
    }

    const response = await axios.get(`https://api.omise.co/charges/${chargeId}`, {
      auth: { username: omiseKey, password: '' }
    });

    const charge = response.data;
    const status = charge.status;
    const result = charge.metadata?.x_result;

    if (status !== 'successful' || result !== 'successful') {
      return { found: true, message: `❌ การชำระเงินหมายเลข ${paymentAttemptId} ไม่สำเร็จ\nสถานะล่าสุด: ${status}` };
    }
    return { found: true, message: `✅ การชำระเงินหมายเลข ${paymentAttemptId} สำเร็จเรียบร้อยครับ\nสถานะล่าสุด: ${status}` };
  } catch (error) {
    console.error('Omise API Error:', error.response?.data || error.message);
    return { found: false, message: '⚠️ ไม่สามารถเชื่อมต่อกับระบบ Omise ได้ กรุณาลองใหม่อีกครั้ง' };
  }
}

async function getGPTResponse(prompt) {
  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500
    }, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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