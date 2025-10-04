/**
 * index.js
 * Saduni — WhatsApp "girlfriend" AI bot (Gemini-only)
 *
 * Paste your Gemini API key into the GEMINI_API_KEY variable below
 * or create a .env with GEMINI_API_KEY=...  OR use GEMINI_OAUTH_BEARER for a Bearer token.
 *
 * WARNING: Hardcoding API keys in source is insecure for production. Use .env or a secret manager.
 */

const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const fs = require('fs-extra')
const path = require('path')
const fetch = require('node-fetch')
require('dotenv').config()

// ======= CONFIG =======
const MEMORY_FILE = path.join(__dirname, 'memory.json')
const PERSONA_FILE = path.join(__dirname, 'persona.json')
const MAX_MESSAGES_PER_CHAT = 60

// Paste your Gemini API key here (optional) OR set in .env as GEMINI_API_KEY
let GEMINI_API_KEY = 'AIzaSyAV-KhlQxFRVw5AvozYPuqNEKDilSWGevo' // <-- paste your Gemini API key here if you prefer
// If your project needs OAuth access token (Bearer), put it in GEMINI_OAUTH_BEARER or .env
let GEMINI_OAUTH_BEARER = '319057617500-acflu2ogcjmbbpq68q4h3f4pffo13j57.apps.googleusercontent.com'

GEMINI_API_KEY = GEMINI_API_KEY || process.env.GEMINI_API_KEY || ''
GEMINI_OAUTH_BEARER = GEMINI_OAUTH_BEARER || process.env.GEMINI_OAUTH_BEARER || ''

// Default persona: bot name Saduni
if (!fs.existsSync(MEMORY_FILE)) fs.writeJSONSync(MEMORY_FILE, {})
if (!fs.existsSync(PERSONA_FILE)) fs.writeJSONSync(PERSONA_FILE, {})

