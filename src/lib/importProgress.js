// Progresso em memória — sem Redis, sem BullMQ
// jobId (Import.id) → { pct, message }
const importProgress = new Map();

module.exports = { importProgress };
