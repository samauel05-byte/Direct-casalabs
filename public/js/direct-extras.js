/* Direct — funciones del inicio y de administración: favoritos y recientes,
   aviso de contraseña por actualizar, revisión de las tarjetas de códigos
   DGII, calendario de vencimientos, historial de entradas y permisos por
   empresa. Usa las funciones y datos globales de index.html (credentials,
   masterKey, C, A, INST, enterCompany…). Los nombres de las empresas están
   cifrados: se descifran solo en el navegador. */
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const plainCache = new Map();
  function plainOf(cred) {
    const key = cred.id + ':' + cred.updated_at;
    if (!plainCache.has(key)) plainCache.set(key, C.dec(masterKey, cred.iv, cred.ct).catch(() => ({ companyName: '(sin nombre)' })));
    return plainCache.get(key);
  }
  const instName = k => (INST[k] && INST[k].name) || k;
  const credById = id => credentials.find(c => c.id === id);

  const DX = { status: {}, recent: [], flows: new Map(), loaded: false };
  window.DX = DX;
  DX.esc = esc; DX.plainOf = plainOf; DX.instName = instName; DX.credById = credById;

  // (La función de favoritos se retiró por completo por pedido del usuario.)

  // Estado de contraseñas y entradas recientes (servidor).
  DX.refresh = async () => {
    try {
      const r = await A.get('/api/credentials?status=1');
      DX.status = r.status || {}; DX.recent = r.recent || []; DX.loaded = true;
    } catch (e) { /* sin red o sin la migración: el inicio funciona igual */ }
  };
  // "Contraseña por actualizar": el portal la rechazó después de la última vez
  // que se guardó la empresa. Al guardar la contraseña nueva, el aviso se quita.
  DX.needsUpdate = cred => {
    const st = DX.status[cred.id];
    return !!st && st.result === 'failed' && new Date(st.at).getTime() > Number(cred.updated_at || 0);
  };

  function logEvent(cred, event) {
    if (!cred) return;
    A.post('/api/credentials?event=1', { credential_id: cred.id, institution: cred.institution, event }).catch(() => {});
  }
  DX.onEnter = cred => {
    logEvent(cred, 'open');
    DX.recent = [{ credential_id: cred.id, institution: cred.institution, created_at: new Date().toISOString() }]
      .concat(DX.recent.filter(r => r.credential_id !== cred.id)).slice(0, 12);
  };
  DX.onFlow = (flow, cred) => { if (flow && cred) DX.flows.set(flow, cred); };

  // Resultado del inicio de sesión que avisa la pestaña del portal (relay).
  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || d.type !== 'serp-login-result' || !DX.flows.has(d.flow)) return;
    const cred = DX.flows.get(d.flow); DX.flows.delete(d.flow);
    const result = d.result === 'ok' ? 'ok' : 'failed';
    logEvent(cred, result === 'ok' ? 'login_ok' : 'login_failed');
    DX.status[cred.id] = { result, at: new Date().toISOString() };
    if (result === 'failed') toast(instName(cred.institution) + ': el portal rechazó la contraseña guardada. Revísela.', 'warn');
    DX.decorateCompanies();
  });
})();

