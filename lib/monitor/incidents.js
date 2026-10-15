// Lógica pura (sin BD) para decidir incidentes y calcular métricas. Se prueba
// con datos controlados.

// Cuenta cuántos elementos del inicio del arreglo cumplen la condición.
function countLeading(arr, pred) {
  let n = 0;
  for (const x of arr) { if (pred(x)) n++; else break; }
  return n;
}

// Decide la transición de incidente a partir de los resultados recientes
// (más nuevos primero) y si hay un incidente abierto.
//  - Abre tras `failThreshold` fallos consecutivos.
//  - Cierra tras `recoverThreshold` respuestas válidas consecutivas.
function decideIncident(recentDesc, hasOpen, failThreshold, recoverThreshold) {
  const fails = countLeading(recentDesc, r => !r.ok);
  const oks = countLeading(recentDesc, r => r.ok);
  if (!hasOpen && fails >= failThreshold) return 'open';
  if (hasOpen && oks >= recoverThreshold) return 'resolve';
  return 'none';
}

// Disponibilidad observada = válidas / ejecutadas × 100 (null si no hay datos).
function availability(runCount, okCount) {
  if (!runCount) return null;
  return Math.round((okCount / runCount) * 10000) / 100;
}

// Cobertura del monitoreo = ejecutadas / esperadas × 100 (acotada a 100).
// `expected` se calcula con el período activo (desde la puesta en marcha).
function coverage(runCount, expected) {
  if (!expected || expected <= 0) return null;
  return Math.min(100, Math.round((runCount / expected) * 10000) / 100);
}

// Cuántas comprobaciones se esperaban en una ventana [from,to] con un intervalo,
// considerando que el monitoreo empezó en `startedAt` (no cuenta antes de eso).
function expectedRuns(fromMs, toMs, startedAtMs, intervalS) {
  const start = Math.max(fromMs, startedAtMs || fromMs);
  const activeMs = Math.max(0, toMs - start);
  if (!intervalS || intervalS <= 0) return 0;
  return Math.floor(activeMs / (intervalS * 1000));
}

module.exports = { countLeading, decideIncident, availability, coverage, expectedRuns };
