// Estados Financieros — reglas del módulo: modalidades, permisos, flujo de estados y plantillas de carga.
// Todo lo que Contabilidad todavía no definió queda MARCADO como pendiente (`confirmed: false`) y es
// configurable; el módulo no inventa cifras ni fórmulas.

const MODALITIES = {
  proyectado: { label: 'Proyectados', singular: 'Proyectado', edit: 'proyectados_edit', kind: 'assumptions',
    blurb: 'Información financiera para períodos futuros, a partir de supuestos y valores estimados que entrega el usuario.' },
  interino: { label: 'Interinos', singular: 'Interino', edit: 'interinos_load', kind: 'entries',
    blurb: 'Información real hasta una fecha de corte o durante un período menor al año.' },
  anual: { label: 'Del año', singular: 'Del año', edit: 'anual_prepare', kind: 'entries',
    blurb: 'Informe de un año fiscal terminado, con la información real del período y los ajustes de cierre.' },
};

const PERMISSIONS = ['view', 'proyectados_edit', 'interinos_load', 'anual_prepare', 'review', 'approve', 'close_reopen', 'templates_manage', 'team_manage'];
const PERMISSION_LABELS = {
  view: 'Ver informes', proyectados_edit: 'Crear o editar proyectados', interinos_load: 'Cargar información interina',
  anual_prepare: 'Preparar informes del año', review: 'Revisar y observar', approve: 'Aprobar', close_reopen: 'Cerrar o reabrir',
  templates_manage: 'Administrar plantillas y configuración', team_manage: 'Administrar el equipo y sus permisos',
};
const PREPARE = ['view', 'proyectados_edit', 'interinos_load', 'anual_prepare'];
const ROLE_PERMISSIONS = {
  lectura: ['view'],
  preparador: PREPARE,
  revisor: [...PREPARE, 'review'],
  aprobador: [...PREPARE, 'review', 'approve'],
  contador: [...PREPARE, 'review', 'approve', 'close_reopen', 'templates_manage'],
};
const ROLE_LABELS = { admin: 'Administrador', lectura: 'Solo lectura', preparador: 'Preparador', revisor: 'Revisor', aprobador: 'Aprobador', contador: 'Contador (jefe de área)' };
// Permisos que un override por persona nunca puede otorgar (solo el administrador de Direct los tiene).
const NO_OVERRIDE = ['team_manage'];

function permissionsFor(role, overrides = {}) {
  const set = new Set(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.lectura);
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!PERMISSIONS.includes(key) || NO_OVERRIDE.includes(key)) continue;
    if (value === true) set.add(key); else if (value === false) set.delete(key);
  }
  set.add('view');
  return set;
}

// ── Flujo de estados ───────────────────────────────────────────────────────
// Los estados se pueden renombrar y activar/desactivar desde la configuración. Las transiciones
// (quién puede pasar de cuál a cuál) son fijas para que el historial sea confiable.
const STATE_DEFS = {
  borrador: 'Borrador', pendiente_cierre: 'Pendiente de cierre', en_revision: 'En revisión', observado: 'Observado',
  aprobado: 'Aprobado', cerrado: 'Cerrado', pendiente_legalizacion: 'Pendiente de legalización',
};
const DEFAULT_STATES = {
  proyectado: ['borrador', 'en_revision', 'observado', 'aprobado', 'cerrado'],
  interino: ['borrador', 'en_revision', 'observado', 'aprobado', 'cerrado'],
  anual: ['pendiente_cierre', 'en_revision', 'observado', 'aprobado', 'cerrado'],
};
const INITIAL_STATE = { proyectado: 'borrador', interino: 'borrador', anual: 'pendiente_cierre' };
// Estados que pueden estar apagados hasta que Contabilidad confirme que aplican.
const OPTIONAL_STATES = ['pendiente_legalizacion'];
// Estados en los que el contenido queda bloqueado (hay que reabrir para modificarlo).
const LOCKED = ['aprobado', 'cerrado', 'pendiente_legalizacion'];
// Estados que exigen que el informe NO tenga pendientes bloqueantes.
const NEEDS_COMPLETE = ['aprobado', 'cerrado', 'pendiente_legalizacion'];

