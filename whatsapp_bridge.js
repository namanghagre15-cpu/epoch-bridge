// ╔══════════════════════════════════════════════════════════════╗
// ║   EPOCH AGI — WhatsApp Bridge   (Node.js)                   ║
// ║   whatsapp-web.js → HuggingFace FastAPI                     ║
// ║   QR Code → Telegram (Naman ke phone pe)                    ║
// ╚══════════════════════════════════════════════════════════════╝

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode  = require('qrcode');
const axios   = require('axios');
const express = require('express');
const fs      = require('fs');
const path    = require('path');

// ── Config ────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID      = process.env.ADMIN_CHAT_ID;
const HF_BACKEND_URL     = process.env.HF_BACKEND_URL   // e.g. https://namanzo-epoch-system.hf.space
                           || 'http://localhost:7860';
const PORT               = process.env.PORT || 3001;

// ── Express (for /send endpoint from Python backend) ──────────
const app = express();
app.use(express.json());

// ── WhatsApp Client ───────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './wa_session' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
        ]
    }
});

// ── Helpers ───────────────────────────────────────────────────
async function sendTelegramMessage(text) {
    if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) {
        console.log('[TG] No Telegram config — skip');
        return;
    }
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: ADMIN_CHAT_ID, text, parse_mode: 'Markdown' }
        );
    } catch (e) {
        console.error('[TG] Message failed:', e.message);
    }
}

async function sendTelegramPhoto(photoPath, caption) {
    if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) return;
    try {
        const FormData = require('form-data');
        const form     = new FormData();
        form.append('chat_id', ADMIN_CHAT_ID);
        form.append('caption', caption || 'QR Code');
        form.append('photo', fs.createReadStream(photoPath));
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
            form, { headers: form.getHeaders() }
        );
    } catch (e) {
        console.error('[TG] Photo failed:', e.message);
        // Fallback: send as text
        await sendTelegramMessage(`🔑 Scan QR at: Check server logs`);
    }
}

// ── WhatsApp Events ───────────────────────────────────────────

// QR Code — send to Telegram as image
client.on('qr', async (qr) => {
    console.log('[WA] QR received — sending to Telegram...');
    const qrPath = './qr_code.png';
    try {
        await qrcode.toFile(qrPath, qr, { width: 400 });
        await sendTelegramPhoto(qrPath,
            '📱 *Epoch AGI — WhatsApp QR Code*\n\nIs QR ko scan karo WhatsApp pe:\n1. WhatsApp kholo\n2. Devices > Linked Devices\n3. Link a Device\n4. QR scan karo\n\n_Jaldi karo — 60 seconds mein expire hoga!_'
        );
        console.log('[WA] QR sent to Telegram ✅');
    } catch (e) {
        console.error('[WA] QR send failed:', e.message);
        // ASCII QR fallback
        const qrTerminal = require('qrcode-terminal');
        qrTerminal.generate(qr, { small: true });
    }
});

// Ready
client.on('ready', async () => {
    console.log('[WA] ✅ WhatsApp Connected!');
    const info = client.info;
    await sendTelegramMessage(
        `✅ *WhatsApp Connected!*\n\n` +
        `📱 Number: ${info?.wid?.user || 'Unknown'}\n` +
        `👤 Name: ${info?.pushname || 'Epoch AGI'}\n` +
        `🤖 Epoch AGI ready to serve students!`
    );
});

// Disconnected
client.on('disconnected', async (reason) => {
    console.log('[WA] Disconnected:', reason);
    await sendTelegramMessage(
        `⚠️ *WhatsApp Disconnected!*\n\nReason: ${reason}\n\nAuto-reconnect ho raha hai...`
    );
    // Auto-restart after 5 seconds
    setTimeout(() => {
        console.log('[WA] Restarting...');
        client.initialize();
    }, 5000);
});

