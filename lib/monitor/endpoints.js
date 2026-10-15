// Endpoints OFICIALES de la DGII para e-CF (facturación electrónica).
//
// Fuente: DGII, "Descripción Técnica de Facturación Electrónica" v1.5 (mayo 2023).
// Base por ambiente: https://ecf.dgii.gov.do/{testecf|certecf|ecf}/autenticacion
//   - Semilla (GET, solo lectura, sin certificado): .../api/autenticacion/semilla
//   - ValidarSemilla (POST, requiere certificado digital): .../api/autenticacion/validarsemilla
//   - Estatus oficial de servicios (informativo): https://statusecf.dgii.gov.do
//
// El monitor SOLO hace lecturas (GET): la obtención de semilla es de solo
// lectura, no usa certificado ni credenciales y no genera ninguna transacción
// fiscal. También comprueba la disponibilidad del subsistema oficial de estatus
// e-CF (statusecf.dgii.gov.do), igualmente por GET y sin credenciales.
//
// La configuración referencia estos endpoints por CLAVE (endpoint_key), nunca
// por URL libre, para que no se puedan apuntar comprobaciones a redes internas
// ni a destinos ajenos a la DGII.

const ENVIRONMENTS = {
  testecf: { label: 'Pruebas (TesteCF)',       base: 'https://ecf.dgii.gov.do/testecf/autenticacion' },
  certecf: { label: 'Certificación (CerteCF)', base: 'https://ecf.dgii.gov.do/certecf/autenticacion' },
  ecf:     { label: 'Producción (eCF)',        base: 'https://ecf.dgii.gov.do/ecf/autenticacion' },
};

// Endpoints oficiales adicionales de la DGII (solo lectura, sin credenciales),
// referenciados también por clave. `statusecf_subsistema` comprueba que el
// subsistema de estatus e-CF de la DGII esté en línea (sirve su definición
// pública de API por GET); no consulta el estado detallado, que requiere una
// ApiKey emitida por la DGII.
const EXTRA_ENDPOINTS = {
  statusecf_subsistema: 'https://statusecf.dgii.gov.do/api-docs/v1/definition.json',
};

// Solo estos hosts oficiales de la DGII son destinos válidos para una comprobación.
const ALLOWED_HOSTS = new Set(['ecf.dgii.gov.do', 'statusecf.dgii.gov.do']);

function semillaUrl(environmentKey) {
  const env = ENVIRONMENTS[environmentKey];
  if (!env) return null;
  return `${env.base}/api/autenticacion/semilla`;
}

// URL a comprobar a partir de la clave de endpoint guardada en la BD.
function urlForEndpointKey(endpointKey) {
  if (EXTRA_ENDPOINTS[endpointKey]) return EXTRA_ENDPOINTS[endpointKey];
  return semillaUrl(endpointKey);
}

function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

module.exports = { ENVIRONMENTS, ALLOWED_HOSTS, semillaUrl, urlForEndpointKey, isAllowedUrl };
