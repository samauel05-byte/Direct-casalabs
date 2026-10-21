/* NALA — núcleo de la aplicación: API, estado, ruteo y componentes. */
(function () {
  const NALA = (window.NALA = { views: {}, state: {}, cache: {} });

  // ── Utilidades ──────────────────────────────────────────────────────────
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = v => {
    if (v === null || v === undefined || v === '') return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return esc(v);
    return n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const int = v => Number(v || 0).toLocaleString('es-DO');
  const period = p => (p && p.length === 6 ? `${p.slice(4)}/${p.slice(0, 4)}` : p || '—');
  const dateTime = v => (v ? new Date(v).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const ms = v => { if (!v && v !== 0) return '—'; const s = Math.round(v / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };
  const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`; };
  Object.assign(NALA, { esc, money, int, period, dateTime, ms, prevMonth });

  const STATUS = {
    pending_review: ['Pendiente', 'warn'], reviewed: ['Revisada', 'info'], approved: ['Aprobada', 'ok'], excluded: ['Excluida', ''],
    draft: ['Borrador', ''], queued: ['En cola', 'info'], processing: ['Procesando', 'accent'], review: ['En revisión', 'warn'], completed: ['Completado', 'ok'], failed: ['Fallido', 'crit'],
    pending_upload: ['Subiendo', ''], uploaded: ['Recibido', 'info'], processed: ['Procesado', 'ok'], duplicate: ['Duplicado', 'warn'], unsupported: ['No admitido', 'crit'], purged: ['Depurado', ''],
    running: ['Ejecutando', 'accent'], succeeded: ['Completado', 'ok'], cancelled: ['Cancelado', ''],
    generated: ['Generado', 'info'], submitted: ['Enviado a DGII', 'accent'], accepted: ['Aceptado por DGII', 'ok'], rejected: ['Rechazado por DGII', 'crit'], superseded: ['Reemplazado', ''],
  };
  const ACTIONS = {
    batch_created: 'Lote creado', files_registered: 'Archivos registrados', uploaded: 'Archivo recibido', processing_started: 'Procesamiento iniciado',
    reprocess_requested: 'Reproceso solicitado', duplicate_file: 'Archivo duplicado detectado', job_failed: 'Trabajo fallido', extracted: 'Extraído por IA',
    reextracted: 'Extraído de nuevo (correcciones conservadas)', reprocess_skipped: 'Reproceso omitido (aprobado/excluido)', saved: 'Guardado', approved: 'Aprobado',
    approval_reverted: 'Aprobación revertida', relocated: 'Reubicado', excluded: 'Excluido', restored: 'Restaurado', exported: 'Incluido en exportación',
    export_generated: 'Exportación generada', export_submitted: 'Enviado a DGII', export_accepted: 'Aceptado por DGII', export_rejected: 'Rechazado por DGII',
    export_superseded: 'Exportación reemplazada', zero_filed: 'Informativo en cero presentado', client_created: 'Empresa registrada', client_updated: 'Empresa actualizada', member_updated: 'Miembro actualizado',
    settings_updated: 'Configuración actualizada', retention_purged: 'Originales depurados', rnc_lookup: 'Consulta RNC',
  };
  NALA.actionLabel = a => ACTIONS[a] || String(a).replace(/_/g, ' ');
  NALA.badge = s => { const [label, cls] = STATUS[s] || [s, '']; return `<span class="badge ${cls}">${esc(label)}</span>`; };
  // Una factura aprobada da sus advertencias por aceptadas: no muestra el badge
  // "! N" (queda con cotejo verde ✓). Cubre también las aprobadas antes de que
  // el servidor empezara a limpiar el contador al aprobar.
  NALA.issueBadges = inv => {
    const crit = inv.critical_count || 0;
    const warn = inv.status === 'approved' ? 0 : (inv.warning_count || 0);
    return `${crit ? `<span class="badge crit" title="Errores críticos">✕ ${crit}</span>` : ''}${warn ? ` <span class="badge warn" title="Advertencias">! ${warn}</span>` : ''}${!crit && !warn ? '<span class="badge ok">✓</span>' : ''}`;
  };

  // ── Shell de Direct ────────────────────────────────────────────────────
  // NALA corre dentro de Direct (iframe) o en su propia pestaña (window.open). En ambos
  // casos habla con el shell de Direct: el padre del iframe o la pestaña que la abrió.
  NALA.host = () => {
    try {
      if (window.parent !== window) return window.parent;
      if (window.opener && !window.opener.closed) { void window.opener.location.origin; return window.opener; }
    } catch (_) { /* aislado */ }
    return null;
  };
  NALA.goBack = () => {
    const h = NALA.host();
    if (window.parent !== window) { try { h.postMessage({ action: 'showPortals' }, location.origin); } catch (_) { /* sin shell */ } return; }
    try { if (h) h.focus(); } catch (_) { /* sin foco */ }
    window.close();
    setTimeout(() => { if (!window.closed) location.href = '/'; }, 300);
  };

  // ── API (misma sesión que SERP; el JWT nunca va en la URL) ─────────────
  function authHeaders() {
    const headers = {};
    let token = ''; let sid = '';
    try { token = (NALA.host() || window).sessionStorage.getItem('dtoken') || sessionStorage.getItem('dtoken') || ''; } catch (_) { /* aislado */ }
    try { sid = localStorage.getItem('direct_session_id') || ''; } catch (_) { /* sin storage */ }
    if (token) headers.Authorization = `Bearer ${token}`;
    if (sid) headers['X-Direct-Session'] = sid;
    return headers;
  }
  NALA.authHeaders = authHeaders;
  NALA.api = async function api(method, path, body, _retried) {
    const res = await fetch(`/api/nala/${path}`, {
      method, headers: { ...authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // En un 401, el token pudo haber vencido mientras se trabajaba: pedirle al
      // shell (misma sesión) que lo refresque y reintentar UNA vez antes de dar
      // la sesión por terminada. Así ya no saca al usuario al inicio sin razón.
      if (res.status === 401 && !_retried) {
        let refreshed = null;
        try { const h = NALA.host(); refreshed = h && h.directRefresh ? await h.directRefresh() : null; } catch (_) { /* aislado */ }
        if (refreshed) return api(method, path, body, true);
        showSessionError();
      } else if (res.status === 401) {
        showSessionError();
      }
      const error = new Error(data.error || `Error ${res.status}`);
      error.status = res.status; error.data = data;
      throw error;
    }
    return data;
  };
  function showSessionError() {
    document.getElementById('content').innerHTML = '<div class="card empty"><b>Su sesión terminó o se abrió en otro equipo.</b><br>Vuelva a iniciar sesión en SERP.</div>';
  }

  // ── Componentes ─────────────────────────────────────────────────────────
  NALA.toast = (message, kind = '') => {
    const t = document.createElement('div');
    t.className = `toast ${kind}`; t.textContent = message;
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
  };
  NALA.fail = e => NALA.toast(e.message || String(e), 'err');

  // Modal returning a promise; `body` is HTML; `onOk` may throw to keep it open.
  NALA.modal = ({ title, body, okText = 'Aceptar', okClass = 'primary', cancelText = 'Cancelar', onOk, wide = false }) => new Promise(resolve => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="${wide ? 'width:min(860px,100%)' : ''}"><h3>${esc(title)}</h3><div class="modal-body">${body}</div>
      <div class="actions">${cancelText ? `<button class="btn" data-x="cancel">${esc(cancelText)}</button>` : ''}${okText ? `<button class="btn ${okClass}" data-x="ok">${esc(okText)}</button>` : ''}</div></div>`;
    document.body.appendChild(bg);
    const close = v => { bg.remove(); resolve(v); };
    bg.querySelector('[data-x="cancel"]')?.addEventListener('click', () => close(null));
    bg.addEventListener('keydown', e => { if (e.key === 'Escape') close(null); });
    bg.querySelector('[data-x="ok"]')?.addEventListener('click', async () => {
      const btn = bg.querySelector('[data-x="ok"]'); btn.disabled = true;
      try { const v = onOk ? await onOk(bg.querySelector('.modal')) : true; close(v ?? true); } catch (e) { NALA.fail(e); btn.disabled = false; }
    });
    setTimeout(() => (bg.querySelector('input,textarea,select') || bg.querySelector('[data-x="ok"]'))?.focus(), 30);
  });

  NALA.askReason = (title, { label = 'Motivo', min = 5, extra = '', okText = 'Confirmar' } = {}) => NALA.modal({
    title, okText,
    body: `${extra}<label class="f"><span>${esc(label)}</span><textarea rows="3" id="reason-input" placeholder="Obligatorio (mín. ${min} caracteres)"></textarea></label>`,
    onOk: m => { const v = m.querySelector('#reason-input').value.trim(); if (v.length < min) throw new Error(`Indique el motivo (mín. ${min} caracteres).`); return v; },
  });

  NALA.downloadBlob = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  NALA.clientName = id => (NALA.state.clients || []).find(c => c.id === id)?.legal_name || '—';
  NALA.clientOptions = (selected, { includeAll = false, allLabel = 'Todas las empresas (consolidado)' } = {}) =>
    `${includeAll ? `<option value="">${esc(allLabel)}</option>` : ''}${(NALA.state.clients || []).filter(c => c.status !== 'inactive' || c.id === selected)
      .map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.legal_name)}${c.rnc ? ` · ${c.rnc}` : ''}</option>`).join('')}`;
  NALA.can = p => (NALA.state.me?.permissions || []).includes(p);
  NALA.catalogOptions = (catalog, selected, { blank = true } = {}) =>
    `${blank ? '<option value="">—</option>' : ''}${Object.entries(catalog).map(([k, v]) => `<option value="${k}" ${String(selected || '') === k ? 'selected' : ''}>${k} · ${esc(v)}</option>`).join('')}`;

  // ── Estado global: empresa activa, período y formato ───────────────────
  const prefKey = () => `nala.prefs.${NALA.state.me?.user_id || 'anon'}`;
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(prefKey()) || '{}'); } catch (_) { return {}; }
  }
  function savePrefs() {
    try { localStorage.setItem(prefKey(), JSON.stringify({ client: NALA.state.client, period: NALA.state.period, format: NALA.state.format })); } catch (_) { /* opcional */ }
  }
  NALA.setScope = patch => {
    Object.assign(NALA.state, patch); savePrefs(); renderScope();
    // Si estabas viendo un registro puntual (un lote o una factura), al cambiar
    // el filtro vuelve a su lista para que el nuevo filtro se vea aplicado.
    const { view, id } = NALA.parseHash();
    const listOf = { lotes: '#/lotes', auditoria: '#/auditoria' };
    if (id && listOf[view]) NALA.go(listOf[view]); else route();
  };
  function renderScope() {
    const s = NALA.state;
    document.getElementById('scope-client').innerHTML = NALA.clientOptions(s.client, { includeAll: true });
    document.getElementById('scope-period').value = s.period ? `${s.period.slice(0, 4)}-${s.period.slice(4)}` : '';
    const allBtn = document.getElementById('scope-period-all');
    if (allBtn) { const all = !s.period; allBtn.classList.toggle('primary', all); allBtn.setAttribute('aria-pressed', all ? 'true' : 'false'); }
    document.getElementById('scope-format').value = s.format || '';
    document.getElementById('scope-chip').textContent = s.client ? 'Vista por empresa' : 'Vista consolidada';
  }

  // ── Ruteo por hash ─────────────────────────────────────────────────────
  // 4º valor: permiso requerido para ver el ítem (null = visible para todos).
  // 5º valor: sección; el separador sólo aparece si la sección tiene ítems visibles.
  const NAV = [
    ['panel', '📊', 'Panel de control'], ['empresa', '🏢', 'Dashboard por empresa'], ['clientes', '🗂️', 'Empresas clientes'], ['rnc', '🔎', 'Consulta RNC'],
    ['lotes', '📥', 'Carga masiva y lotes'], ['auditoria', '🧾', 'Auditoría fiscal'], ['exportar', '📤', 'Exportar DGII 606/607'],
    ['equipo', '👥', 'Equipo y oficiales', 'team_manage', 'Administración'], ['config', '⚙️', 'Configuración', 'settings_manage', 'Administración'],
    // 7º valor: true = oculto por ahora (se quita del menú y se bloquea por URL; para volver a mostrarlo basta quitar el true).
    ['asistente', '💬', 'Asistente NALA (chat, IR-17)', null, 'Herramientas', true, true],
  ];
  // 6º valor: true = solo administradores (oculto del menú y bloqueado por URL).
  // Permiso requerido por vista (para ocultar del menú y bloquear el acceso directo por URL).
  NALA.navPerm = key => (NAV.find(n => n[0] === key) || [])[3] || null;
  NALA.navAdmin = key => !!((NAV.find(n => n[0] === key) || [])[5]);
  NALA.navHidden = key => !!((NAV.find(n => n[0] === key) || [])[6]);
  function renderNav(active) {
    let section = '';
    document.getElementById('nav').innerHTML = NAV.filter(([, , , perm, , adminOnly, hidden]) => !hidden && (!perm || NALA.can(perm)) && (!adminOnly || NALA.state.me?.is_admin)).map(([key, icon, label, , sec]) => {
      const sep = sec && sec !== section ? ((section = sec), `<div class="sep">${esc(sec)}</div>`) : '';
      return `${sep}<button class="${key === active ? 'active' : ''}" data-nav="${key}"><span>${icon}</span>${esc(label)}</button>`;
    }).join('');
  }
  NALA.go = hash => { if (location.hash === hash) route(); else location.hash = hash; };
  NALA.parseHash = () => {
    const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
    const parts = path.split('/').filter(Boolean);
    return { view: parts[0] || 'panel', id: parts[1] || null, params: Object.fromEntries(new URLSearchParams(query)) };
  };
  let routeToken = 0;
  async function route() {
    const { view, id, params } = NALA.parseHash();
    // Vistas de administración: si el usuario no tiene el permiso, lo mandamos al panel.
    const needed = NALA.navPerm(view);
    if (needed && !NALA.can(needed)) { NALA.go('#/panel'); return; }
    if (NALA.navAdmin(view) && !NALA.state.me?.is_admin) { NALA.go('#/panel'); return; }
    if (NALA.navHidden(view)) { NALA.go('#/panel'); return; }
    const def = NALA.views[view] || NALA.views.panel;
    if (NALA.beforeLeave && !(await NALA.beforeLeave())) return;
    NALA.beforeLeave = null;
    if (NALA.cleanup) { try { NALA.cleanup(); } catch (_) { /* ignorar */ } NALA.cleanup = null; }
    renderNav(view);
    document.body.classList.remove('nav-open');
    document.getElementById('title').textContent = def.title;
    const content = document.getElementById('content');
    // Each route renders into its own node: a slower, superseded render writes
    // into a detached element and its timers are cleaned up immediately.
    const holder = document.createElement('div');
    holder.innerHTML = '<div class="empty">Cargando…</div>';
    content.replaceChildren(holder);
    const token = ++routeToken;
    const isCurrent = () => token === routeToken;
    const onCleanup = fn => { if (isCurrent()) NALA.cleanup = fn; else fn(); };
    try { await def.render(holder, { id, params, isCurrent, onCleanup }); } catch (e) {
      if (isCurrent() && e.status !== 401) holder.innerHTML = `<div class="card empty">⚠️ ${esc(e.message)}</div>`;
    }
  }
  NALA.route = route;

  // Cambios sin guardar: pregunta antes de salir de la vista.
  window.addEventListener('beforeunload', e => { if (NALA.dirty) { e.preventDefault(); e.returnValue = ''; } });
  let lastHash = location.hash;
  window.addEventListener('hashchange', async () => {
    if (NALA.dirty && !(await NALA.modal({ title: 'Cambios sin guardar', body: '<p>Hay cambios sin guardar en el comprobante. ¿Desea descartarlos?</p>', okText: 'Descartar', okClass: 'danger' }))) {
      history.replaceState(null, '', lastHash); return;
    }
    NALA.dirty = false; lastHash = location.hash; route();
  });

  NALA.loadClients = async () => { NALA.state.clients = (await NALA.api('GET', 'clients')).clients; return NALA.state.clients; };

  async function boot() {
    document.getElementById('nav').addEventListener('click', e => { const b = e.target.closest('[data-nav]'); if (b) NALA.go(`#/${b.dataset.nav}`); });
    document.getElementById('menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
    try {
      NALA.state.me = await NALA.api('GET', 'me');
    } catch (e) {
      if (e.status !== 401) document.getElementById('content').innerHTML = `<div class="card empty">⚠️ ${esc(e.message)}</div>`;
      return;
    }
    await NALA.loadClients();
    const prefs = loadPrefs();
    NALA.state.client = (NALA.state.clients.some(c => c.id === prefs.client) ? prefs.client : '') || '';
    // Vista consolidada (todas las empresas) = todos los períodos, sin filtro de fecha.
    NALA.state.period = NALA.state.client ? (prefs.period || prevMonth()) : '';
    NALA.state.format = prefs.format || '';
    document.getElementById('tenant').textContent = NALA.state.me.tenant?.name || '';
    document.getElementById('who').textContent = NALA.state.me.role_label;
    renderScope();
    document.getElementById('scope-client').addEventListener('change', e => {
      const client = e.target.value;
      // Al elegir "Todas las empresas" se quita el filtro de período; al elegir una
      // empresa sin período fijado, se parte del mes anterior.
      const patch = { client };
      if (!client) patch.period = ''; else if (!NALA.state.period) patch.period = prevMonth();
      NALA.setScope(patch);
    });
    document.getElementById('scope-period').addEventListener('change', e => NALA.setScope({ period: e.target.value.replace('-', '') }));
    document.getElementById('scope-period-all').addEventListener('click', () => NALA.setScope({ period: '' }));
    document.getElementById('scope-format').addEventListener('change', e => NALA.setScope({ format: e.target.value }));
    route();
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