(function () {
  const { esc, plainOf, instName, credById } = window.DX;

  // Inicio: avisos de contraseña por actualizar (los favoritos se retiraron).
  DX.renderHome = async function () {
    const main = document.getElementById('portals-main');
    if (!main || !masterKey) return;
    const old = main.querySelector('#dx-home'); if (old) old.remove();
    const box = document.createElement('div'); box.id = 'dx-home';
    const head = main.querySelector('.page-head');
    if (head) head.after(box); else main.prepend(box);
    if (!DX.loaded) await DX.refresh();

    const pending = credentials.filter(c => DX.needsUpdate(c));
    const nameOf = async c => esc(((await plainOf(c)).companyName) || 'Sin nombre');
    let html = '';

    if (pending.length) {
      const rows = await Promise.all(pending.map(async c => `<div class="dx-alert-row"><span>⚠️ ${await nameOf(c)} · ${esc(instName(c.institution))}</span><button class="btn btn-ghost dx-sm" data-fix="${esc(c.id)}">Actualizar clave</button></div>`));
      html += `<div class="dx-card dx-alert"><div class="dx-h">Contraseñas por actualizar (${pending.length})</div>${rows.join('')}</div>`;
    }
    box.innerHTML = html;

    box.querySelectorAll('[data-enter]').forEach(b => b.addEventListener('click', () => enterCompany(b.dataset.enter)));
    box.querySelectorAll('[data-fix]').forEach(b => b.addEventListener('click', () => openCompanyModal(b.dataset.fix)));
    // Cargar el logo oficial (favicon limpio) en los cuadritos de favoritos y
    // recientes; sin esto se quedaban con el SVG de respaldo dibujado a mano.
    if (typeof hydrateLogos === 'function') hydrateLogos(box);
  };

  // Vencimientos fijos del mes en RD: 606/607 el día 15, IT-1/TSS el día 20.
  DX.calendarHtml = function () {
    const now = new Date();
    const items = [
      { d: 15, t: 'Envío 606 y 607 (DGII)' },
      { d: 20, t: 'Declaración y pago de ITBIS (IT-1)' },
      { d: 3, t: 'TSS — Pago de la Seguridad Social' },
    ];
    const today = now.getDate();
    const rows = items.map(i => {
      const due = new Date(now.getFullYear(), now.getMonth(), i.d);
      const diff = Math.round((due - new Date(now.getFullYear(), now.getMonth(), today)) / 86400000);
      const label = diff > 0 ? `en ${diff} día${diff === 1 ? '' : 's'}` : diff === 0 ? 'hoy' : `vencido hace ${-diff} día${diff === -1 ? '' : 's'}`;
      const cls = diff < 0 ? 'dx-late' : diff <= 3 ? 'dx-soon' : '';
      return `<div class="dx-cal-row ${cls}"><span class="dx-cal-day">${i.d}</span><span>${esc(i.t)}</span><span class="dx-cal-when">${label}</span></div>`;
    });
    return `<div class="dx-card"><div class="dx-h">Vencimientos de ${now.toLocaleDateString('es-DO', { month: 'long' })}</div>${rows.join('')}<div class="dx-cal-note">Fechas de referencia. Si el día cae en fin de semana o feriado, el plazo pasa al siguiente día laborable.</div></div>`;
  };

  // Aviso rojo de "clave por actualizar" en cada cuadrito de empresa.
  // (La estrella de favorito se quitó de las tarjetas por pedido del usuario.)
  DX.decorateCompanies = function () {
    document.querySelectorAll('#company-list .company-card[data-cred]').forEach(card => {
      const id = card.dataset.cred; const cred = credById(id); if (!cred) return;
      card.classList.toggle('dx-needs-pw', DX.needsUpdate(cred));
      if (DX.needsUpdate(cred) && !card.querySelector('.dx-pw-flag')) {
        const flag = document.createElement('div'); flag.className = 'dx-pw-flag'; flag.textContent = 'Clave por actualizar';
        card.appendChild(flag);
      } else if (!DX.needsUpdate(cred)) {
        card.querySelector('.dx-pw-flag')?.remove();
      }
    });
  };
})();