// transición: [desde, hacia, permiso requerido]. «edit» = el permiso de preparar de esa modalidad.
function transitionsFor(modality, enabled) {
  const start = INITIAL_STATE[modality];
  const on = k => enabled.includes(k);
  const t = [];
  const add = (from, to, perm, extra = {}) => { if (on(from) && on(to)) t.push({ from, to, perm, ...extra }); };
  add(start, 'en_revision', 'edit');
  add('observado', 'en_revision', 'edit');
  add('observado', start, 'edit');
  add('en_revision', 'observado', 'review', { reason: true });
  add('en_revision', 'aprobado', 'approve');
  add('aprobado', 'cerrado', 'close_reopen');
  add('cerrado', 'pendiente_legalizacion', 'close_reopen');
  add('pendiente_legalizacion', 'cerrado', 'close_reopen');
  // Reapertura: de un estado bloqueado vuelve a «observado» (o al inicial si «observado» está apagado), con motivo.
  const reopenTo = on('observado') ? 'observado' : start;
  for (const from of LOCKED) if (on(from)) t.push({ from, to: reopenTo, perm: 'close_reopen', reason: true, reopen: true });
  return t;
}

const DEFAULT_CONFIG = {
  // Lista de estados activos por modalidad y sus nombres. «pendiente_legalizacion» queda apagado.
  states: DEFAULT_STATES,
  labels: STATE_DEFS,
  legalizacion: { enabled: false, notes: '' }, // proceso por definir por Contabilidad
  // Regla de cuadre de débitos y créditos: por_asiento | global | ninguna. Es PROVISIONAL hasta que Contabilidad la confirme.
  balance_rule: 'por_asiento', balance_tolerance: 0.01, balance_rule_confirmed: false,
  compare_enabled: false, // las comparaciones se habilitan solo cuando Contabilidad las solicita
  // Documentos que forman parte de cada modalidad (balance, resultados, flujos…): los define Contabilidad.
  documents: { proyectado: [], interino: [], anual: [] },
  // Datos de la firma para la portada, el informe del contador y el pie de cada página del paquete (los define Contabilidad).
  firm: { name: '', logo: '', address: '', phones: '', signer: { name: '', title: '', exequatur: '', icpard: '', city: '' }, informe_text: '' },
};

// Texto base del informe del contador (editable por la firma). Variables: {EMPRESA} {RNC} {DESDE} {HASTA} {ANIO} {TIPO} {TIPOS}.
const DEFAULT_INFORME = 'El presente documento contiene el Informe Financiero {TIPO} que se compone del Estado de Situación Financiera, el Estado de Resultado y Flujo de Efectivo, de la sociedad comercial {EMPRESA}, con RNC No. {RNC} comprendido del {DESDE} al {HASTA}, de acuerdo con las Normas Internacionales de Información Financiera (NIIF´s), adoptadas por el Instituto de Contadores Públicos Autorizados de República Dominicana (ICPARD). Los presentes Estados Financieros son responsabilidad de la administración; nuestra responsabilidad es expresar una opinión sobre éstos, basados en la evaluación realizada.\n\nConcluimos que los Estados Financieros {TIPOS} de {EMPRESA}, que hacen parte integral de este informe presentan resultados razonables en todos sus aspectos importantes, así como la posible posición financiera y los resultados de sus operaciones del periodo terminado en fecha {HASTA} de conformidad con los principios de contabilidad generalmente aceptados.';
const LOGO_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

