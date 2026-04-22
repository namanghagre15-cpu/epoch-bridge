// ╔══════════════════════════════════════════════════════════════╗
// ║   EPOCH AGI — WhatsApp Bridge  v3.0                         ║
// ║   Fix: Chrome OOM crash on Render free 512MB RAM            ║
// ║   Fix: TargetCloseError — aggressive memory flags           ║
// ╚══════════════════════════════════════════════════════════════╝

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode');
const axios   = require('axios');
const express = require('express');
const fs      = require('fs');
const path    = require('path');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID      = process.env.ADMIN_CHAT_ID;
const HF_BACKEND_URL     = process.env.HF_BACKEND_URL || 'http://localhost:7860';
const PORT               = process.env.PORT || 3001;

// ── Find Chrome ───────────────────────────────────────────────
function findChrome() {
    const candidates = [
        // Render .cache path (new location)
        '/opt/render/project/src/.cache/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
        '/opt/render/project/src/.cache/chrome/linux-131.0.6778.69/chrome-linux64/chrome',
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) { console.log('[CHROME]', p); return p; }
    }
    // Dynamic search
    const base = '/opt/render/project/src/.cache/chrome';
    if (fs.existsSync(base)) {
        const hit = walk(base, 'chrome');
        if (hit) { console.log('[CHROME] dynamic:', hit); return hit; }
    }
    return undefined;
}
function walk(dir, name) {
    try {
        for (const f of fs.readdirSync(dir)) {
            const full = path.join(dir, f);
            const st   = fs.statSync(full);
            if (st.isDirectory()) { const r = walk(full, name); if (r) return r; }
            else if (f === name && (st.mode & 0o111)) return full;
        }
    } catch (_) {}
    return null;
}

// ── Express ───────────────────────────────────────────────────
const app = express();
app.use(express.json());
if (!fs.existsSync('./temp')) fs.mkdirSync('./temp');

// ── WhatsApp client (memory-optimised for 512MB Render free) ──
const chromePath = findChrome();

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/tmp/wa_session' }),
    puppeteer: {
        headless: true,
        executablePath: chromePath,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',          // Use /tmp instead of /dev/shm
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--single-process',                 // One process = less RAM
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--mute-audio',
            '--safebrowsing-disable-auto-update',
            '--disable-features=site-per-process,TranslateUI',
            '--js-flags=--max-old-space-size=256', // Limit JS heap to 256MB
            '--memory-pressure-off',
        ],
        timeout: 120000,  // 2 min timeout for slow Render startup
    },
    webVersion: '2.2412.54',  // Pin WA version to avoid injection errors
    webVersionCache: {
        type: 'local',
        path: '/tmp/wa_version_cache',
    },
});

// ── Telegram ──────────────────────────────────────────────────
async function tgSend(text) {
    if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) return;
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: ADMIN_CHAT_ID, text, parse_mode: 'Markdown' },
            { timeout: 10000 }
        );
    } catch (e) { console.error('[TG]', e.message); }
}

async function tgSendQR(qrPath) {
    if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) return;
    try {
        const FormData = require('form-data');
        const form = new FormData();
        form.append('chat_id', ADMIN_CHAT_ID);
        form.append('caption',
            '📱 *Epoch AGI QR Code*\n\nScan:\n1. WhatsApp → Settings → Linked Devices\n2. Link a Device → Scan!\n\n⏰ 60 sec mein expire!');
        form.append('photo', fs.createReadStream(qrPath));
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
            form, { headers: form.getHeaders(), timeout: 15000 }
        );
        console.log('[TG] QR sent ✅');
    } catch (e) {
        console.error('[TG] QR photo failed:', e.message);
        await tgSend('📱 QR ready — check server logs or restart if stuck.');
    }
}

// ── Events ────────────────────────────────────────────────────
client.on('qr', async (qr) => {
    console.log('[WA] QR received');
    const p = '/tmp/epoch_qr.png';
    await qrcode.toFile(p, qr, { width: 400 });
    await tgSendQR(p);
});

client.on('ready', async () => {
    const num = client.info?.wid?.user || '?';
    console.log(`[WA] ✅ Ready! +${num}`);
    await tgSend(`✅ *WhatsApp Connected!*\n📱 +${num}\n🤖 Epoch AGI LIVE!`);
});

client.on('disconnected', async (reason) => {
    console.log('[WA] Disconnected:', reason);
    await tgSend(`⚠️ *Disconnected:* ${reason}\nRestarting in 10s...`);
    setTimeout(() => { try { client.initialize(); } catch (_) {} }, 10000);
});

client.on('auth_failure', async () => {
    await tgSend('❌ *Auth Failed!* Redeploy karo.');
});

// ── Message handler ───────────────────────────────────────────
client.on('message', async (msg) => {
    try {
        if (msg.from.includes('@g.us'))       return;
        if (msg.from === 'status@broadcast')  return;
        if (msg.fromMe)                       return;

        const sender = msg.from.replace('@c.us', '');
        const body   = msg.body || '';
        console.log(`[WA] ${sender}: ${body.substring(0, 80)}`);

        const payload = { sender, text: body, media_url: null, media_type: 'image' };

        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                const mime  = media.mimetype || '';
                const ext   = mime.split('/')[1]?.split(';')[0] || 'bin';
                const fname = `m_${Date.now()}.${ext}`;
                const fpath = path.join('./temp', fname);
                fs.writeFileSync(fpath, Buffer.from(media.data, 'base64'));
                const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
                payload.media_url  = `https://${host}/media/${fname}`;
                payload.media_type = mime.startsWith('image/') ? 'image'
                                   : mime === 'application/pdf' ? 'pdf' : 'image';
            } catch (me) { console.error('[WA] Media:', me.message); }
        }

        await axios.post(`${HF_BACKEND_URL}/whatsapp-webhook`, payload,
                         { timeout: 60000 });
    } catch (e) { console.error('[WA] Handler:', e.message); }
});

// ── /send endpoint ────────────────────────────────────────────
app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Missing' });
    try {
        await client.sendMessage(
            phone.includes('@') ? phone : `${phone}@c.us`,
            message
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/media/:f', (req, res) => {
    const fp = path.join('./temp', req.params.f);
    fs.existsSync(fp) ? res.sendFile(path.resolve(fp)) : res.status(404).end();
});

app.get('/health', (_, res) => res.json({
    status: 'online', wa: !!client.info, chrome: chromePath || 'default'
}));

// ── Cleanup ───────────────────────────────────────────────────
setInterval(() => {
    try {
        fs.readdirSync('./temp').forEach(f => {
            const fp = path.join('./temp', f);
            if (Date.now() - fs.statSync(fp).mtimeMs > 3600000) fs.unlinkSync(fp);
        });
    } catch (_) {}
}, 3600000);

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[EXPRESS] Port ${PORT}`));
console.log('[WA] Starting... Chrome:', chromePath || 'default');
client.initialize();
