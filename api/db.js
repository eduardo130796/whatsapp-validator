const { Pool } = require('pg');

// =============================
// 🔌 CONEXÃO
// =============================
const pool = new Pool({
  host: 'postgres',
  user: 'validator',
  password: 'validator',
  database: 'validator',
  port: 5432,
});

// =============================
// 🔹 QUERY PADRÃO
// =============================
async function query(text, params) {
  return pool.query(text, params);
}

// =============================
// 🚀 INIT DB
// =============================
async function initDB() {
  let connected = false;

  while (!connected) {
    try {
      await pool.query('SELECT 1');
      connected = true;
      console.log('✅ Conectado ao banco');
    } catch (err) {
      console.log('⏳ Aguardando banco...');
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // =============================
  // 📦 TABELA PRINCIPAL
  // =============================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS numbers (
        id SERIAL PRIMARY KEY,
        number TEXT,
        lead_id UUID,
        file_id UUID,
        status TEXT DEFAULT 'pending',
        valid BOOLEAN,
        last_checked TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        last_error TEXT,

        UNIQUE (number, file_id)
        );
  `);

  // índice crítico para performance
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_numbers_status 
    ON numbers(status);
  `);

  // =============================
  // 📊 CONTROLE DIÁRIO
  // =============================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_usage (
      date DATE PRIMARY KEY,
      count INTEGER DEFAULT 0
    );
  `);

  // garante linha do dia
  await pool.query(`
    INSERT INTO daily_usage (date, count)
    VALUES (CURRENT_DATE, 0)
    ON CONFLICT (date) DO NOTHING;
  `);

  // limpeza automática (últimos 7 dias)
  await pool.query(`
    DELETE FROM daily_usage 
    WHERE date < CURRENT_DATE - INTERVAL '7 days'
  `);

  // =============================
  // ⚙️ CONTROLE START/STOP
  // =============================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_control (
      id INTEGER PRIMARY KEY,
      is_running BOOLEAN DEFAULT false,
      pause_reason TEXT DEFAULT 'manual'
    );
  `);

  await pool.query(`
    INSERT INTO system_control (id, is_running, pause_reason)
    VALUES (1, false, 'manual')
    ON CONFLICT (id) DO NOTHING;
  `);

  await pool.query(`
    UPDATE system_control
    SET pause_reason = 'manual'
    WHERE pause_reason IS NULL;
  `);
  console.log('✅ Banco inicializado');
}

// =============================
// 📊 USO DIÁRIO (PADRÃO ÚNICO)
// =============================
async function getTodayUsage() {
  const res = await pool.query(`
    SELECT count 
    FROM daily_usage 
    WHERE date = CURRENT_DATE
  `);

  return {
    used: res.rows[0]?.count || 0,
    limit: 250
  };
}

// =============================
// 🔥 INCREMENTO SEGURO
// =============================
async function incrementUsage() {
  await pool.query(`
    INSERT INTO daily_usage (date, count)
    VALUES (CURRENT_DATE, 1)
    ON CONFLICT (date)
    DO UPDATE SET count = daily_usage.count + 1
  `);
}

// =============================
// ⚙️ CONTROLE SISTEMA
// =============================
async function isSystemRunning() {
  const res = await pool.query(
    "SELECT is_running FROM system_control WHERE id = 1"
  );

  return res.rows[0]?.is_running || false;
}

async function setSystemRunning(value) {
  await pool.query(
    "UPDATE system_control SET is_running=$1 WHERE id=1",
    [value]
  );
}

// =============================
// 🔥 CLAIM ATÔMICO
// =============================
async function claimJob(id) {
  const res = await pool.query(`
    UPDATE numbers 
    SET status = 'processing' 
    WHERE id = $1 AND status = 'pending' 
    RETURNING *
  `, [id]);

  return res.rows[0];
}

// =============================
// ✅ FINALIZA JOB
// =============================
async function finalizeJob(id, valid) {
  return pool.query(`
    UPDATE numbers 
    SET status = 'done',
        valid = $2,
        last_checked = NOW(),
        last_error = NULL
    WHERE id = $1
  `, [id, valid]);
}

// =============================
// ❌ FALHA CONTROLADA
// =============================
async function failJob(id, error) {
  return pool.query(`
    UPDATE numbers 
    SET status = 'pending',
        last_error = $2,
        last_checked = NOW()
    WHERE id = $1
  `, [id, error]);
}

// =============================
// 🔄 RECOVERY STARTUP
// =============================
async function resetProcessingJobs() {
  return pool.query(`
    UPDATE numbers 
    SET status = 'pending' 
    WHERE status = 'processing'
  `);
}

async function setPauseReason(reason) {
  await pool.query(
    "UPDATE system_control SET pause_reason=$1 WHERE id=1",
    [reason]
  );
}

async function getPauseReason() {
  const res = await pool.query(
    "SELECT pause_reason FROM system_control WHERE id=1"
  );
  return res.rows[0]?.pause_reason;
}
// =============================
// 📦 EXPORT
// =============================
module.exports = {
  query,
  initDB,
  getTodayUsage,
  incrementUsage,
  isSystemRunning,
  setSystemRunning,
  claimJob,
  finalizeJob,
  failJob,
  resetProcessingJobs,
  setPauseReason,
  getPauseReason
};