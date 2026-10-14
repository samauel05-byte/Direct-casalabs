// Endpoints OFICIALES de la DGII para e-CF (facturación electrónica).
//
// Fuente: DGII, "Descripción Técnica de Facturación Electrónica" v1.5 (mayo 2023).
// Base por ambiente: https://ecf.dgii.gov.do/{testecf|certecf|ecf}/autenticacion
//   - Semilla (GET, solo lectura, sin certificado): .../api/autenticacion/semilla
//   - ValidarSemilla (POST, requiere certificado digital): .../api/autenticacion/validarsemilla
//   - Estatus oficial de servicios (informativo): https://statusecf.dgii.gov.do
//
// El monitor SOLO comprueba la obtención de semilla (GET): es de solo lectura,
// no usa certificado ni credenciales y no genera ninguna transacción fiscal.
//
// La configuración referencia estos endpoints por CLAVE (endpoint_key), nunca
// por URL libre, para que no se puedan apuntar comprobaciones a redes internas
// ni a destinos ajenos a la DGII.

const ENVIRONMENTS = {
  testecf: { label: 'Pruebas (TesteCF)',       base: 'https://ecf.dgii.gov.do/testecf/autenticacion' },
  certecf: { label: 'Certificación (CerteCF)', base: 'https://ecf.dgii.gov.do/certecf/autenticacion' },
  ecf:     { label: 'Producción (eCF)',        base: 'https://ecf.dgii.gov.do/ecf/autenticacion' },
};

// Solo este host oficial es un destino válido para una comprobación.
const ALLOWED_HOSTS = new Set(['ecf.dgii.gov.do']);

function semillaUrl(environmentKey) {
  const env = ENVIRONMENTS[environmentKey];
  if (!env) return null;
  return `${env.base}/api/autenticacion/semilla`;
}

// URL a comprobar a partir de la clave de endpoint guardada en la BD.
function urlForEndpointKey(endpointKey) {
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
