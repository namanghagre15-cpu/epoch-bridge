// ╔══════════════════════════════════════════════════════════════╗
// ║   EPOCH AGI — WhatsApp Bridge  (Render.com Free Tier)       ║
// ║   Fix: Explicit Chrome path for Render + Puppeteer          ║
// ╚══════════════════════════════════════════════════════════════╝

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode   = require('qrcode');
const axios    = require('axios');
const express  = require('express');
const fs       = require('fs');
const path     = require('path');

// ── Config ────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID      = process.env.ADMIN_CHAT_ID;
const HF_BACKEND_URL     = process.env.HF_BACKEND_URL || 'http://localhost:7860';
const PORT               = process.env.PORT || 3001;

// ── Find Chrome Path (Render.com compatible) ──────────────────
function getChromePath() {
    // Render.com mein puppeteer chrome yahan hota hai
    const renderPath = '/opt/render/.cache/puppeteer/chrome/linux-147.0.7727.57/chrome-linux64/chrome';
    const renderPathAlt = '/opt/render/.cache/puppeteer/chrome/linux-131.0.6778.69/chrome-linux64/chrome';

    // Check common paths
    const possiblePaths = [
        renderPath,
        renderPathAlt,
        // Generic puppeteer cache paths
        `${process.env.HOME}/.cache/puppeteer/chrome/linux-147.0.7727.57/chrome-linux64/chrome`,
        `${process.env.HOME}/.cache/puppeteer/chrome/linux-131.0.6778.69/chrome-linux64/chrome`,
        // Find any chrome in puppeteer cache
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome',
    ];

    for (const p of possiblePaths) {
        if (p && fs.existsSync(p)) {
            console.log(`[CHROME] Found at: ${p}`);
            return p;
        }
    }

    // Dynamic search in puppeteer cache
    const puppeteerCache = process.env.PUPPETEER_CACHE_DIR
        || `${process.env.HOME}/.cache/puppeteer`
        || '/opt/render/.cache/puppeteer';

    try {
        if (fs.existsSync(puppeteerCache)) {
            // Find chrome executable recursively
            const result = findFile(puppeteerCache, 'chrome');
            if (result) {
                console.log(`[CHROME] Found dynamically: ${result}`);
                return result;
            }
        }
    } catch (e) {
        console.log('[CHROME] Dynamic search failed:', e.message);
    }

    console.log('[CHROME] Using default puppeteer path');
    return undefined; // Let puppeteer use its default
}

function findFile(dir, name) {
    try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const full = path.join(dir, item);
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
                const found = findFile(full, name);
                if (found) return found;
            } else if (item === name && stat.mode & 0o111) {
                return full; // Executable file
            }
        }
    } catch (e) {}
    return null;
}

// ── Express ───────────────────────────────────────────────────
const app = express();
app.use(express.json());
if (!fs.existsSync('./temp')) fs.mkdirSync('./temp');

// ── WhatsApp Client ───────────────────────────────────────────
const chromePath    = getChromePath();
const puppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-extensions',
    '--disable-software-rasterizer',
    '--disable-background-networking',
    '--disable-default-apps',
    '--mute-audio',
];

const clientConfig = {
    authStrategy: new LocalAuth({ dataPath: '/tmp/wa_session' }),
    puppeteer: {
        headless: true,
        args: puppeteerArgs,
        ...(chromePath ? { executablePath: chromePath } : {}),
    }
};

const client = new Client(clientConfig);

// ── Telegram Helpers ──────────────────────────────────────────
async function tgSend(text) {
    if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) return;
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: ADMIN_CHAT_ID, text, parse_mode: 'Markdown' },
            { timeout: 10000 }
        );
    } catch (e) {
        console.error('[TG] Send failed:', e.message);
    }
}

async function tgSendPhoto(photoPath, caption) {
    if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) return;
    try {
        const FormData = require('form-data');
        const form = new FormData();
        form.append('chat_id', ADMIN_CHAT_ID);
        form.append('caption', caption);
        form.append('photo', fs.createReadStream(photoPath));
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
            form, { headers: form.getHeaders(), timeout: 15000 }
        );
        console.log('[TG] QR photo sent ✅');
    } catch (e) {
        console.error('[TG] Photo send failed:', e.message);
        await tgSend('📱 QR generate hua — server logs check karo ya restart karo.');
    }
}

