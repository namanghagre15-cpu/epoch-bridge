// ╔══════════════════════════════════════════════════════════════╗
// ║   EPOCH AGI — WhatsApp Bridge  v4.0                         ║
// ║   Fix: OOM crash on Render free 512MB RAM                   ║
// ║   Fix: "Loading your chats..." infinite hang                ║
// ║   Fix: Removed hardcoded webVersion (was causing rejection) ║
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
        '/opt/render/project/src/.cache/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
        '/opt/render/project/src/.cache/chrome/linux-131.0.6778.69/chrome-linux64/chrome',
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) { console.log('[CHROME]', p); return p; }
    }
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

// ── WhatsApp client ───────────────────────────────────────────
const chromePath = findChrome();

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/tmp/wa_session' }),

    // ── Takeover: kills any ghost session holding the lock ────
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000,

    // ─────────────────────────────────────────────────────────
    // REMOVED: hardcoded webVersion + webVersionCache
    //
    // Pinning a specific WA Web version caused two problems:
    //   1. WhatsApp silently rejects old versions → stuck on
    //      "Loading your chats..." forever.
    //   2. The local cache could serve a mismatched/corrupt
    //      bundle after a WA-side update.
    //
    // Letting the library fetch the current version automatically
    // (its default behaviour) is the correct fix.
    // ─────────────────────────────────────────────────────────

    puppeteer: {
        headless: true,
        executablePath: chromePath,

        // ── 2-minute timeout for slow Render cold-start ───────
        timeout: 120000,

        args: [
            // ── Mandatory sandbox disables (Render / Docker) ──
            '--no-sandbox',
            '--disable-setuid-sandbox',

            // ── Core OOM fixes ────────────────────────────────
            '--disable-dev-shm-usage',      // use /tmp, not the 64MB /dev/shm
            '--disable-gpu',                // no GPU = no GPU memory overhead
            '--no-zygote',                  // skip zygote process
            '--single-process',             // one process = lowest possible RSS

            // ── JS heap hard cap ──────────────────────────────
            // WA Web's JS runtime is the #1 RAM consumer.
            // 192MB gives it enough room to boot without OOM-ing
            // the 512MB container (Node + Chrome overhead ~200MB).
            '--js-flags=--max-old-space-size=192 --lite-mode',

            // ── Renderer memory limits ────────────────────────
            '--renderer-process-limit=1',   // never spawn extra renderers
            '--max-active-webgl-contexts=0',
            '--disable-accelerated-2d-canvas',
            '--disable-canvas-aa',
            '--disable-2d-canvas-clip-aa',

            // ── Tile / paint memory ───────────────────────────
            '--default-tile-width=256',
            '--default-tile-height=256',
            '--num-raster-threads=1',       // single raster thread

            // ── Network / background features (trim idle RAM) ─
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-breakpad',
            '--disable-client-side-phishing-detection',
            '--disable-component-update',
            '--disable-default-apps',
            '--disable-domain-reliability',
            '--disable-extensions',
            '--disable-features=site-per-process,TranslateUI,BlinkGenPropertyTrees,AudioServiceOutOfProcess',
            '--disable-hang-monitor',
            '--disable-ipc-flooding-protection',
            '--disable-notifications',
            '--disable-offer-store-unmasked-wallet-cards',
            '--disable-popup-blocking',
            '--disable-print-preview',
            '--disable-prompt-on-repost',
            '--disable-renderer-backgrounding',
            '--disable-speech-api',
            '--disable-sync',
            '--disable-translate',
            '--disable-web-security',        // avoids some CORS pre-flight overhead

            // ── Media / codec overhead ────────────────────────
            // WA Web auto-downloads recent media in the background.
            // These flags prevent codec initialisation and HW decode
            // attempts that burn RAM even on a headless server.
            '--disable-webgl',
            '--disable-webgl2',
            '--disable-webrtc',
            '--disable-media-stream',
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-capture',

            // ── Misc cold-start helpers ───────────────────────
            '--hide-scrollbars',
            '--ignore-certificate-errors',
            '--log-level=3',                // suppress most Chrome console spam
            '--metrics-recording-only',
            '--mute-audio',
            '--no-default-browser-check',
            '--no-first-run',
            '--no-pings',
            '--password-store=basic',
            '--safebrowsing-disable-auto-update',
            '--use-mock-keychain',
        ],
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

client.on('loading_screen', (percent, message) => {
    // Log loading progress so you can see in Render logs whether
    // it's progressing or silently stalled.
    console.log(`[WA] Loading: ${percent}% — ${message}`);
});

client.on('authenticated', () => {
    console.log('[WA] Authenticated ✅ — waiting for ready...');
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

client.on('auth_failure', async (msg) => {
    console.error('[WA] Auth failure:', msg);
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

// ── Hourly temp-file cleanup ──────────────────────────────────
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
