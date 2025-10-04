/**
 * Saduni — WhatsApp AI girlfriend bot (Gemini-only, API key)
 *
 * - Uses Baileys for WhatsApp connection and qrcode-terminal for QR output
 * - Uses Google Generative Language v1beta (gemini-pro) with API key only
 * - Per-chat memory, persona, mood, emoji toggles, basic commands
 *
 * WARNING: This file contains a hardcoded API key for quick testing.
 * Do NOT publish this to public repos. Prefer using .env or secret manager.
 */

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch'); // v2
// no dotenv used because key is hardcoded per your request

// ---------------- CONFIG ----------------
// Paste your API key here (you gave this key; used as requested)
const GEMINI_API_KEY = 'AIzaSyAV-KhlQxFRVw5AvozYPuqNEKDilSWGevo';

// Model & endpoint (using generativelanguage v1beta gemini-pro)
const BASE_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';
const ENDPOINT = `${BASE_ENDPOINT}?key=${GEMINI_API_KEY}`;

const MEMORY_FILE = path.join(__dirname, 'memory.json');
const PERSONA_FILE = path.join(__dirname, 'persona.json');
const MAX_MESSAGES_PER_CHAT = 100;
const MAX_RETRIES = 2;
const QR_SMALL = true;

// ensure files exist
if (!fs.existsSync(MEMORY_FILE)) fs.writeJSONSync(MEMORY_FILE, {});
if (!fs.existsSync(PERSONA_FILE)) fs.writeJSONSync(PERSONA_FILE, {});

// ---------------- helpers: memory & persona ----------------
function readJSON(file) { return fs.readJSONSync(file); }
function writeJSON(file, obj) { fs.writeJSONSync(file, obj, { spaces: 2 }); }

function pushMemory(jid, role, text) {
  const mem = readJSON(MEMORY_FILE);
  if (!mem[jid]) mem[jid] = [];
  mem[jid].push({ t: Date.now(), role, text });
  if (mem[jid].length > MAX_MESSAGES_PER_CHAT) mem[jid] = mem[jid].slice(-MAX_MESSAGES_PER_CHAT);
  writeJSON(MEMORY_FILE, mem);
}
function getMemoryText(jid) {
  const mem = readJSON(MEMORY_FILE);
  if (!mem[jid]) return '';
  return mem[jid].map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.text}`).join('\n');
}
function clearMemory(jid) {
  const mem = readJSON(MEMORY_FILE);
  delete mem[jid];
  writeJSON(MEMORY_FILE, mem);
}

function getPersona(jid) {
  const p = readJSON(PERSONA_FILE);
  const base = { botName: 'Saduni', lovelyMode: true, nickname: 'Baby', tone: 'loving', mood: 'neutral', emoji: true };
  return Object.assign(base, (p[jid] || {}));
}
function setPersona(jid, obj) {
  const p = readJSON(PERSONA_FILE);
  p[jid] = Object.assign(p[jid] || {}, obj);
  writeJSON(PERSONA_FILE, p);
}

// ---------------- simple mood detector (keyword-based) ----------------
const moodKeywords = {
  happy: ['happy','great','good','awesome','yay','nice','smile','glad','love','luv','😊','😁'],
  sad: ['sad','depressed','unhappy','miss','cry','😭','😢','lonely'],
  angry: ['angry','mad','annoy','hate','furious'],
  flirty: ['hot','sexy','date','kiss','babe','bae','crush','😍','😘'],
};

function detectMoodFromText(text) {
  if (!text) return 'neutral';
  const t = text.toLowerCase();
  for (const [m, keys] of Object.entries(moodKeywords)) {
    for (const k of keys) if (t.includes(k)) return m;
  }
  if ((text.match(/!{2,}/) || []).length) return 'happy';
  return 'neutral';
}

const moodEmoji = { happy: '😊', sad: '😢', angry: '😠', flirty: '😘', neutral: '🙂' };
const moodClosers = {
  happy: ["Love you 💖","You're my sunshine ☀️","Always here 😊"],
  sad: ["I'm here with you 💕","Tell me more 💛","Hug 🤗"],
  angry: ["Take it easy ❤️","I'm here baby 😔"],
  flirty: ["Hehe 😏 you make me blush","Come closer 😘","Can't stop thinking of you 💗"],
  neutral: ["Tell me more","Yes?","I'm listening"]
};
function chooseCloser(mood) {
  const arr = moodClosers[mood] || moodClosers['neutral'];
  return arr[Math.floor(Math.random()*arr.length)];
}

// ---------------- Gemini call (v1beta) ----------------
async function callGemini(prompt, attempt = 0) {
  const headers = { 'Content-Type': 'application/json' };
  // endpoint already contains key in query param
  const body = {
    contents: [
      { role: 'user', parts: [{ text: prompt }] }
    ],
    temperature: 0.75,
    maxOutputTokens: 300
  };

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeout: 20000
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Gemini HTTP ${res.status} - ${res.statusText} - body:`, text);
      if ((res.status >= 500 || res.status === 429) && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        return callGemini(prompt, attempt + 1);
      }
      throw new Error(`Gemini HTTP ${res.status}: ${text}`);
    }

    const j = await res.json();
    console.log('Gemini response (truncated):', JSON.stringify(j).slice(0, 3000));

    // Try multiple shapes to extract text
    const candidate =
      j?.candidates?.[0]?.content?.parts?.[0]?.text ||
      j?.candidates?.[0]?.content ||
      (Array.isArray(j?.output) && j.output[0]?.content?.text) ||
      j?.outputText ||
      j?.text ||
      j?.response?.outputText ||
      null;

    if (candidate) return String(candidate).trim();

    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      return callGemini(prompt, attempt + 1);
    }

    console.error('No text candidate in Gemini response. Full response (truncated):', JSON.stringify(j).slice(0, 4000));
    return null;

  } catch (err) {
    console.error('callGemini error:', err);
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      return callGemini(prompt, attempt + 1);
    }
    throw err;
  }
}

