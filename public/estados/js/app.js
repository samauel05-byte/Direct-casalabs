/* Estados Financieros — núcleo: API, estado, ruteo y componentes (misma sesión que Direct). */
(function () {
  const EF = (window.EF = { views: {}, state: {} });

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = v => (v === null || v === undefined || v === '' ? '—' : Number.isFinite(Number(v)) ? Number(v).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : esc(v));
  const dateOnly = v => (v ? String(v).slice(0, 10).split('-').reverse().join('/') : '—');
  const dateTime = v => (v ? new Date(v).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  Object.assign(EF, { esc, money, dateOnly, dateTime });

  const STATUS_CLS = { borrador: '', pendiente_cierre: 'warn', en_revision: 'info', observado: 'warn', aprobado: 'ok', cerrado: 'accent', pendiente_legalizacion: 'info' };
  EF.statusBadge = s => `<span class="badge ${STATUS_CLS[s] || ''}">${esc((EF.state.me?.state_labels || {})[s] || s)}</span>`;
  EF.can = p => (EF.state.me?.permissions || []).includes(p);
  EF.mod = key => EF.state.me?.modalities?.[key];
  EF.canEditModality = key => EF.can(EF.mod(key)?.edit);

  // ── Shell de Direct ─────────────────────────────────────────────────────
  EF.host = () => {
    try {
      if (window.parent !== window) return window.parent;
      if (window.opener && !window.opener.closed) { void window.opener.location.origin; return window.opener; }
    } catch (_) { /* aislado */ }
    return null;
  };
  EF.goBack = () => {
    const h = EF.host();
    if (window.parent !== window) { try { h.postMessage({ action: 'showPortals' }, location.origin); } catch (_) { /* sin shell */ } return; }
    try { if (h) h.focus(); } catch (_) { /* sin foco */ }
    window.close();
    setTimeout(() => { if (!window.closed) location.href = '/'; }, 300);
  };

  // ── API ─────────────────────────────────────────────────────────────────
  function authHeaders() {
    const headers = {}; let token = ''; let sid = '';
    try { token = (EF.host() || window).sessionStorage.getItem('dtoken') || sessionStorage.getItem('dtoken') || ''; } catch (_) { /* aislado */ }
    try { sid = localStorage.getItem('direct_session_id') || ''; } catch (_) { /* sin storage */ }
    if (token) headers.Authorization = `Bearer ${token}`;
    if (sid) headers['X-Direct-Session'] = sid;
    return headers;
  }
  EF.api = async function api(method, path, body, _retried) {
    const res = await fetch(`/api/estados/${path}`, { method, headers: { ...authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && !_retried) {
        let refreshed = null;
        try { const h = EF.host(); refreshed = h && h.directRefresh ? await h.directRefresh() : null; } catch (_) { /* aislado */ }
        if (refreshed) return api(method, path, body, true);
      }
      if (res.status === 401) document.getElementById('content').innerHTML = '<div class="card empty"><b>Su sesión terminó o se abrió en otro equipo.</b><br>Vuelva a iniciar sesión en Direct.</div>';
      const error = new Error(data.error || `Error ${res.status}`);
      error.status = res.status; error.data = data;
      throw error;
    }
    return data;
  };

  // ── Componentes ─────────────────────────────────────────────────────────
  EF.toast = (message, kind = '') => {
    const t = document.createElement('div'); t.className = `toast ${kind}`; t.textContent = message;
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 8000 : 3500);
  };
  EF.fail = e => EF.toast(e.message || String(e), 'err');
  EF.modal = ({ title, body, okText = 'Aceptar', okClass = 'primary', cancelText = 'Cancelar', onOk, wide = false, onOpen }) => new Promise(resolve => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="${wide ? 'width:min(960px,100%)' : ''}"><h3>${esc(title)}</h3><div class="modal-body">${body}</div>
      <div class="actions">${cancelText ? `<button class="btn" data-x="cancel">${esc(cancelText)}</button>` : ''}${okText ? `<button class="btn ${okClass}" data-x="ok">${esc(okText)}</button>` : ''}</div></div>`;
    document.body.appendChild(bg);
    const close = v => { bg.remove(); resolve(v); };
    bg.querySelector('[data-x="cancel"]')?.addEventListener('click', () => close(null));
    bg.addEventListener('keydown', e => { if (e.key === 'Escape') close(null); });
    bg.querySelector('[data-x="ok"]')?.addEventListener('click', async () => {
      const btn = bg.querySelector('[data-x="ok"]'); btn.disabled = true;
      try { const v = onOk ? await onOk(bg.querySelector('.modal')) : true; close(v ?? true); } catch (e) { EF.fail(e); btn.disabled = false; }
    });
    if (onOpen) onOpen(bg.querySelector('.modal'), { close, okBtn: bg.querySelector('[data-x="ok"]') });
    setTimeout(() => (bg.querySelector('input,textarea,select') || bg.querySelector('[data-x="ok"]'))?.focus(), 30);
  });
  EF.askReason = (title, { min = 5, okText = 'Confirmar', extra = '' } = {}) => EF.modal({ title, okText,
    body: `${extra}<label class="f"><span>Motivo</span><textarea rows="3" id="reason-input" placeholder="Obligatorio (mín. ${min} caracteres)"></textarea></label>`,
    onOk: m => { const v = m.querySelector('#reason-input').value.trim(); if (v.length < min) throw new Error(`Indique el motivo (mín. ${min} caracteres).`); return v; } });
  EF.download = file => {
    const bytes = Uint8Array.from(atob(file.base64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
    const a = document.createElement('a'); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  EF.fileToBase64 = async file => {
    if (file.size > 3 * 1024 * 1024) throw new Error('El archivo es muy grande (máx. 3 MB).');
    const bytes = new Uint8Array(await file.arrayBuffer()); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  EF.clientName = id => (EF.state.clients || []).find(c => c.id === id)?.legal_name || '—';
  EF.clientOptions = (selected, { includeAll = false, allLabel = 'Todas las empresas' } = {}) =>
    `${includeAll ? `<option value="">${esc(allLabel)}</option>` : ''}${(EF.state.clients || []).filter(c => c.status !== 'inactive' || c.id === selected)
      .map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.legal_name)}${c.rnc ? ` · ${esc(c.rnc)}` : ''}</option>`).join('')}`;
  EF.modTag = key => (key === 'proyectado' ? '<span class="proj-tag">PROYECTADO</span>' : '<span class="real-tag">REAL</span>');

  // ── Ruteo por hash ──────────────────────────────────────────────────────
  const NAV = [
    ['inicio', '🏠', 'Inicio'], ['m/proyectado', '🔮', 'Proyectados'], ['m/interino', '📆', 'Interinos'], ['m/anual', '📘', 'Del año'],
    ['plantillas', '📄', 'Plantillas y pendientes'],
    ['config', '⚙️', 'Configuración', 'templates_manage', 'Administración'], ['equipo', '👥', 'Equipo y permisos', 'team_manage', 'Administración'],
  ];
  function renderNav(active) {
    let section = '';
    document.getElementById('nav').innerHTML = NAV.filter(([, , , perm]) => !perm || EF.can(perm)).map(([key, icon, label, , sec]) => {
      const sep = sec && sec !== section ? ((section = sec), `<div class="sep">${esc(sec)}</div>`) : '';
      return `${sep}<button class="${key === active ? 'active' : ''}" data-nav="${key}"><span>${icon}</span>${esc(label)}</button>`;
    }).join('');
  }
  EF.go = hash => { if (location.hash === hash) route(); else location.hash = hash; };
  EF.parseHash = () => {
    const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
    const parts = path.split('/').filter(Boolean);
    return { view: parts[0] || 'inicio', arg: parts[1] || null, params: Object.fromEntries(new URLSearchParams(query)) };
  };
  let token = 0;
  async function route() {
    const { view, arg, params } = EF.parseHash();
    const needed = { config: 'templates_manage', equipo: 'team_manage' }[view];
    if (needed && !EF.can(needed)) { EF.go('#/inicio'); return; }
    const def = EF.views[view] || EF.views.inicio;
    renderNav(view === 'm' ? `m/${arg}` : view);
    document.body.classList.remove('nav-open');
    const content = document.getElementById('content');
    const holder = document.createElement('div'); holder.innerHTML = '<div class="empty">Cargando…</div>';
    content.replaceChildren(holder);
    const mine = ++token;
    try { document.getElementById('title').textContent = typeof def.title === 'function' ? def.title(arg) : def.title; await def.render(holder, { arg, params, isCurrent: () => mine === token }); }
    catch (e) { if (mine === token && e.status !== 401) holder.innerHTML = `<div class="card empty">⚠️ ${esc(e.message)}</div>`; }
  }
  EF.route = route;
  window.addEventListener('hashchange', route);
  EF.loadClients = async () => { EF.state.clients = (await EF.api('GET', 'clients')).clients; };

  async function boot() {
    document.getElementById('nav').addEventListener('click', e => { const b = e.target.closest('[data-nav]'); if (b) EF.go(`#/${b.dataset.nav}`); });
    document.getElementById('menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
    document.getElementById('filters-btn')?.addEventListener('click', e => { const t = document.querySelector('.topbar'); const on = t.classList.toggle('filters-open'); e.currentTarget.setAttribute('aria-expanded', on ? 'true' : 'false'); });
    try { EF.state.me = await EF.api('GET', 'me'); } catch (e) { if (e.status !== 401) document.getElementById('content').innerHTML = `<div class="card empty">⚠️ ${esc(e.message)}</div>`; return; }
    await EF.loadClients();
    EF.state.client = '';
    document.getElementById('who').textContent = `${EF.state.me.username} · ${EF.state.me.role_label}`;
    const sel = document.getElementById('scope-client');
    sel.innerHTML = EF.clientOptions('', { includeAll: true });
    sel.addEventListener('change', () => { EF.state.client = sel.value; route(); });
    route();
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
