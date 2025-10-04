/**
 * Saduni — Advanced WhatsApp AI girlfriend bot (Gemini-only)
 *
 * Features:
 * - Baileys WhatsApp connection (QR terminal)
 * - Gemini Generative Language v1beta (gemini-pro) integration
 * - Per-chat memory and persona (nickname, mood, emoji on/off)
 * - Mood detection, emoji-enabled replies, "human" touches
 * - Commands: .help .setnick .lovely .memory .setmood .mood .emoji
 *
 * CONFIG: Put GEMINI_API_KEY or GEMINI_OAUTH_BEARER in .env (recommended).
 *
 * NOTE: Don't commit API keys to public repos.
 */

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch'); // v2
require('dotenv').config();

// ---------- Config ----------
const MEMORY_FILE = path.join(__dirname, 'memory.json');
const PERSONA_FILE = path.join(__dirname, 'persona.json');
const MAX_MESSAGES_PER_CHAT = 100;
const QR_SMALL = true;
const MAX_RETRIES = 2;

let GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''; // recommended to set in .env
let GEMINI_OAUTH_BEARER = process.env.GEMINI_OAUTH_BEARER || ''; // optional

// Ensure storage files exist
if (!fs.existsSync(MEMORY_FILE)) fs.writeJSONSync(MEMORY_FILE, {});
if (!fs.existsSync(PERSONA_FILE)) fs.writeJSONSync(PERSONA_FILE, {});

// ---------- Utility: Memory & Persona ----------
function readJSONSafe(file) { return fs.readJSONSync(file); }
function writeJSONSafe(file, obj) { fs.writeJSONSync(file, obj, { spaces: 2 }); }

function pushMemory(jid, role, text) {
  const mem = readJSONSafe(MEMORY_FILE);
  if (!mem[jid]) mem[jid] = [];
  mem[jid].push({ t: Date.now(), role, text });
  if (mem[jid].length > MAX_MESSAGES_PER_CHAT) mem[jid] = mem[jid].slice(-MAX_MESSAGES_PER_CHAT);
  writeJSONSafe(MEMORY_FILE, mem);
}
function getMemoryText(jid) {
  const mem = readJSONSafe(MEMORY_FILE);
  if (!mem[jid]) return '';
  return mem[jid].map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.text}`).join('\n');
}
function clearMemory(jid) {
  const mem = readJSONSafe(MEMORY_FILE);
  delete mem[jid];
  writeJSONSafe(MEMORY_FILE, mem);
}

function getPersona(jid) {
  const p = readJSONSafe(PERSONA_FILE);
  const base = { botName: 'Saduni', lovelyMode: true, nickname: 'Baby', tone: 'loving', mood: 'neutral', emoji: true };
  return Object.assign(base, (p[jid] || {}));
}
function setPersona(jid, obj) {
  const p = readJSONSafe(PERSONA_FILE);
  p[jid] = Object.assign(p[jid] || {}, obj);
  writeJSONSafe(PERSONA_FILE, p);
}

// ---------- Emotion detection (very simple keyword-based) ----------
const moodKeywords = {
  happy: ['happy','great','good','awesome','luv','love','like','yay','cool','nice','smile','😊','😁','lol'],
  sad: ['sad','depressed','unhappy','miss','cry','😭','😢','lonely','broken'],
  angry: ['angry','mad','annoy','hate','furious','wtf'],
  flirty: ['hot','sexy','date','kiss','love','bae','babe','crush','😍','😘'],
};

function detectMoodFromText(text) {
  if (!text) return 'neutral';
  const t = text.toLowerCase();
  for (const [mood, keys] of Object.entries(moodKeywords)) {
    for (const k of keys) {
      if (t.includes(k)) return mood;
    }
  }
  // exclamation or many emojis -> happy
  if ((text.match(/[!]{2,}/) || []).length) return 'happy';
  return 'neutral';
}

// emoji map for moods
const moodEmoji = {
  happy: '😊',
  sad: '😢',
  angry: '😠',
  flirty: '😘',
  neutral: '🙂'
};

// small set of humanizing closers per mood
const moodClosers = {
  happy: ["Love you 💖", "You're my sunshine ☀️", "Always here for you 😊"],
  sad: ["I'm here with you 💕", "Don't worry, tell me more 💛", "Hug you 🤗"],
  angry: ["Take it easy, baby 😔", "Calm down — I'm here ❤️"],
  flirty: ["Hehe 😏 you make me blush", "Come closer 😘", "Can't stop thinking about you 💗"],
  neutral: ["Tell me more", "Yes?", "I'm listening"]
};

// choose a short humanizing closer
function chooseCloser(mood) {
  const arr = moodClosers[mood] || moodClosers['neutral'];
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------- Gemini call (v1beta, robust + retry) ----------
async function callGemini(prompt, attempt = 0) {
  // endpoint uses query key (or we can use Authorization header)
  const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';
  const endpoint = GEMINI_API_KEY ? `${baseUrl}?key=${GEMINI_API_KEY}` : baseUrl;

  const headers = { 'Content-Type': 'application/json' };
  if (GEMINI_OAUTH_BEARER) headers['Authorization'] = `Bearer ${GEMINI_OAUTH_BEARER}`;
  if (!GEMINI_OAUTH_BEARER && GEMINI_API_KEY) headers['x-goog-api-key'] = GEMINI_API_KEY;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    temperature: 0.75,
    maxOutputTokens: 300
  };

  try {
    const res = await fetch(endpoint, {
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
    console.log('Gemini response (first 3000 chars):', JSON.stringify(j).slice(0, 3000));

    // Try multiple response shapes
    const candidate =
      j?.candidates?.[0]?.content?.parts?.[0]?.text ||
      j?.candidates?.[0]?.content ||
      (Array.isArray(j?.output) && j.output[0]?.content?.text) ||
      j?.outputText ||
      j?.text ||
      null;

    if (candidate) return String(candidate).trim();

    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      return callGemini(prompt, attempt + 1);
    }

    console.error('Gemini returned no candidate text. Full response:', JSON.stringify(j).slice(0, 4000));
    return null;
  } catch (err) {
    console.error('Gemini call error:', err);
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      return callGemini(prompt, attempt + 1);
    }
    throw err;
  }
}

async function generateWithGemini({ jid, userMessage }) {
  const persona = getPersona(jid);
  const memoryText = getMemoryText(jid);
  const systemPrompt = `