async function generateWithGemini({ jid, userMessage }) {
  const persona = getPersona(jid);
  const memoryText = getMemoryText(jid).slice(-4000); // limit memory included
  const systemPrompt = `You are ${persona.botName}. Be affectionate, warm, playful and human-like. Tone: ${persona.tone}. Keep replies short (1-4 sentences). If emoji is allowed, include 1-2 appropriate emojis. Avoid code blocks or system text.`;
  const promptParts = [
    systemPrompt,
    '### Memory:',
    memoryText || '(no memory)',
    '### Conversation:',
    `User: ${userMessage}`,
    `${persona.botName}:`
  ];
  const prompt = promptParts.join('\n');

  try {
    const raw = await callGemini(prompt);
    if (!raw) return "Saduni is having trouble thinking right now. Try again in a moment.";

    let reply = String(raw).trim();

    // remove role prefixes if present
    reply = reply.replace(/^AI:\s*/i, '').replace(/^Saduni:\s*/i, '');

    // determine mood
    let autoMood = persona.mood || detectMoodFromText(userMessage);
    if (persona.mood === 'neutral') {
      const detected = detectMoodFromText(userMessage);
      if (detected && detected !== 'neutral') autoMood = detected;
    }

    // Append closer & emoji per persona settings
    const closer = chooseCloser(autoMood);
    if (persona.emoji) {
      const em = moodEmoji[autoMood] || moodEmoji['neutral'];
      if (!/[\p{Emoji}]/u.test(reply)) reply = `${reply} ${em}`;
      reply = `${reply}\n\n${closer}`;
    } else {
      reply = `${reply}\n\n${closer.replace(/[\p{Emoji}]/gu, '')}`;
    }

    // trim final length
    if (reply.length > 1000) reply = reply.slice(0, 1000) + '...';

    return reply;
  } catch (err) {
    console.error('generateWithGemini error:', err);
    return "Saduni is having trouble thinking right now. Try again in a moment.";
  }
}