// ── WhatsApp Events ───────────────────────────────────────────
client.on('qr', async (qr) => {
    console.log('[WA] QR received');
    const qrPath = '/tmp/epoch_qr.png';
    try {
        await qrcode.toFile(qrPath, qr, { width: 400 });
        await tgSendPhoto(qrPath,
            '📱 *Epoch AGI — WhatsApp QR*\n\nScan karo:\n1. WhatsApp open karo\n2. Settings → Linked Devices\n3. Link a Device → Scan!\n\n⚠️ 60 seconds mein expire!'
        );
    } catch (e) {
        console.error('[WA] QR processing failed:', e.message);
    }
});

client.on('ready', async () => {
    const num = client.info?.wid?.user || 'Unknown';
    console.log(`[WA] ✅ Ready! Number: ${num}`);
    await tgSend(`✅ *WhatsApp Connected!*\n\n📱 Number: ${num}\n🤖 Epoch AGI is LIVE!`);
});

client.on('disconnected', async (reason) => {
    console.log('[WA] Disconnected:', reason);
    await tgSend(`⚠️ *WhatsApp Disconnected*\nReason: ${reason}\nReconnecting...`);
    setTimeout(() => client.initialize(), 8000);
});

client.on('auth_failure', async () => {
    await tgSend('❌ *Auth Failed!* Session clear karke redeploy karo.');
});

// ── Message Handler ───────────────────────────────────────────
client.on('message', async (msg) => {
    try {
        if (msg.from.includes('@g.us'))          return; // Skip groups
        if (msg.from === 'status@broadcast')     return; // Skip status
        if (msg.fromMe)                          return; // Skip own messages

        const sender = msg.from.replace('@c.us', '');
        const body   = msg.body || '';
        console.log(`[WA] ${sender}: ${body.substring(0, 80)}`);

        const payload = {
            sender,
            text:       body,
            media_url:  null,
            media_type: 'image'
        };

        // Handle media
        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                const mime  = media.mimetype || '';
                const ext   = mime.split('/')[1]?.split(';')[0] || 'bin';
                const fname = `media_${Date.now()}.${ext}`;
                const fpath = path.join('./temp', fname);

                fs.writeFileSync(fpath, Buffer.from(media.data, 'base64'));
                payload.media_url  = `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:'+PORT}/media/${fname}`;
                payload.media_type = mime.startsWith('image/') ? 'image' : mime === 'application/pdf' ? 'pdf' : 'image';
            } catch (me) {
                console.error('[WA] Media error:', me.message);
            }
        }

        // Forward to HuggingFace backend
        await axios.post(`${HF_BACKEND_URL}/whatsapp-webhook`, payload, { timeout: 60000 });

    } catch (err) {
        console.error('[WA] Handler error:', err.message);
    }
});

// ── /send Endpoint (Python → WhatsApp) ───────────────────────
app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Missing phone/message' });
    try {
        const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
        await client.sendMessage(chatId, message);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Media File Server ─────────────────────────────────────────
app.get('/media/:file', (req, res) => {
    const fp = path.join('./temp', req.params.file);
    fs.existsSync(fp) ? res.sendFile(path.resolve(fp)) : res.status(404).end();
});

// ── Health ────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
    status:   'online',
    wa_ready: !!client.info,
    chrome:   chromePath || 'default'
}));

// ── Cleanup temp every hour ───────────────────────────────────
setInterval(() => {
    try {
        fs.readdirSync('./temp').forEach(f => {
            const fp = path.join('./temp', f);
            if (Date.now() - fs.statSync(fp).mtimeMs > 3600000) fs.unlinkSync(fp);
        });
    } catch (e) {}
}, 3600000);

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[EXPRESS] Port ${PORT}`));
client.initialize();
console.log('[WA] Starting... Chrome:', chromePath || 'default puppeteer');
