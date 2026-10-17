// Motor de IA para los asistentes de los módulos de Direct (NO es NALA; NALA
// mantiene su propia configuración de OpenAI intacta). Habla el formato de
// OpenAI, así que sirve con cualquier proveedor compatible. Por defecto apunta
// a OpenRouter (modelos gratis). Todo se configura por variables de entorno:
//   AI_API_KEY    — llave del proveedor (OpenRouter u otro compatible)
//   AI_BASE_URL   — base del API (por defecto OpenRouter)
//   AI_MODEL      — modelo a usar (por defecto un modelo gratis de OpenRouter)
// El servidor nunca expone la llave al navegador.

const BASE = () => (process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
// Modelo por defecto: uno gratis vigente de OpenRouter. Los IDs de modelos
// gratis rotan con el tiempo; si este se retira, define AI_MODEL en Vercel con
// uno de la lista actual (https://openrouter.ai/models?max_price=0).
const MODEL = () => process.env.AI_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';

class AIError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// messages: [{role:'system'|'user'|'assistant', content:string}]
async function chat(messages, { maxTokens = 1400, temperature = 0.3, signal } = {}) {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new AIError('La IA de los módulos no está configurada (falta AI_API_KEY).', 503);
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
      // Es un chat de ayuda: NO queremos "razonamiento". Casi todos los modelos
      // gratis de OpenRouter son de razonamiento y, con un prompt con contexto,
      // gastan todo el presupuesto de tokens pensando y devuelven el texto vacío
      // (el asistente parecía "no responder"). Desactivamos el razonamiento; los
      // modelos que no lo soporten simplemente ignoran el parámetro.
      body: JSON.stringify({
        model: MODEL(),
        temperature,
        max_tokens: maxTokens,
        reasoning: { enabled: false },
        messages,
      }),
    });
  } catch (e) {
    throw new AIError('No se pudo contactar el servicio de IA.', 502);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* noop */ }
    if (res.status === 401 || res.status === 403) throw new AIError('La llave de IA no es válida o no tiene acceso al modelo.', 502);
    if (res.status === 429) throw new AIError('El modelo gratis llegó a su límite por ahora. Intenta de nuevo en unos minutos.', 429);
    throw new AIError('El servicio de IA devolvió un error' + (detail ? `: ${detail}` : '.'), 502);
  }
  let data;
  try { data = await res.json(); } catch { throw new AIError('Respuesta de IA ilegible.', 502); }
  const msg = data?.choices?.[0]?.message || {};
  // Respaldo: si el modelo igualmente devolvió el texto en el campo de
  // razonamiento (y dejó vacío content), lo usamos para no fallar.
  let reply = typeof msg.content === 'string' ? msg.content : '';
  if (!reply.trim() && typeof msg.reasoning === 'string') reply = msg.reasoning;
  if (!reply || !reply.trim()) {
    throw new AIError('El modelo gratis no devolvió respuesta (puede estar saturado). Intenta de nuevo en un momento.', 502);
  }
  return { reply: reply.trim(), model: data.model || MODEL() };
}

module.exports = { chat, AIError };
