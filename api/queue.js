const { Queue } = require('bullmq');
const IORedis = require('ioredis');

// =============================
// 🔌 REDIS (OTIMIZADO)
// =============================
const connection = new IORedis({
  host: 'redis',
  port: 6379,

  maxRetriesPerRequest: null,
  enableReadyCheck: false,

  // 🔥 evita reconexões agressivas
  retryStrategy: (times) => {
    return Math.min(times * 1000, 10000); // até 10s
  },

  // 🔥 mantém conexão estável
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    return err.message.includes(targetError);
  }
});

connection.on('connect', () => {
  console.log('✅ Redis conectado');
});

connection.on('error', (err) => {
  console.error('❌ Redis erro:', err.message);
});

// =============================
// 🚀 QUEUE (OTIMIZADA)
// =============================
const queue = new Queue('validate', {
  connection,

  defaultJobOptions: {
    removeOnComplete: {
      age: 60 * 60, // 1h
      count: 1000
    },

    removeOnFail: {
      age: 24 * 60 * 60, // 24h
      count: 5000
    }
  }
});

module.exports = {
  queue,
  connection
};