function mergeConfig(stored) {
  const c = stored && typeof stored === 'object' ? stored : {};
  const states = {};
  for (const m of Object.keys(MODALITIES)) {
    const list = Array.isArray(c.states?.[m]) ? c.states[m].filter(k => STATE_DEFS[k]) : DEFAULT_STATES[m];
    const base = DEFAULT_STATES[m];
    // Los estados esenciales no se pueden apagar; el de legalización sí es opcional.
    states[m] = [...new Set([...base.filter(k => !OPTIONAL_STATES.includes(k)), ...list.filter(k => OPTIONAL_STATES.includes(k) && (c.legalizacion?.enabled === true))])]
      .sort((a, b) => order(m).indexOf(a) - order(m).indexOf(b));
  }
  const labels = { ...STATE_DEFS };
  for (const [k, v] of Object.entries(c.labels || {})) if (STATE_DEFS[k] && typeof v === 'string' && v.trim()) labels[k] = v.trim().slice(0, 60);
  const rule = ['por_asiento', 'global', 'ninguna'].includes(c.balance_rule) ? c.balance_rule : DEFAULT_CONFIG.balance_rule;
  const tol = Number(c.balance_tolerance);
  const docs = {};
  for (const m of Object.keys(MODALITIES)) {
    docs[m] = (Array.isArray(c.documents?.[m]) ? c.documents[m] : []).map(d => ({ key: String(d.key || '').slice(0, 40), label: String(d.label || '').trim().slice(0, 120), required: d.required !== false }))
      .filter(d => d.key && d.label).slice(0, 30);
  }
  const f = c.firm && typeof c.firm === 'object' ? c.firm : {};
  const t = (v, n) => String(v ?? '').trim().slice(0, n);
  const sg = f.signer && typeof f.signer === 'object' ? f.signer : {};
  const firm = { name: t(f.name, 120), logo: typeof f.logo === 'string' && f.logo.length <= 340000 && LOGO_RE.test(f.logo) ? f.logo : '', address: t(f.address, 300), phones: t(f.phones, 160),
    signer: { name: t(sg.name, 120), title: t(sg.title, 120), exequatur: t(sg.exequatur, 60), icpard: t(sg.icpard, 60), city: t(sg.city, 120) }, informe_text: t(f.informe_text, 4000) || DEFAULT_INFORME };
  return {
    firm, states, labels, balance_rule: rule, balance_tolerance: Number.isFinite(tol) && tol >= 0 && tol <= 100 ? tol : DEFAULT_CONFIG.balance_tolerance,
    balance_rule_confirmed: c.balance_rule_confirmed === true, compare_enabled: c.compare_enabled === true,
    legalizacion: { enabled: c.legalizacion?.enabled === true, notes: String(c.legalizacion?.notes || '').slice(0, 2000) }, documents: docs,
  };
}
const order = m => (m === 'anual' ? ['pendiente_cierre'] : ['borrador']).concat(['en_revision', 'observado', 'aprobado', 'cerrado', 'pendiente_legalizacion']);