You are ${persona.botName}. You are affectionate, warm, playful and human-like.
Tone: ${persona.tone} (loving/caring). Keep replies SHORT (1-4 sentences).
If emoji is allowed, include 1-2 appropriate emojis. Do NOT include system-level or code blocks.
User message: ${userMessage}
Memory: ${memoryText ? memoryText.substring(0, 1500) : '(no memory)'}
Respond as ${persona.botName} in a natural, conversational way.
`.trim();

  const prompt = systemPrompt;

  try {
    const result = await callGemini(prompt);
    if (!result) return "Saduni is having trouble thinking right now. Try again in a moment.";

    // post-process: adjust based on mood/emoji setting & add human closer
    let reply = result.trim();

    // remove leading role labels if present
    reply = reply.replace(/^AI:\s*/i, '').replace(/^Saduni:\s*/i, '');

    // auto-detect mood from user message if persona mood is neutral
    let autoMood = persona.mood || detectMoodFromText(userMessage);
    if (persona.mood === 'neutral') {
      const detected = detectMoodFromText(userMessage);
      if (detected && detected !== 'neutral') autoMood = detected;
    }

    // Append small closer or teasing line for more human feel
    const closer = chooseCloser(autoMood);
    if (persona.emoji) {
      const em = moodEmoji[autoMood] || moodEmoji['neutral'];
      // If reply already contains emoji, don't duplicate; else add one
      if (!/[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1F600}-\u{1F64F}]/u.test(reply)) {
        reply = `${reply} ${em}`;
      }
      // Append closer with emoji
      reply = `${reply}\n\n${closer}`;
    } else {
      reply = `${reply}\n\n${closer}`;
    }

    return reply;
  } catch (err) {
    console.error('generateWithGemini error:', err);
    return "Saduni is having trouble thinking right now. Try again in a moment.";
  }
}

// ---------- WhatsApp (Baileys) ----------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrcode.generate(qr, { small: QR_SMALL });
      console.log('Scan the QR above with WhatsApp (Settings → Linked devices → Link a device).');
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

    // Commands (start with dot)
    if (text.startsWith('.')) {
      const parts = text.trim().split(/\s+/);
      const cmd = parts[0].slice(1).toLowerCase();

      if (cmd === 'help') {
        await sock.sendMessage(jid, {
          text:
`Saduni commands:
.help                - show this help
.setnick <name>      - set nickname AI uses (default "Baby")
.lovely on|off       - toggle lovely mode (changes tone)
.memory show         - show saved memory
.memory clear        - clear memory
.setmood <mood>      - set mood (happy|sad|flirty|angry|neutral)
.mood                - show current mood
.emoji on|off        - enable/disable emojis in replies`
        });
        return;
      }

      if (cmd === 'setnick') {
        const name = parts.slice(1).join(' ') || 'Baby';
        setPersona(jid, { nickname: name });
        await sock.sendMessage(jid, { text: `Okay 💕 I'll call you ${name}.` });
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
          const mem = readJSONSafe(MEMORY_FILE)[jid] || [];
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
        const allowed = ['happy','sad','angry','flirty','neutral'];
        if (!allowed.includes(mood)) {
          await sock.sendMessage(jid, { text: `Allowed moods: ${allowed.join(', ')}` });
          return;
        }
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

    // Regular conversation flow
    // Save user message to memory
    pushMemory(jid, 'user', text);

    // update persona mood automatically if user message has strong mood
    const personaNow = getPersona(jid);
    const detected = detectMoodFromText(text);
    if (detected && detected !== 'neutral' && personaNow.mood === 'neutral') {
      setPersona(jid, { mood: detected });
    }

    // Show composing presence
    try { await sock.sendPresenceUpdate('composing', jid); } catch (e) {}

    // Generate AI reply
    const aiReply = await generateWithGemini({ jid, userMessage: text });

    // Save bot reply
    pushMemory(jid, 'ai', aiReply || '');

    // Send message
    await sock.sendMessage(jid, { text: aiReply });
  });
}

// Start
start().catch(e => {
  console.error('Start error:', e);
  process.exit(1);
});
