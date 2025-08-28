require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

/* =========================
   1) โหลด + รีโหลดไฟล์ merchant advice (TH)
   ========================= */
const ADVICE_PATH = path.resolve(__dirname, 'merchant_advice_th.json'); // ← ใช้ชื่อไฟล์นี้ตามที่คุณระบุ
let ADVICE_MAP = {};

function loadAdvice() {
  try {
    const raw = fs.readFileSync(ADVICE_PATH, 'utf8');
    ADVICE_MAP = JSON.parse(raw);
    console.log(`[advice] loaded ${Object.keys(ADVICE_MAP).length} codes`);
  } catch (e) {
    console.error('[advice] load error:', e.message);
    ADVICE_MAP = {};
  }
}
loadAdvice();

// reload อัตโนมัติเมื่อไฟล์ถูกแก้ไข
try {
  fs.watchFile(ADVICE_PATH, { interval: 2000 }, () => {
    console.log('[advice] file changed, reloading…');
    loadAdvice();
  });
} catch (e) {
  console.warn('[advice] fs.watchFile not available:', e.message);
}

/* =========================
   2) Utils: ส่งข้อความแบบปลอดภัย + ช่วยจัดการ source
   ========================= */
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

/* =========================
   3) Helpers สำหรับ merchant advice
   ========================= */
