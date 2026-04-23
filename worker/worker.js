const { Client, LocalAuth } = require('whatsapp-web.js');
const { Worker } = require('bullmq');
const { connection } = require('./queue');
const db = require('./db');
const io = require('socket.io-client');
const fs = require('fs');
const path = require('path');

const socket = io('http://validator_api:3000', {
    transports: ['websocket']
});

// =============================
// 🧹 FIX CHROMIUM LOCK
// =============================
const SESSION_PATH = '/app/session';
function cleanupLocks(dir) {
    try {
        if (!fs.existsSync(dir)) return;
        for (const item of fs.readdirSync(dir)) {
            const full = path.join(dir, item);
            if (fs.lstatSync(full).isDirectory()) {
                cleanupLocks(full);
            } else if (item.includes('SingletonLock')) {
                console.log('🧹 Removendo lock:', full);
                fs.unlinkSync(full);
            }
        }
    } catch {}
}
cleanupLocks(SESSION_PATH);

// =============================
// ⚙️ CONFIG
// =============================
const DAILY_LIMIT = 250;
const DAY_MS = 24 * 60 * 60 * 1000;
let isFirstRun = true;

let burstCount = 0;
let maxBurst = getRandom(4, 8);

function getRandom(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getDelay() {
    const now = new Date();
    const hour = now.getHours();

    // 🔹 BASE: distribuição ao longo do dia
    const base = DAY_MS / DAILY_LIMIT; // ~5.7 min

    // 🔹 variação forte (±50%)
    let delay = base * (0.5 + Math.random());

    // =============================
    // 🕒 CURVA HUMANA DE HORÁRIO
    // =============================
    if (hour >= 0 && hour <= 6) {
        delay *= 2.5; // madrugada quase inativo
    } else if (hour >= 7 && hour <= 11) {
        delay *= 0.8; // manhã mais ativo
    } else if (hour >= 12 && hour <= 14) {
        delay *= 1.2; // almoço leve redução
    } else if (hour >= 15 && hour <= 18) {
        delay *= 1.0; // tarde normal
    } else if (hour >= 19 && hour <= 23) {
        delay *= 1.3; // noite mais lento
    }

    // =============================
    // 👤 COMPORTAMENTO HUMANO
    // =============================
    if (burstCount < maxBurst) {
        burstCount++;

        // ritmo humano real (mais lento)
        const humanDelay = Math.random() * 75000 + 45000; // 45s – 120s

        // mistura comportamento + distribuição
        delay = (delay * 0.6) + (humanDelay * 0.4);

        sendLog(
            `🛡️ Atividade (${burstCount}/${maxBurst})`,
            'info',
            'system'
        );
    } else {
        burstCount = 0;
        maxBurst = getRandom(4, 8);

        // pausa média
        const pause = Math.random() * 600000 + 300000; // 5–15 min

        delay += pause;

        sendLog(
            `🛡️ Pausa curta`,
            'info',
            'system'
        );
    }

    // =============================
    // 💤 PAUSA LONGA (eventual)
    // =============================
    if (Math.random() < 0.05) { // 8% de chance
        const longPause = Math.random() * 2400000 + 1200000; // 20–60 min

        delay += longPause;

        sendLog(
            `💤 Pausa longa (simulando ausência do usuário)`,
            'warning',
            'system'
        );
    }

    // mínimo seguro
    return Math.max(delay, 30000);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// =============================
// 📱 CLIENT WHATSAPP
// =============================
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/app/session' }),
    puppeteer: {
        headless: true,
        executablePath: '/usr/bin/chromium',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ]
    }
});

// EVENTOS BÁSICOS
client.on('qr', qr => {
    socket.emit('qr', qr);
    socket.emit('status', 'disconnected');
});

client.on('ready', () => {
    console.log('✅ WhatsApp conectado e pronto');
    socket.emit('status', 'connected');
    socket.emit('qr', null);
});

client.on('disconnected', () => {
    socket.emit('status', 'disconnected');
});

// =============================
// 📢 LOG STREAMER
// =============================
function sendLog(message, level = 'info', type = 'worker') {
    socket.emit('worker-log', {
        message,
        level,
        type,
        timestamp: new Date().toISOString()
    });
}

