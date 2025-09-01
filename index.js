require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ---------- Google Cloud Vision ----------
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

// ============ 1) โหลด + รีโหลดฐานข้อมูล merchant advice ============
const ADVICE_FILE_PATH = path.join(process.cwd(), 'merchant_advice_th.json');
let ADVICE_MAP = {};

function loadAdviceFromFile() {
  try {
    const raw = fs.readFileSync(ADVICE_FILE_PATH, 'utf8');
    ADVICE_MAP = JSON.parse(raw);
    console.log(`[advice] loaded from file (${Object.keys(ADVICE_MAP).length} codes)`);
    return true;
  } catch (e) {
    console.warn('[advice] cannot load from file:', e.message);
    return false;
  }
}
function loadAdviceFromEnv() {
  try {
    if (!process.env.MERCHANT_ADVICE_JSON) return false;
    ADVICE_MAP = JSON.parse(process.env.MERCHANT_ADVICE_JSON);
    console.log(`[advice] loaded from ENV (${Object.keys(ADVICE_MAP).length} codes)`);
    return true;
  } catch (e) {
    console.warn('[advice] cannot parse MERCHANT_ADVICE_JSON:', e.message);
    return false;
  }
}
(function initAdvice() {
  if (!loadAdviceFromFile()) loadAdviceFromEnv();
})();
try {
  fs.watchFile(ADVICE_FILE_PATH, { interval: 2000 }, () => {
    console.log('[advice] file changed, reloading…');
    loadAdviceFromFile();
  });
} catch (_) { /* ignore */ }

// ============ 2) Utils ส่งข้อความ/จัดการ source ============
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
async function sendTypingHint(replyToken) {
  await safeReply(replyToken, { type: 'text', text: 'กำลังคิดคำตอบ…' });
}

// ============ 3) Helpers สำหรับ merchant advice ============
function formatAdviceMessage(code, item) {
  const lines = [];
  lines.push(`ℹ️ รหัส: ${code}`);
  if (item.title) lines.push(`หัวข้อ: ${item.title}`);
  if (item.description) lines.push(`คำอธิบาย: ${item.description}`);
  if (Array.isArray(item.next_steps) && item.next_steps.length) {
    lines.push('แนวทางแก้ไข:');
    item.next_steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  return lines.join('\n');
}
function lookupByCode(code) {
  if (!code) return null;
  const key = String(code).trim();
  return ADVICE_MAP[key] || null;
}
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
    if (haystack.includes(keyword)) hits.push([code, item]);
  }
  return hits.slice(0, 10);
}

// รูปแบบคำสั่งค้นหา (ไทย/อังกฤษ)
const SEARCH_PATTERNS = [
  /(?:ค้นหา|search)\s*[:\-]?\s*(.+)$/i
];

// ================= OCR INTENT & TTL =================
const OCR_COMMAND_RE = /(?:อ่านรูป|อ่านภาพ|\bocr\b|extract|ดึงข้อความ)/i;
const OCR_TTL_MS = 2 * 60 * 1000; // เก็บรูปไว้ได้ 2 นาที

// ============ 4) Webhook ============
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

// เก็บรูป “รายห้อง/รายคน” -> { id, ts }
const lastImageBySource = new Map();

async function handleEvent(event) {
  if (event.type !== 'message') return;

  const { source, message, replyToken } = event;
  const skey = getSourceKey(source);

  // --- รูปภาพ -> เก็บไว้รอ OCR (ไม่ OCR อัตโนมัติในกลุ่ม/รูม) ---
  if (message.type === 'image') {
    lastImageBySource.set(skey, { id: message.id, ts: Date.now() });

    // ถ้าเป็นกลุ่ม/รูม แจ้งวิธีเรียกใช้งานด้วยคำสั่ง
    if (source?.type !== 'user') {
      await safeReply(replyToken, {
        type: 'text',
        text: "📎 เก็บรูปไว้แล้วครับ\nพิมพ์ `@dt helper อ่านรูป` เพื่อให้ผมอ่านข้อความจากภาพ (มีอายุ 2 นาที)"
      });
    }
    return;
  }

  // --- ข้อความ ---
  if (message.type === 'text') {
    const userMessage = message.text || '';
    const triggerKeywords = ['@dt helper', 'dt helper'];

    const isDirect = (source?.type === 'user');               // 1:1 → ไม่ต้องมี trigger
    const rawLower = userMessage.toLowerCase();
    const hasTrigger = triggerKeywords.some(k => rawLower.includes(k));

    // ตัด trigger ออก (กันไปรบกวน regex/AI)
    const cleaned = triggerKeywords
      .reduce((msg, k) => msg.replace(new RegExp(k, 'gi'), ''), userMessage)
      .trim();

    // A) ค้นหาแบบคีย์เวิร์ดใน advice
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

    // B) ถ้ามีเลข 3–5 หลัก และเจอใน advice -> ตอบรายละเอียด
    const codeMatch = cleaned.match(/\b(\d{3,5})\b/);
    if (codeMatch) {
      const code = codeMatch[1];
      const item = lookupByCode(code);
      if (item) {
        const text = formatAdviceMessage(code, item);
        return safeReply(replyToken, { type: 'text', text });
      }
    }

    // C) OCR: ต้องมีรูปค้าง + (1:1 หรือ trigger หรือมีคำสั่ง OCR) และยังไม่หมดอายุ
    const rec = lastImageBySource.get(skey);
    const wantsOCR = isDirect || hasTrigger || OCR_COMMAND_RE.test(cleaned);
    if (rec) {
      const expired = (Date.now() - rec.ts) > OCR_TTL_MS;
      if (expired) {
        lastImageBySource.delete(skey);
      } else if (wantsOCR) {
        try {
          const stream = await client.getMessageContent(rec.id);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          const imageBuffer = await new Promise((resolve, reject) => {
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', reject);
          });

          const [visionRes] = await visionClient.textDetection({ image: { content: imageBuffer } });
          const detections = visionRes.textAnnotations;
          const text = detections.length > 0 ? detections[0].description : '❌ ไม่พบข้อความในภาพ';

          lastImageBySource.delete(skey);
          return safeReply(replyToken, { type: 'text', text: `🤖 DT Helper อ่านให้แล้วครับ:\n\n${text}` });
        } catch (err) {
          console.error('OCR Error:', err.response?.data || err.message);
          return safeReply(replyToken, { type: 'text', text: 'ขออภัย อ่านรูปไม่ได้ครับ' });
        }
      }
      // ถ้ามีรูปค้างแต่ไม่เข้าเงื่อนไข wantsOCR → เงียบไว้
    }

    // D) Fallback → AI (1:1 ตอบทุกข้อความ, กลุ่ม/รูม ต้องมี trigger)
    const shouldAskAI = isDirect || hasTrigger;
    if (shouldAskAI) {
      await sendTypingHint(replyToken);
      await new Promise(r => setTimeout(r, 1200));
      const aiReply = await getGPTResponse(cleaned || userMessage);
      return safePush(source, { type: 'text', text: aiReply });
    }
  }
}

// ============ 5) OpenAI ============
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

// ============ 6) Boot server ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));