function formatAdviceMessage(code, item) {
  const lines = [];
  lines.push(`ℹ️ รหัส: ${code}`);
  if (item.title) lines.push(`หัวข้อ: ${item.title}`);
  if (item.description) lines.push(`คำอธิบาย: ${item.description}`);
  if (Array.isArray(item.next_steps) && item.next_steps.length) {
    lines.push(`แนวทางแก้ไข:`);
    item.next_steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  return lines.join('\n');
}

function lookupByCode(code) {
  if (!code) return null;
  const key = String(code).trim();
  return ADVICE_MAP[key] || null;
}

// ค้นหาด้วยคีย์เวิร์ดจาก title/description/next_steps (ไทย/อังกฤษ)
function searchByKeyword(q) {
  const keyword = String(q || '').trim().toLowerCase();
  if (!keyword) return [];
  const hits = [];
  for (const [code, item] of Object.entries(ADVICE_MAP)) {
    const haystack = [
      item.title || '',
      item.description || '',
      ...(Array.isArray(item.next_steps) ? item.next_steps : [])
    ].join(' \n ').toLowerCase();
    if (haystack.includes(keyword)) {
      hits.push([code, item]);
    }
  }
  return hits.slice(0, 10); // limit 10
}

/* =========================
   4) Patterns/Intent
   ========================= */
// อ้างอิงรหัส (3–5 หลัก)
const CODE_PATTERNS = [
  /(?:รหัส|code|error|advice)\s*[:\-]?\s*(\d{3,5})/i,
  /^\s*(\d{3,5})\s*$/ // พิมพ์ตัวเลขล้วน
];

// ค้นหาด้วยคีย์เวิร์ด
const SEARCH_PATTERNS = [
  /(?:ค้นหา|search)\s*[:\-]?\s*(.+)$/i
];

// Intent: ตรวจ “ชำระเงิน” (คง logic เดิมไว้ — ถ้าอยากปิด ฟันท์ออกได้)
const PAYMENT_PATTERNS = [
  /ตรวจ(สอบ)?(.{0,8})?(รายการ)?(.{0,8})?(การ)?(.{0,8})?ชำระ(เงิน)?/i,
  /(เช็ค|เช็ก)(.{0,8})?ชำระ/i,
  /\b(check|verify)\b.{0,12}\b(payment|charge|transaction|status)\b/i,
  /payment\s*status/i
];

/* =========================
   5) Webhook
   ========================= */
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

    // 1) ตรวจว่าเป็นแชท 1:1 ไหม (1:1 ตอบทุกข้อความ, กลุ่มต้องมี trigger)
    const isDirect = (event.source?.type === 'user');

    // 2) ตรวจ trigger เฉพาะข้อความดิบ (ก่อนตัด)
    const rawLower = userMessage.toLowerCase();
    const hasTrigger = triggerKeywords.some(k => rawLower.includes(k));

    // 3) ตัด trigger ออกไว้ใช้ต่อ (กันไปรบกวน regex/AI)
    const cleaned = triggerKeywords
      .reduce((msg, k) => msg.replace(new RegExp(k, 'gi'), ''), userMessage)
      .trim();

    /* ---- A) ค้นหาด้วยคีย์เวิร์ด (merchant advice) ---- */
    let searchQuery = null;
    for (const p of SEARCH_PATTERNS) {
      const m = cleaned.match(p);
      if (m && m[1]) { searchQuery = m[1]; break; }
    }
    if (searchQuery) {
      const results = searchByKeyword(searchQuery);
      if (!results.length) {
        return safeReply(replyToken, { type: 'text', text: `ไม่พบผลลัพธ์สำหรับ: ${searchQuery}` });
      }
      const top = results.slice(0, 3)
        .map(([code, item]) => `• ${code} — ${item.title || 'ไม่มีชื่อ'}`).join('\n');
      const footer = results.length > 3 ? `\n(พบทั้งหมด ${results.length} รายการ, พิมพ์รหัสเพื่อดูรายละเอียด)` : '';
      return safeReply(replyToken, { type: 'text', text: `ผลการค้นหา:\n${top}${footer}` });
    }

    /* ---- B) เรียกด้วย “รหัส/ตัวเลข” → แสดงรายละเอียด ---- */
    let codeMatch = null;
    for (const p of CODE_PATTERNS) {
      const m = cleaned.match(p);
      if (m && m[1]) { codeMatch = m[1]; break; }
    }
    if (codeMatch) {
      const item = lookupByCode(codeMatch);
      if (!item) {
        return safeReply(replyToken, { type: 'text', text: `ไม่พบรหัส ${codeMatch} ในฐานข้อมูล` });
      }
      const text = formatAdviceMessage(codeMatch, item);
      return safeReply(replyToken, { type: 'text', text });
    }

    /* ---- C) ตรวจการชำระเงิน (คงของเดิมไว้ ถ้าไม่ใช้แล้ว ลบ/คอมเมนต์ได้) ---- */
    const hasPaymentIntent = PAYMENT_PATTERNS.some(p => p.test(cleaned));
    const idMatch = cleaned.match(/\d{5,}/);
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

    /* ---- D) AI (เหมือนเดิม) ---- */
    const shouldAskAI = isDirect || hasTrigger;
    if (shouldAskAI) {
      const prompt = hasTrigger ? cleaned : userMessage; // 1:1 ใช้ข้อความเต็ม

      // มีรูปค้างอยู่? ทำ OCR ก่อนเหมือนเดิม
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

          await safeReply(replyToken, { type: 'text', text: `🤖 DT Helper อ่านให้แล้วครับ:\n\n${text}` });
        } catch (err) {
          console.error('OCR Error:', err.response?.data || err.message);
          await safeReply(replyToken, { type: 'text', text: 'ขออภัย อ่านรูปไม่ได้ครับ' });
        }
      } else {
        await sendTypingHint(replyToken);
      }

      // หน่วงสั้น ๆ เพื่อ UX
      await new Promise(r => setTimeout(r, 1200));

      // เรียก GPT และส่งกลับยังปลายทางที่ถูกต้อง (user / room / group)
      const aiReply = await getGPTResponse(prompt);
      return safePush(event.source, { type: 'text', text: aiReply });
    }
  }
}

/* =========================
   6) (เดิม) ตรวจสอบการชำระเงินด้วย Omise
   ========================= */
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

/* =========================
   7) OpenAI
   ========================= */
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

/* =========================
   8) Boot server
   ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));