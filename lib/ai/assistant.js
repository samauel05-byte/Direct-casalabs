// Motor de IA para los asistentes de los módulos de Direct (NO es NALA; NALA
// mantiene su propia configuración de OpenAI intacta). Habla el formato de
// OpenAI, así que sirve con cualquier proveedor compatible. Por defecto apunta
// a OpenRouter (modelos gratis). Todo se configura por variables de entorno:
//   AI_API_KEY    — llave del proveedor (OpenRouter u otro compatible)
//   AI_BASE_URL   — base del API (por defecto OpenRouter)
//   AI_MODEL      — fuerza UN modelo concreto (si no, se usa la cadena por defecto)
// El servidor nunca expone la llave al navegador.

const BASE = () => (process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

// Cadena de modelos gratis de OpenRouter. Se prueban EN ORDEN hasta que uno
// devuelva texto. Motivo: muchos modelos gratis son "de razonamiento" y, con un
// prompt con contexto, se quedan sin presupuesto de tokens pensando y devuelven
// el contenido vacío (el asistente parecía "no responder"). Empezamos por un
// modelo de instrucción (no razonador) que responde directo. Gemma es de pesos
// abiertos de Google — NO es el API de Gemini. Si prefieres otro, define AI_MODEL
// en Vercel con uno de la lista actual (https://openrouter.ai/models?max_price=0).
const DEFAULT_MODELS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'google/gemma-4-26b-a4b-it:free',
];
function modelList() {
  const forced = (process.env.AI_MODEL || '').trim();
  return forced ? [forced] : DEFAULT_MODELS;
}

class AIError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// Llama a UN modelo. Devuelve { reply, model } si responde con texto, o
// { error, retry } si falla (retry=true indica que vale la pena probar otro
// modelo; retry=false es un fallo definitivo como llave inválida).
async function callOne(model, messages, { maxTokens, temperature, signal }, apiKey) {
  let res;
  try {
    res = await fetch(BASE() + '/chat/completions', {
      method: 'POST', signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter recomienda estos encabezados (opcionales); ayudan en el tier gratis.
        'HTTP-Referer': 'https://app.casalabs.com.do',
        'X-Title': 'Direct · Casa Labs',
      },
      // Es un chat de ayuda: desactivamos el "razonamiento" para que el modelo
      // no gaste el presupuesto de tokens pensando. Los modelos que no lo
      // soporten simplemente ignoran el parámetro.
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        reasoning: { enabled: false },
        messages,
      }),
    });
  } catch (e) {
    return { error: new AIError('No se pudo contactar el servicio de IA.', 502), retry: true };
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* noop */ }
    if (res.status === 401 || res.status === 403) {
      return { error: new AIError('La llave de IA no es válida o no tiene acceso al modelo.', 502), retry: false };
    }
    if (res.status === 429) {
      return { error: new AIError('Límite temporal del modelo gratis.', 429), retry: true, detail };
    }
    return { error: new AIError('El servicio de IA devolvió un error' + (detail ? `: ${detail}` : '.'), 502), retry: true, detail };
  }
  let data;
  try { data = await res.json(); } catch { return { error: new AIError('Respuesta de IA ilegible.', 502), retry: true }; }
  const choice = data?.choices?.[0] || {};
  const msg = choice.message || {};
  // Respaldo: si dejó content vacío pero puso el texto en el campo de
  // razonamiento, lo usamos para no fallar.
  let reply = typeof msg.content === 'string' ? msg.content : '';
  if (!reply.trim() && typeof msg.reasoning === 'string') reply = msg.reasoning;
  if (reply && reply.trim()) return { reply: reply.trim(), model: data.model || model };
  // 200 OK pero sin texto (típico de modelos de razonamiento que agotan tokens).
  return { error: new AIError(`El modelo no devolvió texto (finish=${choice.finish_reason || '?'}).`, 502), retry: true, empty: true };
}

// messages: [{role:'system'|'user'|'assistant', content:string}]
async function chat(messages, { maxTokens = 1400, temperature = 0.3, signal } = {}) {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new AIError('La IA de los módulos no está configurada (falta AI_API_KEY).', 503);
  let last = null;
  for (const model of modelList()) {
    const r = await callOne(model, messages, { maxTokens, temperature, signal }, apiKey);
    if (r.reply) return { reply: r.reply, model: r.model };
    last = r;
    if (!r.retry) break; // fallo definitivo (p. ej. llave inválida): no insistas
  }
  // Ningún modelo respondió.
  if (last && last.error && last.retry === false) throw last.error;
  throw new AIError(
    'El asistente no pudo responder ahora mismo (los modelos gratis están saturados o no devolvieron texto). ' +
    'Intenta de nuevo en un momento; si persiste, define AI_MODEL en Vercel con un modelo que funcione.',
    (last && last.error && last.error.status) || 502,
  );
}

module.exports = { chat, AIError };
