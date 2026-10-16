// Progreso de un lote ponderado por documento (no por trabajo). El número de
// trabajos no se conoce al inicio: un PDF o un ZIP sólo se parte en sus
// sub-trabajos (un 'extract' por bloque de páginas; un documento hijo por
// archivo del ZIP) cuando corre su 'prepare'. Contar trabajos-hechos/totales
// hace que el total crezca a mitad de camino y el porcentaje retroceda. Aquí
// cada documento "hoja" (los ZIP son contenedores: cuentan sus hijos) aporta
// una fracción que sólo sube: terminado = 1; en curso = trabajos terminados /
// trabajos conocidos. El denominador (número de hojas) es estable salvo que un
// ZIP revele más archivos; esa parte la suaviza el piso de progreso del cliente.
const TERMINAL_DOC = new Set(['processed', 'failed', 'duplicate', 'unsupported', 'purged']);
const isDoneJob = s => ['succeeded', 'failed', 'cancelled'].includes(s);

function batchProgress(documents, jobList) {
  const docs = documents || [];
  const jobs = jobList || [];
  const done = jobs.filter(j => isDoneJob(j.status)).length;
  const leaves = docs.filter(x => x.kind !== 'zip');
  let fracSum = 0;
  for (const doc of leaves) {
    if (TERMINAL_DOC.has(doc.status)) { fracSum += 1; continue; }
    const dj = jobs.filter(j => j.document_id === doc.id);
    fracSum += dj.length ? dj.filter(j => isDoneJob(j.status)).length / dj.length : 0;
  }
  const percent = leaves.length ? Math.round((fracSum / leaves.length) * 100)
    : (jobs.length && done === jobs.length ? 100 : 0);
  return {
    jobs_total: jobs.length, jobs_done: done,
    jobs_failed: jobs.filter(j => j.status === 'failed').length,
    jobs_running: jobs.filter(j => j.status === 'running').length,
    jobs_queued: jobs.filter(j => j.status === 'queued').length,
    docs_total: leaves.length, docs_done: leaves.filter(x => TERMINAL_DOC.has(x.status)).length,
    percent,
  };
}

module.exports = { batchProgress };
