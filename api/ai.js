// Asistentes de IA de los módulos de Direct (NO NALA). Autenticado con la
// sesión de Direct. Arma la "personalidad" del asistente en el servidor según
// el módulo; el cliente nunca define el rol ni ve la llave del proveedor.
const { authenticate } = require('../lib/auth');
const { chat, AIError } = require('../lib/ai/assistant');

const BASE_RULES =
  'Responde SIEMPRE en español, claro y conciso. Eres una ayuda, no un sustituto del ' +
  'criterio de un contador ni de la DGII/TSS: cuando algo dependa de la ley, del caso ' +
  'particular o de cifras oficiales, dilo y sugiere verificar con la DGII o un profesional. ' +
  'No inventes montos, NCF ni RNC. Nunca pidas, muestres ni manejes contraseñas ni credenciales. ' +
  'Si la pregunta se sale de tu tema, dilo con amabilidad.';

const PERSONAS = {
  accesos:
    'Eres el asistente de Direct (Casa Labs), una plataforma dominicana que reúne los ' +
    'portales fiscales (DGII, TSS, Ministerio de Trabajo, SISALRIL, Cámara de Comercio, etc.). ' +
    'Guías al usuario sobre qué portal usar para cada trámite y los pasos generales en RD.',
  nomina:
    'Eres un asistente de nómina para la República Dominicana. Explicas cálculos de sueldo, ' +
    'aportes a la TSS (AFP/SFS), ISR sobre asalariados (escala anual) e INFOTEP, y respondes ' +
    'preguntas sobre la nómina del usuario con los datos que se te den como contexto.',
  contable:
    'Eres un asistente contable-tributario para la República Dominicana. Dominas los formatos ' +
    'de la DGII (606 de compras, 607 de ventas, IT-1 de ITBIS e IR-2 de renta de personas ' +
    'jurídicas): explicas qué va en cada casilla, cómo se concilian y qué revisar antes de declarar.',
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    const route = String(req.query?.route || '').replace(/^\/+|\/+$/g, '');
    if (route !== 'chat') return res.status(404).json({ error: 'Ruta no encontrada' });

    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'No autorizado' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const persona = PERSONAS[body.module] || PERSONAS.accesos;
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const history = msgs
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-10)
      .map(m => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
    if (!history.length || history[history.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Falta la pregunta.' });
    }
    const context = typeof body.context === 'string' ? body.context.slice(0, 4000) : '';
    const system = `${persona}\n\n${BASE_RULES}` +
      (context ? `\n\nContexto del módulo (datos del propio usuario; úsalo si ayuda, no lo repitas entero):\n${context}` : '');

    const { reply, model } = await chat([{ role: 'system', content: system }, ...history], { maxTokens: 900 });
    return res.json({ ok: true, reply, model });
  } catch (e) {
    if (e instanceof AIError) return res.status(e.status).json({ error: e.message });
    console.error('[ai]', e);
    return res.status(500).json({ error: 'Error interno de IA.' });
  }
};
