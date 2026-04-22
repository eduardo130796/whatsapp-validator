const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { randomUUID } = require('crypto');
const db = require('./db');
const { queue } = require('./queue');

const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" }
});

const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('public'));

// =============================
// 🔄 RECOVERY (DB → FILA)
// =============================
const DAILY_LIMIT = 250;

async function recoverQueue() {
    try {
        // =============================
        // 📊 USO ATUAL (ÚNICA CONSULTA)
        // =============================
        const usage = await db.getTodayUsage();
        const running = await db.isSystemRunning();

        // =============================
        // 🚫 LIMITE ATINGIDO → BLOQUEIO TOTAL
        // =============================
        if (usage.used >= usage.limit) {
            if (running) {
                console.log('🚫 Limite diário atingido - pausando sistema');

                await db.setSystemRunning(false);
                await queue.pause();

                io.emit('log', {
                    message: '🚫 Limite diário atingido - sistema pausado',
                    level: 'warning',
                    type: 'system',
                    timestamp: new Date()
                });
            }

            // 🔥 IMPORTANTE: para TUDO aqui
            return;
        }

        // =============================
        // 🌅 NOVO DIA → RETOMA AUTOMÁTICA
        // =============================
        const reason = await db.getPauseReason();

        if (!running && reason === 'limit') {
            console.log('🌅 Novo dia detectado - retomando automático (limite)');

            await db.setSystemRunning(true);
            await db.setPauseReason(null);
            await queue.resume();

            io.emit('log', {
                message: '🌅 Novo dia iniciado - retomando automaticamente',
                level: 'success',
                type: 'system',
                timestamp: new Date()
            });
        } else if (!running && reason === 'manual') {
            console.log('⏸ Sistema pausado manualmente - aguardando usuário');
        }

        // =============================
        // 🔄 EVITA DUPLICAÇÃO DE FILA
        // =============================
        const counts = await queue.getJobCounts();

        if (counts.waiting > 0 || counts.active > 0) {
            return;
        }

        // =============================
        // 📦 BUSCA PENDENTES
        // =============================
        console.log('🔄 [WATCHDOG] Sincronizando DB → fila...');

        const result = await db.query(
            "SELECT id FROM numbers WHERE status = 'pending' LIMIT 50"
        );

        if (result.rows.length === 0) return;

        // =============================
        // 🚀 ENFILEIRAMENTO
        // =============================
        let count = 0;

        for (const row of result.rows) {
            await queue.add(
                'validate',
                { id: row.id },
                {
                    jobId: `number-${row.id}`,
                    attempts: 5,
                    backoff: { type: 'exponential', delay: 5000 },

                    // 🔥 controle de memória otimizado
                    removeOnComplete: {
                        age: 3600,
                        count: 1000
                    },
                    removeOnFail: {
                        age: 86400,
                        count: 5000
                    }
                }
            );

            count++;
        }

        if (count > 0) {
            console.log(`✅ ${count} jobs reenfileirados`);
        }

    } catch (err) {
        console.error('❌ recoverQueue erro:', err.message);
    }
}
// =============================
// 🚀 STARTUP
// =============================
(async () => {
    await db.initDB();
    await db.resetProcessingJobs(); // 🔥 destrava travados
    
    // 🔥 SINCRONIA INICIAL PAUSED/RUNNING
    const running = await db.isSystemRunning();
    if (!running) {
        console.log('⏸ [STARTUP] Sistema offline - Pausando fila');
        await queue.pause();
    } else {
        console.log('▶️ [STARTUP] Sistema online - Liberando fila');
        await queue.resume();
    }

    await recoverQueue();

    // 🔥 watchdog
    setInterval(recoverQueue, 10 * 60 * 1000);
})();

// =============================
// 🔥 ESTADO GLOBAL
// =============================
let currentStatus = 'disconnected';
let currentQR = null;

// =============================
// 🔌 SOCKET
// =============================
io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado:', socket.id);

    socket.emit('status', currentStatus);

    if (currentQR) {
        socket.emit('qr', currentQR);
    }

    socket.on('qr', (data) => {
        currentQR = data;
        io.emit('qr', data);
    });

    socket.on('status', (data) => {
        currentStatus = data;

        // 🔥 EMITE STATUS PARA TODOS OS CLIENTES
        io.emit('status', data);

        if (data === 'connected') {
            io.emit('log', {
                message: '✅ WhatsApp conectado e pronto',
                level: 'success',
                type: 'system',
                timestamp: new Date()
            });
        }

        if (data === 'disconnected') {
            io.emit('log', {
                message: '❌ WhatsApp desconectado',
                level: 'error',
                type: 'system',
                timestamp: new Date()
            });
        }
    });

    socket.on('progress', (data) => {
        io.emit('progress', data);
    });

    // 🔥 Streaming de logs em tempo real
    socket.on('worker-log', (log) => {
        io.emit('log', log);
    });
});