// Authentication failure
client.on('auth_failure', async (msg) => {
    console.error('[WA] Auth failure:', msg);
    await sendTelegramMessage(
        `❌ *WhatsApp Auth Failed!*\n\nSession clear karke dobara QR scan karo.\n\nServer pe: \`rm -rf ./wa_session\` run karo`
    );
});

// ── Main Message Handler ──────────────────────────────────────
client.on('message', async (msg) => {
    try {
        const sender = msg.from; // e.g. "919876543210@c.us"
        const body   = msg.body || '';

        // Skip group messages
        if (sender.includes('@g.us')) return;

        // Skip status updates
        if (sender === 'status@broadcast') return;

        // Skip messages from self
        if (msg.fromMe) return;

        console.log(`[WA] Message from ${sender}: ${body.substring(0, 80)}`);

        // Build payload for Python backend
        const payload = {
            sender:     sender.replace('@c.us', ''),
            text:       body,
            media_url:  null,
            media_type: 'image'
        };

        // Handle media (images, PDFs, voice notes)
        if (msg.hasMedia) {
            try {
                const media    = await msg.downloadMedia();
                const mimeType = media.mimetype || '';

                // Determine media type
                if (mimeType.startsWith('image/')) {
                    payload.media_type = 'image';
                } else if (mimeType === 'application/pdf') {
                    payload.media_type = 'pdf';
                } else if (mimeType.startsWith('audio/')) {
                    payload.media_type = 'audio';
                }

                // Save media temporarily and create accessible URL
                const ext      = mimeType.split('/')[1]?.split(';')[0] || 'bin';
                const filename = `media_${Date.now()}.${ext}`;
                const filepath = path.join('./temp', filename);

                if (!fs.existsSync('./temp')) fs.mkdirSync('./temp');
                fs.writeFileSync(filepath, Buffer.from(media.data, 'base64'));

                // Serve via local express for Python to download
                payload.media_url = `http://localhost:${PORT}/media/${filename}`;
                console.log(`[WA] Media saved: ${filename} (${mimeType})`);
            } catch (mediaErr) {
                console.error('[WA] Media download failed:', mediaErr.message);
            }
        }

        // Forward to Python backend
        const response = await axios.post(
            `${HF_BACKEND_URL}/whatsapp-webhook`,
            payload,
            { timeout: 30000 }
        );

        console.log(`[WA] Backend response: ${response.data?.status}`);

    } catch (err) {
        console.error('[WA] Message handler error:', err.message);
    }
});

// ── /send Endpoint (Python backend → WhatsApp) ────────────────
app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) {
        return res.status(400).json({ error: 'phone and message required' });
    }
    try {
        // Format: 919876543210@c.us
        const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
        await client.sendMessage(chatId, message);
        console.log(`[WA] Sent to ${phone}: ${message.substring(0, 60)}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[WA] Send failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Media Server (serve temp files to Python backend) ─────────
app.get('/media/:filename', (req, res) => {
    const filepath = path.join('./temp', req.params.filename);
    if (fs.existsSync(filepath)) {
        res.sendFile(path.resolve(filepath));
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// ── Health Check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status:    'online',
        wa_ready:  client.info ? true : false,
        timestamp: new Date().toISOString()
    });
});

// ── Cleanup temp files every hour ────────────────────────────
setInterval(() => {
    const tempDir = './temp';
    if (!fs.existsSync(tempDir)) return;
    const files = fs.readdirSync(tempDir);
    const now   = Date.now();
    files.forEach(f => {
        const fpath = path.join(tempDir, f);
        const stat  = fs.statSync(fpath);
        // Delete files older than 1 hour
        if (now - stat.mtimeMs > 3600000) {
            fs.unlinkSync(fpath);
            console.log(`[CLEANUP] Deleted: ${f}`);
        }
    });
}, 3600000);

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[EXPRESS] Running on port ${PORT}`);
});

client.initialize();
console.log('[WA] Initializing WhatsApp client...');
