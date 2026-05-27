const connection = {
  host:     process.env.REDIS_HOST     || '127.0.0.1',
  port:     parseInt(process.env.REDIS_PORT  || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  // TLS obrigatório no Upstash e outros serviços gerenciados
  ...(process.env.REDIS_TLS === 'true' ? { tls: {} } : {}),
};

module.exports = connection;