// =============================
// 📤 UPLOAD
// =============================
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const lines = fs.readFileSync(req.file.path, 'utf-8').split('\n');

        console.log(`📤 [UPLOAD] Iniciando carga`);

        const batchSize = 1000;

        for (let i = 1; i < lines.length; i += batchSize) {
            const chunk = lines.slice(i, i + batchSize);

            const values = [];
            const placeholders = [];

            chunk.forEach((line) => {
                const cleaned = line.trim();
                if (!cleaned) return;

                const [file_id, lead_id, number] = cleaned.split(',');

                if (!number) return;

                const base = values.length;

                values.push(number, lead_id, file_id);

                placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, 'pending')`);
            });

            if (values.length === 0) continue;

            await db.query(`
                INSERT INTO numbers (number, lead_id, file_id, status)
                VALUES ${placeholders.join(',')}
                ON CONFLICT (number, file_id) DO NOTHING
            `, values);
        }

        // pega file_id do CSV (primeira linha de dados)
        const fileId = lines[1]?.split(',')[0];

        res.json({ message: "Upload concluído", file_id: fileId });

    } catch (err) {
        console.error('❌ upload erro:', err.message);
        res.status(500).json({ error: "Erro no upload" });
    }
});

// =============================
// 📊 STATS
// =============================
app.get('/stats', async (req, res) => {
    try {
        const stats = await db.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status='done') as done,
                COUNT(*) FILTER (WHERE status='pending') as pending,
                COUNT(*) FILTER (WHERE status='processing') as processing,
                COUNT(*) FILTER (WHERE valid=true) as valid,
                COUNT(*) FILTER (WHERE valid=false) as invalid
            FROM numbers
        `);

        res.json(stats.rows[0]);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =============================
// 🔄 RESET
// =============================
app.post('/reset', async (req, res) => {
    await db.query("TRUNCATE numbers RESTART IDENTITY");
    await queue.drain();
    res.json({ message: "Base resetada" });
});

// =============================
// 📥 EXPORT
// =============================
app.get('/export', async (req, res) => {
    const result = await db.query(
        "SELECT number FROM numbers WHERE valid=true"
    );

    const csv = result.rows.map(r => r.number).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.send(csv);
});

// =============================
// 📊 DAILY
// =============================
app.get('/daily', async (req, res) => {
    const usage = await db.getTodayUsage();
    res.json(usage);
});

// =============================
// 🎮 CONTROLE
// =============================
app.post('/start', async (req, res) => {
    const { fileId } = req.body;

    await db.setSystemRunning(true);
    await db.setPauseReason(null);
    await queue.resume();

    if (fileId) {
        console.log(`▶️ [START] Iniciando processamento do lote: ${fileId}`);
        
        // Busca os números pendentes para este arquivo e enfileira
        const result = await db.query(
            "SELECT id FROM numbers WHERE file_id = $1 AND status = 'pending'",
            [fileId]
        );

        for (const row of result.rows) {
            await queue.add('validate', { id: row.id }, {
                jobId: `number-${row.id}`,
                attempts: 5,
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: true,
                removeOnFail: false
            });
        }
    }

    console.log('▶️ [CONTROL] Sistema ATIVO');

    // 🔥 EMITE LOG PARA O FRONTEND
    io.emit('log', {
        message: '▶️ Sistema ATIVO',
        level: 'success',
        type: 'system',
        timestamp: new Date()
    });

    res.json({ status: 'started' });
    });

app.post('/stop', async (req, res) => {
    await db.setSystemRunning(false);
    await db.setPauseReason('limit');
    await db.setPauseReason('manual');
    await queue.pause();
    console.log('⏸ [CONTROL] Sistema PARADO');

    // 🔥 EMITE LOG PARA O FRONTEND
    io.emit('log', {
        message: '⏸ Sistema PARADO',
        level: 'warning',
        type: 'system',
        timestamp: new Date()
    });

    res.json({ status: 'stopped' });
});

app.get('/status', async (req, res) => {
    const running = await db.isSystemRunning();

    res.json({ 
        running,
        whatsapp: currentStatus === 'connected'
    });
});

// =============================
// 🔁 REQUEUE MANUAL
// =============================
app.post('/requeue', async (req, res) => {
    await recoverQueue();
    res.json({ message: 'Reenfileirado' });
});
// =============================
// 📊 QUEUE STATS (MONITORAMENTO)
// =============================
app.get('/queue-stats', async (req, res) => {
    try {
        const counts = await queue.getJobCounts();

        res.json({
            waiting: counts.waiting || 0,
            active: counts.active || 0,
            completed: counts.completed || 0,
            failed: counts.failed || 0
        });

    } catch (err) {
        console.error('Erro queue-stats:', err.message);
        res.status(500).json({ error: 'Erro ao obter stats da fila' });
    }
});

// =============================
server.listen(3000, () => {
    console.log('🚀 Dashboard: http://localhost:3000');
});