// ── Plantillas de carga ────────────────────────────────────────────────────
// `confirmed: false` = columna propuesta, por confirmar con Contabilidad. Ninguna plantilla trae cifras.
const ENTRY_FIELDS = [
  { key: 'entry_date', label: 'Fecha', type: 'date', required: true, aliases: ['fecha', 'date', 'fecha asiento', 'fecha contable'], hint: 'Fecha del registro (AAAA-MM-DD o DD/MM/AAAA).' },
  { key: 'account_code', label: 'Código de cuenta', type: 'text', required: true, aliases: ['codigo cuenta', 'codigo de cuenta', 'cuenta', 'no cuenta', 'account', 'codigo'], hint: 'Código de la cuenta contable.' },
  { key: 'account_name', label: 'Nombre de cuenta', type: 'text', required: false, aliases: ['nombre cuenta', 'nombre de cuenta', 'descripcion cuenta', 'cuenta nombre'], hint: 'Nombre de la cuenta.' },
  { key: 'concept', label: 'Concepto o descripción', type: 'text', required: false, aliases: ['concepto', 'descripcion', 'detalle', 'glosa', 'narracion'], hint: 'Descripción del movimiento.' },
  { key: 'reference', label: 'Referencia o número de asiento', type: 'text', required: false, aliases: ['referencia', 'asiento', 'no asiento', 'numero asiento', 'documento', 'ref'], hint: 'Sirve para validar que cada asiento cuadre.' },
  { key: 'debit', label: 'Débito', type: 'amount', required: false, aliases: ['debito', 'debe', 'debitos', 'debit'], hint: 'Importe al debe (sin negativos).' },
  { key: 'credit', label: 'Crédito', type: 'amount', required: false, aliases: ['credito', 'haber', 'creditos', 'credit'], hint: 'Importe al haber (sin negativos).' },
  { key: 'opening_balance', label: 'Saldo inicial', type: 'balance', required: false, aliases: ['saldo inicial', 'saldo anterior', 'opening'], hint: 'Cuando la plantilla de Contabilidad lo incluya.' },
  { key: 'closing_balance', label: 'Saldo final', type: 'balance', required: false, aliases: ['saldo final', 'saldo actual', 'closing', 'saldo'], hint: 'Cuando la plantilla de Contabilidad lo incluya.' },
  { key: 'currency', label: 'Moneda', type: 'currency', required: false, aliases: ['moneda', 'currency', 'divisa'], hint: 'Debe coincidir con la moneda del informe.' },
  { key: 'period', label: 'Período', type: 'period', required: false, aliases: ['periodo', 'period', 'mes'], hint: 'AAAAMM o AAAA-MM; debe corresponder a la fecha.' },
  { key: 'company_rnc', label: 'Empresa (RNC)', type: 'id', required: false, aliases: ['empresa', 'rnc', 'rnc empresa', 'entidad', 'cedula'], hint: 'Si viene, debe ser el RNC de la empresa del informe.' },
  { key: 'classification', label: 'Clasificación contable', type: 'text', required: false, aliases: ['clasificacion', 'clasificacion contable', 'grupo', 'rubro', 'tipo cuenta'], hint: 'La suministra Contabilidad.' },
];
const ASSUMPTION_FIELDS = [
  { key: 'scenario', label: 'Escenario', type: 'text', required: false, aliases: ['escenario', 'scenario'], hint: 'Si viene, debe ser el escenario del informe.' },
  { key: 'kind', label: 'Tipo (supuesto o valor estimado)', type: 'kind', required: true, aliases: ['tipo', 'clase'], hint: 'Escriba «supuesto» o «valor estimado».' },
  { key: 'name', label: 'Concepto', type: 'text', required: true, aliases: ['concepto', 'nombre', 'rubro', 'supuesto', 'partida'], hint: 'Nombre del supuesto o del valor estimado.' },
  { key: 'description', label: 'Descripción', type: 'text', required: false, aliases: ['descripcion', 'detalle', 'explicacion', 'base'], hint: 'Explica de dónde sale o qué significa.' },
  { key: 'period', label: 'Período', type: 'text', required: false, aliases: ['periodo', 'mes', 'ano', 'period'], hint: 'Período futuro al que corresponde (texto libre: 2027-01, T1 2027…).' },
  { key: 'account_code', label: 'Código de cuenta', type: 'text', required: false, aliases: ['codigo cuenta', 'cuenta', 'codigo'], hint: 'Opcional; permite comparar con cifras reales de esa cuenta.' },
  { key: 'amount', label: 'Valor', type: 'amount', required: false, aliases: ['valor', 'monto', 'importe', 'cantidad'], hint: 'Cifra numérica, tal como la entrega Contabilidad.' },
  { key: 'unit', label: 'Unidad', type: 'text', required: false, aliases: ['unidad', 'moneda', 'unit'], hint: 'RD$, %, unidades…' },
  { key: 'source', label: 'Fuente', type: 'text', required: false, aliases: ['fuente', 'origen', 'source', 'responsable'], hint: 'De dónde salió el dato.' },
  { key: 'pending', label: 'Pendiente (sí/no)', type: 'bool', required: false, aliases: ['pendiente', 'por confirmar'], hint: '«sí» si el dato aún no está confirmado.' },
];
const FIELDS = { proyectado: ASSUMPTION_FIELDS, interino: ENTRY_FIELDS, anual: ENTRY_FIELDS };

// Qué falta que Contabilidad confirme sobre las plantillas (se muestra en el módulo y en la plantilla).
const PENDING_FROM_ACCOUNTING = {
  proyectado: [
    'Lista final de columnas de la plantilla de proyectados.',
    'Fórmulas y datos base que se usarán para proyectar (hoy el módulo NO calcula proyecciones).',
    'Escenarios que se manejarán (además del escenario base).',
    'Documentos que forman parte de la modalidad (balance, resultados, flujos…).',
  ],
  interino: [
    'Lista final de columnas del libro/auxiliar que se cargará.',
    'Regla de cuadre de débitos y créditos (por asiento, global o ninguna).',
    'Clasificación contable de las cuentas.',
    'Documentos que forman parte de la modalidad (balance, resultados, flujos…).',
  ],
  anual: [
    'Lista final de columnas de la plantilla del año.',
    'Ajustes y asientos de cierre que aplican.',
    'Estados de cierre y el proceso de legalización (pasos, documentos y aprobaciones).',
    'Documentos que forman parte de la modalidad (balance, resultados, flujos…).',
  ],
};

module.exports = {
  DEFAULT_INFORME, MODALITIES, PERMISSIONS, PERMISSION_LABELS, ROLE_PERMISSIONS, ROLE_LABELS, permissionsFor, STATE_DEFS, DEFAULT_STATES, INITIAL_STATE,
  NO_OVERRIDE, OPTIONAL_STATES, LOCKED, NEEDS_COMPLETE, transitionsFor, DEFAULT_CONFIG, mergeConfig, FIELDS, ENTRY_FIELDS, ASSUMPTION_FIELDS, PENDING_FROM_ACCOUNTING,
};
