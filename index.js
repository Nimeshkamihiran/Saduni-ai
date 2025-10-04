/**
 * Saduni — Whatsapp AI girlfriend bot (Gemini-only)
 *
 * - Uses @whiskeysockets/baileys for WhatsApp connection
 * - Shows QR in terminal (qrcode-terminal)
 * - Calls Gemini Generative REST API using x-goog-api-key
 * - Per-chat memory (memory.json), persona file (persona.json)
 * - Commands: .help .setnick .lovely .memory show|clear
 *
 * WARNING: You provided API credentials. This example shows how to paste them
 * for quick testing, but move them to .env or a secret manager for production.
 */

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch'); // v2
require('dotenv').config();

// ---------- CONFIG ----------
const MEMORY_FILE = path.join(__dirname, 'memory.json');
const PERSONA_FILE = path.join(__dirname, 'persona.json');
const MAX_MESSAGES_PER_CHAT = 80;
const QR_SMALL = true;

// Provided keys (you pasted) — these are used as defaults, but can be overridden by .env
let GEMINI_API_KEY = 'AIzaSyAV-KhlQxFRVw5AvozYPuqNEKDilSWGevo';
let GEMINI_OAUTH_CLIENT_ID = '319057617500-acflu2ogcjmbbpq68q4h3f4pffo13j57.apps.googleusercontent.com';
// Optional runtime bearer token (if you obtain an OAuth access token)
let GEMINI_OAUTH_BEARER = '';

// Allow env override
GEMINI_API_KEY = process.env.GEMINI_API_KEY || GEMINI_API_KEY;
GEMINI_OAUTH_CLIENT_ID = process.env.GEMINI_OAUTH_CLIENT_ID || GEMINI_OAUTH_CLIENT_ID;
GEMINI_OAUTH_BEARER = process.env.GEMINI_OAUTH_BEARER || GEMINI_OAUTH_BEARER;

// ensure files exist
if (!fs.existsSync(MEMORY_FILE)) fs.writeJSONSync(MEMORY_FILE, {});
if (!fs.existsSync(PERSONA_FILE)) fs.writeJSONSync(PERSONA_FILE, {});

// ---------- Memory & Persona helpers ----------
function readMemory() { return fs.readJSONSync(MEMORY_FILE); }
function writeMemory(obj) { fs.writeJSONSync(MEMORY_FILE, obj, { spaces: 2 }); }
function pushMemory(jid, role, text) {
  const mem = readMemory();
  if (!mem[jid]) mem[jid] = [];
  mem[jid].push({ t: Date.now(), role, text });
  if (mem[jid].length > MAX_MESSAGES_PER_CHAT) mem[jid] = mem[jid].slice(-MAX_MESSAGES_PER_CHAT);
  writeMemory(mem);
}
function getMemoryText(jid) {
  const mem = readMemory();
  if (!mem[jid]) return '';
  // return last messages in simple "User: ... / AI: ..." format
  return mem[jid].map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.text}`).join('\n');
}
function clearMemory(jid) {
  const mem = readMemory();
  delete mem[jid];
  writeMemory(mem);
}

function getPersona(jid) {
  const p = fs.readJSONSync(PERSONA_FILE);
  const base = { botName: 'Saduni', lovelyMode: true, nickname: 'Baby', tone: 'loving' };
  return Object.assign(base, (p[jid] || {}));
}
function setPersona(jid, obj) {
  const p = fs.readJSONSync(PERSONA_FILE);
  p[jid] = Object.assign(p[jid] || {}, obj);
  fs.writeJSONSync(PERSONA_FILE, p, { spaces: 2 });
}

// ---------- Gemini call (robust parsing) ----------
async function generateWithGemini({ jid, userMessage }) {
  const persona = getPersona(jid);
  const memoryText = getMemoryText(jid);
  const systemPrompt = `You are ${persona.botName} — a sweet, affectionate WhatsApp girlfriend. Tone: ${persona.tone}. Keep replies short, warm, natural, and friendly. Use mild flirtation when appropriate.`;
  const prompt = [
    systemPrompt,
    '### Memory:',
    memoryText || '(no memory)',
    '### Conversation:',
    `User: ${userMessage}`,
    `${persona.botName}:`
  ].join('\n');

  // NOTE: endpoint may differ per Google generative API version.
  // If your project uses a different model name/path update this variable.
  const endpoint = 'https://generative.googleapis.com/v1/models/text-bison-001:generate';

  const headers = { 'Content-Type': 'application/json' };
  if (GEMINI_OAUTH_BEARER) {
    headers['Authorization'] = `Bearer ${GEMINI_OAUTH_BEARER}`;
  } else if (GEMINI_API_KEY) {
    headers['x-goog-api-key'] = GEMINI_API_KEY;
  } else {
    return `Sorry, Saduni doesn't have a configured Gemini key.`;
  }

  const body = {
    // Many Google endpoints accept a prompt object; adapt if your exact API differs.
    prompt: { text: prompt },
    temperature: 0.75,
    maxOutputTokens: 300,
    // Other fields may be supported: topP, candidateCount, safetySettings, etc.
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    const j = await res.json();

    // Try a few possible response shapes
    const candidateText =
      j?.candidates?.[0]?.content ||
      j?.candidates?.[0]?.output ||
      j?.outputText ||
      j?.candidates?.[0]?.display ||
      (Array.isArray(j?.output) && j.output[0]?.content?.text) ||
      null;

    if (candidateText) return String(candidateText).trim();

    // If server returned structured blocks, attempt best-effort extraction
    if (Array.isArray(j?.candidates) && j.candidates.length && j.candidates[0].content) {
      return String(j.candidates[0].content).trim();
    }

    // If nothing matched, include a short fallback and log the full response for debugging
    console.error('Gemini raw response (first 2000 chars):', JSON.stringify(j).slice(0, 2000));
    return "Sorry love, I couldn't get a reply from Gemini right now.";
  } catch (err) {
    console.error('Gemini call error:', err);
    return "Saduni is having trouble thinking right now. Try again in a moment.";
  }
}

