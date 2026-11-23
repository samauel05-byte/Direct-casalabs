// Tasa RD$ por US$ automática para cobrar por PayPal (que no admite pesos).
// Fuente: open.er-api.com (tasa de mercado, se actualiza a diario, sin llave). Los bancos venden más caro que el mercado:
// COBROS_RATE_MARKUP_PCT (ej. 1.5) suma ese porcentaje para acercarse a la tasa de venta más alta. Siempre se redondea hacia arriba a 2 decimales.
let cache = null;
const TTL = 60 * 60 * 1000;

const withMarkup = (market, pct) => Math.ceil(market * (1 + (Number(pct) || 0) / 100) * 100) / 100;

async function getRate(fetchImpl = fetch) {
  if (cache && cache.exp > Date.now() && cache.markup === (process.env.COBROS_RATE_MARKUP_PCT || '')) return cache.value;
  let data;
  try {
    const r = await fetchImpl('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
  } catch (e) {
    const err = new Error('No se pudo obtener la tasa automática; escríbela a mano.'); err.status = 502; throw err;
  }
  const market = Number(data && data.rates && data.rates.DOP);
  if (!(market > 20 && market < 500)) { const err = new Error('La tasa automática recibida no es válida; escríbela a mano.'); err.status = 502; throw err; }
  const pct = Number(process.env.COBROS_RATE_MARKUP_PCT) || 0;
  const value = { rate: withMarkup(market, pct), market: Math.round(market * 10000) / 10000, markupPct: pct, source: 'open.er-api.com', updated: data.time_last_update_utc || null };
  cache = { value, exp: Date.now() + TTL, markup: process.env.COBROS_RATE_MARKUP_PCT || '' };
  return value;
}

module.exports = { getRate, withMarkup };