// ---------------- WhatsApp (Baileys) ----------------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({ version, auth: state });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrcode.generate(qr, { small: QR_SMALL });
      console.log('Scan the QR above with WhatsApp → Settings → Linked devices → Link a device');
    }
    if (connection === 'close') {
      const shouldReconnect = !(lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut);
      console.log('Connection closed. Should reconnect:', shouldReconnect);
      if (shouldReconnect) setTimeout(() => start().catch(e => console.error('Reconnect failed', e)), 1500);
    } else if (connection === 'open') {
      console.log('Saduni connected.');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const message = m.messages?.[0];
    if (!message) return;
    if (message.key && message.key.remoteJid === 'status@broadcast') return;
    if (message.key.fromMe) return;

    const jid = message.key.remoteJid;
    let text = '';
    if (message.message?.conversation) text = message.message.conversation;
    else if (message.message?.extendedTextMessage?.text) text = message.message.extendedTextMessage.text;
    else if (message.message?.imageMessage?.caption) text = message.message.imageMessage.caption;
    else if (message.message?.videoMessage?.caption) text = message.message.videoMessage.caption;
    if (!text) return;

    console.log(`Message from ${jid}:`, text);

    // commands start with dot
    if (text.startsWith('.')) {
      const parts = text.trim().split(/\s+/);
      const cmd = parts[0].slice(1).toLowerCase();

      if (cmd === 'help') {
        await sock.sendMessage(jid, { text:
`Saduni commands:
.help                - show this help
.setnick <name>      - set nickname AI uses (default "Baby")
.lovely on|off       - toggle lovely mode (changes tone)
.memory show         - show saved memory
.memory clear        - clear memory
.setmood <m>         - set mood (happy|sad|flirty|angry|neutral)
.mood                - show current mood
.emoji on|off        - enable/disable emoji in replies`
        });
        return;
      }

      if (cmd === 'setnick') {
        const name = parts.slice(1).join(' ') || 'Baby';
        setPersona(jid, { nickname: name });
        await sock.sendMessage(jid, { text: `Okay — I'll call you ${name}.` });
        return;
      }

      if (cmd === 'lovely') {
        const param = (parts[1] || 'on').toLowerCase();
        const on = param === 'on';
        setPersona(jid, { lovelyMode: on, tone: on ? 'loving' : 'casual' });
        await sock.sendMessage(jid, { text: on ? 'Lovely mode on ❤️' : 'Lovely mode off.' });
        return;
      }

      if (cmd === 'memory') {
        const sub = (parts[1] || '').toLowerCase();
        if (sub === 'show') {
          const mem = readJSON(MEMORY_FILE)[jid] || [];
          const showText = mem.slice(-30).map(x => `${new Date(x.t).toLocaleString()}: ${x.role}: ${x.text}`).join('\n') || '(no memory)';
          await sock.sendMessage(jid, { text: `Memory:\n${showText}` });
          return;
        }
        if (sub === 'clear') {
          clearMemory(jid);
          await sock.sendMessage(jid, { text: 'Memory cleared 🗑️' });
          return;
        }
        await sock.sendMessage(jid, { text: 'Use: .memory show | .memory clear' });
        return;
      }

      if (cmd === 'setmood') {
        const mood = (parts[1] || '').toLowerCase();
        const allow = ['happy','sad','angry','flirty','neutral'];
        if (!allow.includes(mood)) return await sock.sendMessage(jid, { text: `Allowed moods: ${allow.join(', ')}` });
        setPersona(jid, { mood });
        await sock.sendMessage(jid, { text: `Mood set to ${mood}.` });
        return;
      }

      if (cmd === 'mood') {
        const persona = getPersona(jid);
        await sock.sendMessage(jid, { text: `Current mood: ${persona.mood} ${persona.emoji ? moodEmoji[persona.mood] : ''}` });
        return;
      }

      if (cmd === 'emoji') {
        const p = (parts[1] || 'on').toLowerCase();
        const on = p === 'on';
        setPersona(jid, { emoji: on });
        await sock.sendMessage(jid, { text: on ? 'Emoji enabled 😊' : 'Emoji disabled.' });
        return;
      }

      await sock.sendMessage(jid, { text: 'Unknown command. Send .help' });
      return;
    }

    // normal conversation
    pushMemory(jid, 'user', text);

    // auto-update mood if strong signal and persona neutral
    const personaNow = getPersona(jid);
    const detected = detectMoodFromText(text);
    if (detected !== 'neutral' && personaNow.mood === 'neutral') setPersona(jid, { mood: detected });

    try { await sock.sendPresenceUpdate('composing', jid); } catch (e) {}

    const aiReply = await generateWithGemini({ jid, userMessage: text });
    pushMemory(jid, 'ai', aiReply || '');

    await sock.sendMessage(jid, { text: aiReply });
  });
}

// Start
start().catch(e => {
  console.error('Fatal start error:', e);
  process.exit(1);
});