// ---------- WhatsApp (Baileys) ----------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    // do not rely on printQRInTerminal option — listen for conn.update qr and generate
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: QR_SMALL });
      console.log('Scan the QR above with Whatsapp (Phone → Linked devices → Link a device).');
    }

    if (connection === 'close') {
      const shouldReconnect = !(lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut);
      console.log('Connection closed. Should reconnect:', shouldReconnect);
      if (shouldReconnect) {
        // small delay before reconnecting
        setTimeout(() => start().catch(e => console.error('Reconnect failed', e)), 1500);
      }
    } else if (connection === 'open') {
      console.log('Saduni connected to WhatsApp!');
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

    // Commands start with dot
    if (text.startsWith('.')) {
      const parts = text.trim().split(/\s+/);
      const cmd = parts[0].slice(1).toLowerCase();

      if (cmd === 'help') {
        await sock.sendMessage(jid, {
          text:
`Saduni commands:
.help              - show this help
.setnick <name>    - set nickname AI uses (default "Baby")
.lovely on|off     - toggle lovely mode
.memory show       - show saved memory
.memory clear      - clear memory`
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
        await sock.sendMessage(jid, { text: on ? 'Lovely mode on.' : 'Lovely mode off.' });
        return;
      }

      if (cmd === 'memory') {
        const sub = (parts[1] || '').toLowerCase();
        if (sub === 'show') {
          const mem = readMemory()[jid] || [];
          const showText = mem.slice(-30).map(x => `${new Date(x.t).toLocaleString()}: ${x.role}: ${x.text}`).join('\n') || '(no memory)';
          await sock.sendMessage(jid, { text: `Memory:\n${showText}` });
          return;
        }
        if (sub === 'clear') {
          clearMemory(jid);
          await sock.sendMessage(jid, { text: 'Memory cleared.' });
          return;
        }
        await sock.sendMessage(jid, { text: 'Use: .memory show | .memory clear' });
        return;
      }

      await sock.sendMessage(jid, { text: 'Unknown command. Send .help' });
      return;
    }

    // Normal conversational flow
    pushMemory(jid, 'user', text);

    try { await sock.sendPresenceUpdate('composing', jid); } catch (e) { /* ignore */ }

    const aiReply = await generateWithGemini({ jid, userMessage: text });
    pushMemory(jid, 'ai', aiReply);

    await sock.sendMessage(jid, { text: aiReply });
  });
}

// start
start().catch(e => {
  console.error('Fatal start error:', e);
  process.exit(1);
});