// =============================
// 🧠 PROCESSADOR HARDENED
// =============================
const worker = new Worker('validate', async (job) => {
    const id = job.data.id;
    

    // 1️⃣ PROTEÇÃO BURST INICIAL
    if (isFirstRun) {
        const initialWait = 5000 + Math.random() * 5000;
        console.log(`🛡️ [PROTEÇÃO] Burst inicial detectado. Aguardando ${Math.round(initialWait/1000)}s...`);
        sendLog(`🛡️ Simulando comportamento humano (delay inicial de ${Math.round(initialWait/1000)}s)`, 'warning', 'system');
        await sleep(initialWait);
        isFirstRun = false;
    }

    try {
        // 2️⃣ DUAL SAFETY CHECK
        const running = await db.isSystemRunning();
        if (!running) {
            console.log('🔴 [SAFETY] Sistema PAUSADO. Abortando job.');
            sendLog('⏸ Sistema pausado. Aguardando comando...', 'warning', 'system');
            throw new Error('SYSTEM_PAUSED');
        }

        // 3️⃣ WHATSAPP READINESS
        if (!client.info || !client.pupPage) {
            console.log('⚠️ [SAFETY] WhatsApp não está pronto.');
            sendLog('⚠️ WhatsApp não está conectado. Aguardando...', 'error', 'system');
            throw new Error('WHATSAPP_NOT_READY');
        }

        // 4️⃣ DAILY LIMIT CHECK (FORTE E INTELIGENTE)
        const usage = await db.getTodayUsage();

        if (usage.used >= usage.limit) {

            await db.setSystemRunning(false);
            await db.setPauseReason('limit');

            console.log('🚫 Limite diário atingido. Pausando sistema.');

            sendLog(
                '🚫 Limite diário atingido. Aguardando próximo dia...',
                'warning',
                'system'
            );

            await sleep(5 * 60 * 1000);

            throw new Error('DAILY_LIMIT_REACHED');
        }

        // 5️⃣ ATOMIC CLAIM
        const row = await db.claimJob(id);
        if (!row) return;

        console.log(`🔍 Validando: ${row.number} | 🟢 Sistema: RUNNING`);
        sendLog(
        `🔍 ${row.number} | 📦 ${row.file_id}`,
        'info',
        'worker'
        );

        // EXECUÇÃO REAL
        const valid = await client.isRegisteredUser(row.number + '@c.us');

        // 6️⃣ FINALIZAÇÃO (SÓ AQUI INCREMENTA USO)
        await db.finalizeJob(id, valid);
        await db.incrementUsage(); 

        
        console.log(`✔ ${row.number} → ${valid ? 'VÁLIDO' : 'INVÁLIDO'} | 📊 Uso: ${usage.used}/${usage.limit}`);
        
        const resMsg = `✔ ${row.number} → ${valid ? 'VÁLIDO' : 'INVÁLIDO'} | 📦 ${row.file_id}`;
        sendLog(resMsg, valid ? 'success' : 'warning', 'worker');

        socket.emit('progress', { 
            number: row.number,
            valid,
            file_id: row.file_id,
            lead_id: row.lead_id
        });
        socket.emit('daily', usage);

    } catch (err) {
        console.error(`❌ Erro no Job ${id}:`, err.message);
        sendLog(`❌ Erro em ${id}: ${err.message}`, 'error', 'worker');

        // Tratamento de falha silenciosa / instabilidade
        if (err.message.includes('evaluate') || err.message.includes('Execution context')) {
            console.log('⚠️ [INSTABILIDADE] Detectada instabilidade no Chromium. Cooldown de 60s...');
            sendLog('⚠️ Instabilidade no navegador. Pausando por 60s para recuperação...', 'error', 'system');
            await sleep(60000);
        }

        // Se pausado, não marca como erro definitivo no BullMQ (deixa no Redis para retry)
        if (err.message === 'SYSTEM_PAUSED' || err.message === 'WHATSAPP_NOT_READY') {
            throw err; 
        }

        // Falha auditada no banco
        await db.failJob(id, err.message);
        throw err;

    } finally {
        const running = await db.isSystemRunning();

        let delay;

        if (!running) {
            // 🔥 sistema parado → espera leve
            delay = 60000; // 1 min
            sendLog('⏸ Sistema pausado. Verificando novamente em 60s...', 'info', 'system');
        } else {
            delay = getDelay();
        }

        const delaySec = Math.round(delay / 1000);

        console.log(`⏱ Próximo job em ${delaySec}s...`);
        sendLog(`⏱ Aguardando ${delaySec}s`, 'info', 'system');

        await sleep(delay);
    }

}, {
    connection,
    concurrency: 1, // 🔒 GARANTIA DE 1 POR VEZ
    removeOnComplete: true,
    removeOnFail: false
});

worker.on('error', err => console.error('💥 Worker Fatal:', err));

socket.on('disconnect-wa', async () => {
    try {
        sendLog('🔌 Desconectando WhatsApp...', 'warning', 'system');

        // 🔒 encerra sessão corretamente
        await client.logout();
        await client.destroy();

        // 🔥 limpa sessão física
        try {
            fs.rmSync('/app/session', { recursive: true, force: true });
            sendLog('🧹 Sessão local removida', 'info', 'system');
        } catch (err) {
            console.error('Erro ao limpar sessão:', err.message);
        }

        sendLog('❌ WhatsApp desconectado com sucesso', 'success', 'system');

        // 🔁 reinicia worker para novo QR
        process.exit(0);

    } catch (err) {
        sendLog(`Erro ao desconectar: ${err.message}`, 'error', 'system');
    }
});
// =============================
// 🚀 INICIALIZAÇÃO
// =============================
client.initialize();
console.log('🚀 Worker ativo e aguardando fila (idempotente)...');