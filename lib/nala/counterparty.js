// Auto-completado de la contraparte al leer una factura: el proveedor en 606,
// el cliente en 607. La IA a veces trae sólo el nombre, o sólo el RNC; aquí se
// rellena el que falte, sin pisar nunca un campo corregido a mano:
//   1) RNC válido pero nombre vacío → nombre oficial del padrón de la DGII.
//   2) Nombre pero RNC vacío        → RNC de una contraparte ya vista del cliente
//      (directorio nombre→RNC que arma el pipeline con el historial del cliente).
// Lógica pura y sin dependencias de base de datos, para poder probarla aislada.
const rncRegistry = require('./rnc-registry');

// Normaliza un nombre para comparar (mayúsculas, sin acentos ni puntuación):
// "A.G y S. Ferreservís" y "AGYS FERRESERVIS" quedan comparables.
const normName = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const blank = v => v === null || v === undefined || String(v).trim() === '';

async function completeCounterparty(fields, format, corrected, { directory = null, selfRncs = [] } = {}) {
  const idKey = format === '606' ? 'emisor_id' : 'receptor_id';
  const nameKey = format === '606' ? 'emisor_nombre' : 'receptor_nombre';
  const rnc = String(fields[idKey] || '').replace(/\D/g, '');
  // 1) RNC válido + nombre vacío → nombre oficial del padrón DGII (en memoria).
  if (!corrected.has(nameKey) && blank(fields[nameKey]) && (rnc.length === 9 || rnc.length === 11)) {
    try { const hit = await rncRegistry.find(rnc); if (hit?.found && hit.nombre) fields[nameKey] = hit.nombre; }
    catch { /* padrón de la DGII no disponible: se deja el nombre vacío */ }
  }
  // 2) Nombre + RNC vacío → RNC de una contraparte ya vista del mismo cliente.
  if (directory && !corrected.has(idKey) && blank(fields[idKey]) && !blank(fields[nameKey])) {
    const id = directory.get(normName(fields[nameKey]));
    if (id && !selfRncs.includes(id)) fields[idKey] = id;
  }
  return fields;
}

module.exports = { completeCounterparty, normName };
