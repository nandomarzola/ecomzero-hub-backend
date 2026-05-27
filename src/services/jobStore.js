// Job store em memória — sem Redis, sem dependências extras.
// Jobs sobrevivem ao reload do PM2 (graceful), mas não ao crash/restart duro.
// Para um arquivo de importação, o TTL de 2 horas é mais que suficiente.

const jobs = new Map();

const TTL_MS = 2 * 60 * 60 * 1000; // 2 horas

function createJob(userId) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(id, {
    id,
    userId,
    status:    'pending',   // pending | processing | done | error
    progress:  { step: 'aguardando', current: 0, total: 0 },
    result:    null,
    error:     null,
    createdAt: Date.now(),
  });
  return id;
}

function getJob(id) {
  return jobs.get(id) ?? null;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
}

function updateProgress(id, progress) {
  const job = jobs.get(id);
  if (!job) return;
  job.progress = progress;
}

// Limpar jobs expirados a cada 30 min
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > TTL_MS) jobs.delete(id);
  }
}, 30 * 60 * 1000);

module.exports = { createJob, getJob, updateJob, updateProgress };