(function () {
  const { esc, plainOf, instName, credById } = window.DX;
  const dgiiCred = () => credentials.filter(c => c.institution === 'dgii');

  function parseCodes(v) {
    if (Array.isArray(v)) return v.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
    return String(v || '').split(/[;,|\r\n]+/).map(x => x.trim()).filter(Boolean);
  }

  // Revisión de tarjetas de códigos DGII: cantidad, faltantes y repetidos.
  DX.openCards = async function () {
    show('view-dx-cards');
    const root = document.getElementById('dx-cards-body');
    root.innerHTML = '<p class="dx-muted">Revisando tarjetas…</p>';
    const list = dgiiCred();
    if (!list.length) { root.innerHTML = '<div class="client-empty"><h2>No hay empresas con DGII</h2><p>Importa o registra empresas con acceso DGII para revisar sus tarjetas de códigos.</p></div>'; return; }
    const rows = [];
    for (const c of list) {
      const p = await plainOf(c);
      const codes = parseCodes(p.dgiiCodes);
      const seen = {}; const dups = [];
      codes.forEach((x, i) => { if (seen[x] != null) dups.push(i + 1); else seen[x] = i + 1; });
      const n = codes.length;
      const ok = n === 40 && !dups.length;
      let state, cls;
      if (!n) { state = 'Sin tarjeta guardada'; cls = 'dx-chip-warn'; }
      else if (n !== 40) { state = `${n} de 40 códigos`; cls = 'dx-chip-bad'; }
      else if (dups.length) { state = `Repetidos en posición ${dups.slice(0, 6).join(', ')}`; cls = 'dx-chip-bad'; }
      else { state = '40 códigos, sin repetidos'; cls = 'dx-chip-ok'; }
      rows.push({ id: c.id, name: p.companyName || 'Sin nombre', n, ok, state, cls });
    }
    rows.sort((a, b) => (a.ok === b.ok ? a.name.localeCompare(b.name) : a.ok ? 1 : -1));
    const bad = rows.filter(r => !r.ok).length;
    root.innerHTML = `<p class="dx-muted">${rows.length} empresa(s) con DGII · ${bad ? `<b style="color:var(--danger)">${bad} con problemas</b>` : 'todas correctas'}. La tarjeta debe tener los 40 códigos en orden, del 1 al 40.</p>
      <div class="table-wrap"><table class="dx-table"><tr><th>Empresa</th><th>Códigos</th><th>Estado</th><th></th></tr>
      ${rows.map(r => `<tr><td><b>${esc(r.name)}</b></td><td class="dx-mono">${r.n}</td><td><span class="dx-chip ${r.cls}">${esc(r.state)}</span></td><td><button class="btn btn-ghost dx-sm" data-edit="${esc(r.id)}">Editar</button></td></tr>`).join('')}</table></div>`;
    root.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openCompanyModal(b.dataset.edit)));
  };

  // Historial de entradas (solo administradores).
  DX.openHistory = async function () {
    show('view-dx-history');
    const root = document.getElementById('dx-history-body');
    root.innerHTML = '<p class="dx-muted">Cargando historial…</p>';
    let data;
    try { data = await A.get('/api/credentials?events=1&limit=400'); }
    catch (e) { root.innerHTML = `<div class="client-empty"><h2>No se pudo cargar</h2><p>${esc(e.message)}</p></div>`; return; }
    const events = data.events || [];
    if (!events.length) { root.innerHTML = '<div class="client-empty"><h2>Sin actividad todavía</h2><p>Aquí verás quién entró a cada portal y cuándo.</p></div>'; return; }
    const nameMap = {};
    await Promise.all([...new Set(events.map(e => e.credential_id))].map(async id => {
      const c = credById(id); nameMap[id] = c ? (((await plainOf(c)).companyName) || 'Sin nombre') : '(empresa eliminada)';
    }));
    const evLabel = { open: 'Entró', login_ok: 'Entró ✓', login_failed: 'Clave rechazada' };
    const evCls = { open: '', login_ok: 'dx-chip-ok', login_failed: 'dx-chip-bad' };
    root.innerHTML = `<p class="dx-muted">${events.length} evento(s) recientes.</p>
      <div class="table-wrap"><table class="dx-table"><tr><th>Fecha</th><th>Usuario</th><th>Empresa</th><th>Portal</th><th>Acción</th></tr>
      ${events.map(e => `<tr><td class="dx-mono">${esc(new Date(e.created_at).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' }))}</td>
        <td>${esc(e.username || '—')}</td><td>${esc(nameMap[e.credential_id] || '—')}</td><td>${esc(instName(e.institution))}</td>
        <td><span class="dx-chip ${evCls[e.event] || ''}">${esc(evLabel[e.event] || e.event)}</span></td></tr>`).join('')}</table></div>`;
  };

  // Permisos por empresa en la ventana de usuario.
  DX.fillUserCompanies = async function (userData) {
    const box = document.getElementById('u-companies-section');
    if (!box) return;
    box.innerHTML = '';
    if (!masterKey) return;
    const sel = (userData && Array.isArray(userData.companies_direct)) ? userData.companies_direct : null;
    const named = [];
    for (const c of credentials) named.push({ id: c.id, name: ((await plainOf(c)).companyName) || 'Sin nombre', inst: instName(c.institution) });
    named.sort((a, b) => a.name.localeCompare(b.name));
    const uniqueCompanies = [];
    const byName = {};
    for (const c of named) { if (!byName[c.name]) { byName[c.name] = []; uniqueCompanies.push(c.name); } byName[c.name].push(c.id); }
    box.innerHTML = `<label class="chk-row" style="padding:4px 0;font-weight:600"><input type="checkbox" id="u-all-companies" ${sel ? '' : 'checked'}> Todas las empresas</label>
      <div id="u-company-list" style="margin-left:24px;max-height:220px;overflow:auto;${sel ? '' : 'display:none'}">
        <input id="u-company-q" placeholder="Buscar empresa…" style="width:100%;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 10px;font-size:12px;margin-bottom:8px">
        ${uniqueCompanies.map(nm => `<label class="chk-row" data-cname="${esc(nm.toLowerCase())}"><input type="checkbox" class="u-company" value="${esc(byName[nm].join(','))}" ${sel && byName[nm].some(id => sel.includes(id)) ? 'checked' : ''}> ${esc(nm)}</label>`).join('')}
      </div>`;
    const all = box.querySelector('#u-all-companies');
    const listBox = box.querySelector('#u-company-list');
    all.addEventListener('change', () => { listBox.style.display = all.checked ? 'none' : ''; });
    box.querySelector('#u-company-q').addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      box.querySelectorAll('[data-cname]').forEach(l => { l.style.display = l.dataset.cname.includes(q) ? '' : 'none'; });
    });
  };
  // Panel de uso (admin): lee /api/credentials?stats=1 y lo dibuja en vivo.
  const evLbl = { open: 'entró', login_ok: 'sesión OK', login_failed: 'clave rechazada' };
  const evCls = { open: '', login_ok: 'dx-chip-ok', login_failed: 'dx-chip-bad' };
  const fmtDay = d => { const [y, m, dd] = d.split('-'); return dd + '/' + m; };
  const fmtWhen = iso => new Date(iso).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' });
  DX.openUsage = async function () {
    show('view-dx-usage');
    const root = document.getElementById('dx-usage-body');
    root.innerHTML = '<p class="dx-muted">Cargando uso…</p>';
    let d;
    try { d = await A.get('/api/credentials?stats=1'); }
    catch (e) { root.innerHTML = `<div class="client-empty"><h2>No se pudo cargar</h2><p>${esc(e.message)}</p></div>`; return; }
    const r = d.resumen || {};
    const kpi = (lab, val, meta, cls) => `<div class="dx-u-kpi ${cls || ''}"><div class="k-lab">${lab}</div><div class="k-val">${val}</div><div class="k-meta">${meta}</div></div>`;
    const kpis = `<div class="dx-u-kpis">
      ${kpi('Acciones · 24 h', r.eventos_24h ?? 0, `${r.eventos_7d ?? 0} en 7 días`, 'accent')}
      ${kpi('Usuarios activos', r.usuarios_activos ?? 0, `de ${r.usuarios_registrados ?? 0} registrados`)}
      ${kpi('Empresas', r.empresas ?? 0, 'en la bóveda')}
      ${kpi('Inicios de sesión', r.logins_ok ?? 0, `${r.entradas ?? 0} entradas`, 'ok')}
      ${kpi('Clave rechazada', r.logins_fallidos ?? 0, r.logins_fallidos ? 'revisar contraseñas' : 'ninguna', r.logins_fallidos ? '' : 'ok')}</div>`;

    const dias = (d.por_dia || []).filter(x => x.open + x.login > 0).length ? d.por_dia : (d.por_dia || []).slice(-7);
    const maxD = Math.max(1, ...dias.map(x => x.open + x.login));
    const daysHtml = dias.map(x => { const t = x.open + x.login, h = Math.round(t / maxD * 104), oh = t ? Math.round(x.open / t * h) : 0;
      return `<div class="dx-u-day"><div class="dn">${t || '·'}</div><div class="bar" style="height:${Math.max(h, 2)}px"><div class="s2" style="height:${h - oh}px"></div><div class="s1" style="height:${oh}px"></div></div><div class="dl">${fmtDay(x.d)}</div></div>`; }).join('');

    const us = d.por_usuario || [];
    const usersHtml = us.length ? `<div class="table-wrap"><table class="dx-table"><tr><th>Usuario</th><th>Acc.</th><th>Logins</th><th>Empr.</th><th>Último</th></tr>
      ${us.map(u => `<tr><td><b>${esc(u.usuario)}</b></td><td>${u.ev}</td><td>${u.log}</td><td>${u.emp}</td><td class="dx-mono dx-sm">${esc(fmtWhen(u.last))}</td></tr>`).join('')}</table></div>` : '<p class="dx-muted">Sin usuarios activos.</p>';

    const ps = d.por_portal || []; const maxP = Math.max(1, ...ps.map(x => x.n));
    const portHtml = ps.length ? `<div class="dx-u-rows">${ps.map(x => `<div class="dx-u-r"><span class="nm">${esc(instName(x.portal))}</span><span class="tr"><span class="fl" style="width:${x.n / maxP * 100}%"></span></span><span class="am">${x.n} · ${x.users} usr</span></div>`).join('')}</div>` : '<p class="dx-muted">Sin entradas.</p>';

    const hrs = d.por_hora || []; const maxH = Math.max(1, ...hrs); const from = 7, to = 20;
    let hoursHtml = '<div class="dx-u-hours">';
    for (let h = from; h <= to; h++) { const n = hrs[h] || 0; hoursHtml += `<div class="dx-u-hr"><div class="hb" title="${n} a las ${h}:00" style="height:${n ? Math.max(n / maxH * 54, 3) : 0}px"></div><div class="hl">${h}</div></div>`; }
    hoursHtml += '</div>';

    const rec = d.por_portal ? (d.recientes || []) : [];
    const recHtml = rec.length ? `<div class="table-wrap"><table class="dx-table"><tr><th>Fecha</th><th>Usuario</th><th>Portal</th><th>Acción</th></tr>
      ${rec.map(e => `<tr><td class="dx-mono dx-sm">${esc(fmtWhen(e.at))}</td><td>${esc(e.usuario)}</td><td>${esc(instName(e.portal))}</td><td><span class="dx-chip ${evCls[e.event] || ''}">${esc(evLbl[e.event] || e.event)}</span></td></tr>`).join('')}</table></div>` : '';

    // ── Inteligencia (Etapa 2) ──
    const TOOL_LABELS = { nala: 'NALA', cami: 'CAMI', ir2: 'IR-2', 'dgii-modulos': 'Estimación Fiscal', clients: 'Clientes' };
    const lab = k => TOOL_LABELS[k] || instName(k);

    // Módulos: uso de cada herramienta + aviso de los que nadie usa.
    const mods = d.modulos || [];
    const maxM = Math.max(1, ...mods.map(m => m.n));
    const modsHtml = mods.length ? `<div class="dx-u-rows">${mods.map(m => `<div class="dx-u-r"><span class="nm">${esc(lab(m.modulo))}</span><span class="tr"><span class="fl" style="width:${m.n / maxM * 100}%"></span></span><span class="am">${m.n ? `${m.n} · ${m.users} usr` : '<span class="dx-chip dx-chip-bad">nunca usado</span>'}</span></div>`).join('')}</div>` : '<p class="dx-muted">Aún sin datos de módulos.</p>';

    // Actividad por usuario: a qué se dedica cada quien.
    const acts = d.actividad || [];
    const actHtml = acts.length ? `<div class="table-wrap"><table class="dx-table"><tr><th>Usuario</th><th>Se dedica a</th><th>Portal principal</th><th>Ses.</th><th>Búsq.</th></tr>
      ${acts.map(a => `<tr><td><b>${esc(a.usuario)}</b></td><td>${a.top_modulo ? esc(lab(a.top_modulo.k)) + ` <span class="dx-muted dx-sm">×${a.top_modulo.n}</span>` : '<span class="dx-muted">—</span>'}</td><td>${a.top_portal ? esc(lab(a.top_portal.k)) + ` <span class="dx-muted dx-sm">×${a.top_portal.n}</span>` : '<span class="dx-muted">—</span>'}</td><td>${a.ses}</td><td>${a.bus}</td></tr>`).join('')}</table></div>` : '<p class="dx-muted">Aún sin datos de navegación. Se irán llenando con el uso.</p>';

    // Cuellos de botella: empresas con más "clave rechazada" (nombre resuelto aquí).
    const cuellos = d.cuellos || [];
    let cuellosHtml = '';
    if (cuellos.length) {
      const names = await Promise.all(cuellos.map(c => {
        const cr = credById(c.credential_id);
        return cr ? plainOf(cr).then(p => p.companyName || '(sin nombre)').catch(() => '(sin nombre)') : Promise.resolve('(empresa eliminada)');
      }));
      cuellosHtml = `<div class="table-wrap"><table class="dx-table"><tr><th>Empresa</th><th>Portal</th><th>Rechazos</th><th>Último</th></tr>
        ${cuellos.map((c, i) => `<tr><td><b>${esc(names[i])}</b></td><td>${esc(instName(c.institution))}</td><td><span class="dx-chip dx-chip-bad">${c.n}</span></td><td class="dx-mono dx-sm">${esc(fmtWhen(c.last))}</td></tr>`).join('')}</table></div>`;
    }

    root.innerHTML = `${kpis}
      <p class="dx-muted dx-sm" style="margin:-8px 0 16px">El historial registra desde que se activó esta función; la actividad anterior no quedó guardada. Los nombres de empresa van cifrados y se resuelven solo en tu navegador.</p>
      <div class="dx-u-grid">
        <div class="dx-card span"><div class="dx-h">Actividad por día</div><div class="dx-u-days">${daysHtml}</div></div>
        <div class="dx-card"><div class="dx-h">Por usuario</div>${usersHtml}</div>
        <div class="dx-card"><div class="dx-h">Por portal</div>${portHtml}</div>
        <div class="dx-card"><div class="dx-h">Módulos (herramientas)</div>${modsHtml}</div>
        <div class="dx-card span"><div class="dx-h">A qué se dedica cada usuario</div>${actHtml}</div>
        ${cuellosHtml ? `<div class="dx-card span"><div class="dx-h">Cuellos de botella · contraseñas rechazadas</div>${cuellosHtml}</div>` : ''}
        <div class="dx-card span"><div class="dx-h">Por hora del día <span class="dx-muted dx-sm">(hora RD)</span></div>${hoursHtml}</div>
        ${recHtml ? `<div class="dx-card span"><div class="dx-h">Entradas recientes</div>${recHtml}</div>` : ''}
      </div>`;
  };


  // Licencias de la plataforma (solo el administrador de la plataforma, root).
  const licFmt = iso => iso ? new Date(iso).toLocaleDateString('es-DO', { dateStyle: 'medium' }) : '—';
  const licState = t => {
    const st = t.state || {};
    if (st.code === 'suspended') return ['Suspendida', 'dx-chip-bad'];
    if (st.code === 'expired') return ['Vencida', 'dx-chip-bad'];
    if (st.code === 'grace') return [`En gracia · ${st.graceDaysLeft} d`, 'dx-chip-warn'];
    if (st.code === 'unlimited') return ['Sin vencimiento', 'dx-chip-ok'];
    return [`Activa · ${st.daysLeft} d`, 'dx-chip-ok'];
  };
  DX.openLicenses = async function () {
    show('view-dx-licenses');
    const root = document.getElementById('dx-lic-body');
    if (!root.dataset.ready) root.innerHTML = '<p class="dx-muted">Cargando licencias…</p>';
    let d;
    try { d = await A.get('/api/licenses/list'); }
    catch (e) { root.innerHTML = `<div class="client-empty"><h2>No se pudo cargar</h2><p>${esc(e.message)}</p></div>`; return; }
    root.dataset.ready = '1';
    const tenants = d.tenants || [], lics = d.licenses || [];
    const pending = lics.filter(l => l.status === 'pending');
    const stLbl = { pending: ['Pendiente', 'dx-chip-warn'], activated: ['Activada', 'dx-chip-ok'], revoked: ['Anulada', 'dx-chip-bad'] };
    const tenantRows = tenants.map(t => { const [lbl, cls] = licState(t); const slug = t.slug === 'save';
      return `<tr><td><b>${esc(t.name)}</b><div class="dx-muted dx-sm" style="margin:0">${esc(t.billing_email || t.slug)}</div></td>
        <td>${esc(t.license_plan || '—')}</td><td>${licFmt(t.license_until)}</td><td><span class="dx-chip ${cls}">${esc(lbl)}</span></td>
        <td class="dx-mono">${t.users}${t.max_users ? ' / ' + t.max_users : ''}</td>
        <td style="white-space:nowrap">${t.license_until || !slug ? `<button class="back-btn" style="margin:0 4px 0 0" data-lic="extend" data-id="${t.id}" data-m="1">+1 mes</button><button class="back-btn" style="margin:0 4px 0 0" data-lic="extend" data-id="${t.id}" data-m="12">+12</button>` : ''}
        ${slug ? '' : t.license_status === 'suspended' ? `<button class="back-btn" style="margin:0" data-lic="resume" data-id="${t.id}">Reactivar</button>` : `<button class="back-btn" style="margin:0;color:var(--danger)" data-lic="suspend" data-id="${t.id}">Suspender</button>`}</td></tr>`; }).join('');
    const licRows = lics.map(l => { const [lbl, cls] = stLbl[l.status] || [l.status, '']; const expired = l.status === 'pending' && new Date(l.link_expires_at) < new Date();
      return `<tr><td><b>${esc(l.customer_name)}</b><div class="dx-muted dx-sm" style="margin:0">${esc(l.customer_email)}</div></td><td>${esc(l.plan || '—')}</td><td>${l.months} m${l.max_users ? ' · ' + l.max_users + ' usr.' : ''}</td>
        <td><span class="dx-chip ${cls}">${esc(lbl)}</span>${expired ? ' <span class="dx-muted dx-sm">(enlace vencido)</span>' : ''}</td><td class="dx-mono dx-sm">${licFmt(l.created_at)}</td>
        <td style="white-space:nowrap">${l.status === 'pending' ? `<button class="back-btn" style="margin:0 4px 0 0" data-lic="resend" data-id="${l.id}">Nuevo enlace</button><button class="back-btn" style="margin:0;color:var(--danger)" data-lic="revoke" data-id="${l.id}">Anular</button>` : ''}</td></tr>`; }).join('');
    root.innerHTML = `
      <div class="dx-card"><div class="dx-h">Emitir licencia</div>
        <p class="dx-muted dx-sm">${d.emailConfigured ? 'El enlace de activación se envía por correo al cliente.' : '<b>El envío de correo no está configurado</b> (variables SMTP): al emitir verás el enlace para copiarlo y mandarlo tú.'} Es de un solo uso y vence en 14 días.</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:10px">
          <div class="field"><label>Cliente</label><input id="lic-name" placeholder="Nombre o firma"></div>
          <div class="field"><label>Correo</label><input id="lic-email" type="email" placeholder="cliente@correo.com"></div>
          <div class="field"><label>Plan (etiqueta)</label><input id="lic-plan" placeholder="Ej: Completo"></div>
          <div class="field"><label>Meses</label><input id="lic-months" type="number" min="1" max="36" value="1"></div>
          <div class="field"><label>Máx. usuarios</label><input id="lic-max" type="number" min="1" max="500" placeholder="sin tope"></div>
        </div>
        <button class="btn btn-pri" id="lic-create">Emitir y enviar enlace</button> <span id="lic-msg" class="dx-muted"></span>
        <div id="lic-link" style="margin-top:10px"></div></div>
      <div class="dx-card" style="margin-top:14px"><div class="dx-h">Firmas (${tenants.length})</div><div class="table-wrap"><table class="dx-table"><tr><th>Firma</th><th>Plan</th><th>Vence</th><th>Estado</th><th>Usuarios</th><th></th></tr>${tenantRows || '<tr><td colspan="6" class="dx-muted">Sin firmas.</td></tr>'}</table></div>
        <p class="dx-muted dx-sm" style="margin-top:8px">Pasado el vencimiento hay ${d.graceDays} días de gracia; luego la firma no puede entrar (sus datos se conservan). Tu firma no vence.</p></div>
      <div class="dx-card" style="margin-top:14px"><div class="dx-h">Licencias emitidas (${lics.length}${pending.length ? ' · ' + pending.length + ' pendientes' : ''})</div><div class="table-wrap"><table class="dx-table"><tr><th>Cliente</th><th>Plan</th><th>Duración</th><th>Estado</th><th>Emitida</th><th></th></tr>${licRows || '<tr><td colspan="6" class="dx-muted">Aún no has emitido licencias.</td></tr>'}</table></div></div>`;
    const showLink = (link, sent) => { const box = document.getElementById('lic-link'); box.innerHTML = `<div class="dx-card dx-alert" style="border-color:rgba(16,185,129,.4);background:rgba(16,185,129,.07)"><b>${sent ? 'Correo enviado.' : 'Correo no enviado: copia el enlace y mándalo al cliente.'}</b><div class="dx-mono dx-sm" style="word-break:break-all;margin:6px 0">${esc(link)}</div><button class="back-btn" id="lic-copy" style="margin:0">Copiar enlace</button></div>`;
      document.getElementById('lic-copy').onclick = () => { navigator.clipboard?.writeText(link).then(() => toast('Enlace copiado', 'ok')).catch(() => {}); }; };
    document.getElementById('lic-create').onclick = async () => {
      const body = { customer_name: document.getElementById('lic-name').value, customer_email: document.getElementById('lic-email').value, plan: document.getElementById('lic-plan').value, months: document.getElementById('lic-months').value, max_users: document.getElementById('lic-max').value };
      const msg = document.getElementById('lic-msg'); msg.textContent = 'Emitiendo…';
      try { const r = await A.post('/api/licenses/create', body); msg.textContent = ''; toast('Licencia emitida', 'ok'); await DX.openLicenses(); showLink(r.link, r.emailSent); }
      catch (e) { msg.textContent = ''; toast(e.message, 'err'); }
    };
    root.querySelectorAll('[data-lic]').forEach(b => b.addEventListener('click', async () => {
      const act = b.dataset.lic, id = b.dataset.id;
      if (act === 'suspend' && !confirm('¿Suspender esta firma? Sus usuarios no podrán entrar hasta que la reactives.')) return;
      if (act === 'revoke' && !confirm('¿Anular esta licencia pendiente?')) return;
      try {
        const r = await A.post('/api/licenses/' + act, act === 'extend' ? { tenant_id: id, months: Number(b.dataset.m) } : act === 'suspend' || act === 'resume' ? { tenant_id: id } : { id });
        toast('Listo', 'ok'); await DX.openLicenses(); if (r.link) showLink(r.link, r.emailSent);
      } catch (e) { toast(e.message, 'err'); }
    }));
  };

  DX.readUserCompanies = function () {
    const all = document.getElementById('u-all-companies');
    if (!all || all.checked) return null;
    const ids = [];
    document.querySelectorAll('#u-company-list .u-company:checked').forEach(c => c.value.split(',').forEach(id => ids.push(id)));
    return ids;
  };
})();