function readMemory() { return fs.readJSONSync(MEMORY_FILE) }
function writeMemory(obj) { fs.writeJSONSync(MEMORY_FILE, obj, { spaces: 2 }) }
function pushMemory(jid, role, text) {
  const mem = readMemory()
  if (!mem[jid]) mem[jid] = []
  mem[jid].push({ t: Date.now(), role, text })
  if (mem[jid].length > MAX_MESSAGES_PER_CHAT) mem[jid] = mem[jid].slice(-MAX_MESSAGES_PER_CHAT)
  writeMemory(mem)
}
function getMemoryText(jid) {
  const mem = readMemory()
  if (!mem[jid]) return ''
  return mem[jid].map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.text}`).join('\n')
}
function clearMemory(jid) {
  const mem = readMemory(); delete mem[jid]; writeMemory(mem)
}

function getPersona(jid) {
  const p = fs.readJSONSync(PERSONA_FILE)
  const base = { botName: 'Saduni', lovelyMode: true, nickname: 'Baby', tone: 'loving' }
  return Object.assign(base, p[jid] || {})
}
function setPersona(jid, obj) {
  const p = fs.readJSONSync(PERSONA_FILE)
  p[jid] = Object.assign(p[jid] || {}, obj)
  fs.writeJSONSync(PERSONA_FILE, p, { spaces: 2 })
}

// ======= Gemini-only generation =======
async function generateWithGemini({ jid, userMessage }) {
  const persona = getPersona(jid)
  const memoryText = getMemoryText(jid)
  const systemPrompt = `You are ${persona.botName} — a sweet, affectionate WhatsApp girlfriend. Tone: ${persona.tone}. Keep replies short, warm, and natural.`
  const prompt = [
    systemPrompt,
    '### Memory:',
    memoryText || '(no memory)',
    '### Conversation:',
    `User: ${userMessage}`,
    `${persona.botName}:`
  ].join('\n')

  // Example endpoint — adapt if your project uses a different model name
  const endpoint = 'https://generative.googleapis.com/v1/models/text-bison-001:generate'

  const headers = { 'Content-Type': 'application/json' }
  if (GEMINI_OAUTH_BEARER) {
    headers['Authorization'] = `Bearer ${GEMINI_OAUTH_BEARER}`
  } else if (GEMINI_API_KEY) {
    headers['x-goog-api-key'] = GEMINI_API_KEY
  } else {
    return `Aww, I can't reply right now because my Gemini key isn't set.`
  }

  const body = {
    prompt: { text: prompt },
    temperature: 0.8,
    maxOutputTokens: 300
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
    const j = await res.json()

    const candidateText =
      j?.candidates?.[0]?.content ||
      j?.outputText ||
      j?.candidates?.[0]?.display ||
      (typeof j?.content === 'string' && j.content) ||
      null

    if (candidateText) return candidateText.trim()

    if (Array.isArray(j?.candidates) && j.candidates.length && j.candidates[0].content) {
      return j.candidates[0].content.trim()
    }

    console.error('Gemini raw response:', JSON.stringify(j).slice(0, 2000))
    return "Sorry love, I couldn't get a proper reply from Gemini right now."
  } catch (err) {
    console.error('Gemini call error', err)
    return "Sorry, Saduni is having trouble thinking right now. Please try again later."
  }
}

// ======= Start Baileys socket =======
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection } = update
    if (connection === 'open') console.log('✅ Saduni connected to WhatsApp')
    if (connection === 'close') console.log('Saduni connection closed — check logs if needed')
  })

  sock.ev.on('messages.upsert', async (m) => {
    const message = m.messages?.[0]
    if (!message) return
    if (message.key && message.key.remoteJid === 'status@broadcast') return
    if (message.key.fromMe) return

    const jid = message.key.remoteJid
    let text = ''
    if (message.message?.conversation) text = message.message.conversation
    else if (message.message?.extendedTextMessage?.text) text = message.message.extendedTextMessage.text
    else if (message.message?.imageMessage?.caption) text = message.message.imageMessage.caption
    else if (message.message?.videoMessage?.caption) text = message.message.videoMessage.caption
    if (!text) return

    console.log(`Message from ${jid}: ${text}`)

    // Commands (start with dot)
    if (text.startsWith('.')) {
      const parts = text.trim().split(' ')
      const cmd = parts[0].slice(1).toLowerCase()

      if (cmd === 'help') {
        await sock.sendMessage(jid, { text:
`Saduni commands:
.help              - show this help
.setnick <name>    - set nickname AI uses (default "Baby")
.lovely on|off     - toggle lovely mode
.memory show       - show saved memory
.memory clear      - clear memory
`})
        return
      }

      if (cmd === 'setnick') {
        const name = parts.slice(1).join(' ') || 'Baby'
        setPersona(jid, { nickname: name })
        await sock.sendMessage(jid, { text: `Okay 💕 I'll call you ${name}.` })
        return
      }

      if (cmd === 'lovely') {
        const param = (parts[1] || 'on').toLowerCase()
        const on = param === 'on'
        setPersona(jid, { lovelyMode: on, tone: on ? 'loving' : 'casual' })
        await sock.sendMessage(jid, { text: on ? 'Lovely mode on ❤️' : 'Lovely mode off.' })
        return
      }

      if (cmd === 'memory') {
        const sub = (parts[1] || '').toLowerCase()
        if (sub === 'show') {
          const mem = readMemory()[jid] || []
          const showText = mem.slice(-20).map(x => `${new Date(x.t).toLocaleString()}: ${x.role}: ${x.text}`).join('\n') || '(no memory)'
          await sock.sendMessage(jid, { text: `Memory:\n${showText}` })
          return
        }
        if (sub === 'clear') {
          clearMemory(jid)
          await sock.sendMessage(jid, { text: 'Memory cleared 🗑️' })
          return
        }
        await sock.sendMessage(jid, { text: 'Usage: .memory show | .memory clear' })
        return
      }

      await sock.sendMessage(jid, { text: 'Unknown command. Send .help' })
      return
    }

    // Normal flow: save user message and reply using Gemini
    pushMemory(jid, 'user', text)

    try { await sock.sendPresenceUpdate('composing', jid) } catch (e) { /* ignore */ }

    const aiReply = await generateWithGemini({ jid, userMessage: text })
    pushMemory(jid, 'ai', aiReply)
    await sock.sendMessage(jid, { text: aiReply })
  })
}

start().catch(e => {
  console.error('Start error', e)
  process.exit(1)
})