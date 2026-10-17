/* Empresas clientes y Consulta RNC. */
(function () {
  const { esc } = NALA;

  async function clientModal(client = null) {
    const c = client || { settings: {} };
    const cat = NALA.state.me.catalogs; const st = c.settings || {};
    return NALA.modal({
      title: client ? 'Editar empresa cliente' : 'Registrar empresa cliente', okText: 'Guardar', wide: true,
      body: `<div class="fields">
        <label class="f full"><span>Razón social</span><input id="c-name" value="${esc(c.legal_name || '')}" maxlength="180" list="nala-empresas-dl" autocomplete="off"></label>
        <datalist id="nala-empresas-dl">${(NALA.state.clients || []).filter(x => x.legal_name).map(x => `<option value="${esc(x.legal_name)}">${esc(x.rnc || x.cedula || '')}</option>`).join('')}</datalist>
        <label class="f"><span>RNC</span><div class="row" style="flex-wrap:nowrap"><input id="c-rnc" value="${esc(c.rnc || '')}" inputmode="numeric" style="flex:1"><button class="btn sm" type="button" id="c-check">Consultar DGII</button></div></label>
        <label class="f"><span>Cédula</span><input id="c-ced" value="${esc(c.cedula || '')}" inputmode="numeric"></label>
        <div class="full muted" id="c-rnc-result"></div>
        <label class="f"><span>Correo</span><input id="c-email" value="${esc(c.email || '')}"></label>
        <label class="f"><span>Teléfono</span><input id="c-phone" value="${esc(c.phone || '')}"></label>
        ${client ? `<label class="f"><span>Estado</span><select id="c-status"><option value="active" ${c.status !== 'inactive' ? 'selected' : ''}>Activa</option><option value="inactive" ${c.status === 'inactive' ? 'selected' : ''}>Inactiva</option></select></label>` : ''}
        <div class="full" style="margin-top:6px"><b>Configuración contable</b> <span class="muted">(valores sugeridos al extraer; siempre los confirma un humano)</span></div>
        <label class="f"><span>606 · Tipo de bienes y servicios</span><select id="c-tbs">${NALA.catalogOptions(cat.tipoBienesServicios, st.default_tipo_bienes_servicios)}</select></label>
        <label class="f"><span>607 · Tipo de ingreso</span><select id="c-ti">${NALA.catalogOptions(cat.tipoIngreso, st.default_tipo_ingreso)}</select></label>
        <label class="f"><span>606 · Subtotal sin desglose va a</span><select id="c-split"><option value="">Decide el auditor</option><option value="servicios" ${st.default_split === 'servicios' ? 'selected' : ''}>Servicios</option><option value="bienes" ${st.default_split === 'bienes' ? 'selected' : ''}>Bienes</option></select></label>
        <label class="f"><span>Cierre fiscal</span><select id="c-cierre"><option value="">—</option>${['03', '06', '09', '12'].map(m => `<option ${st.cierre_fiscal === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label class="f"><span>Régimen</span><input id="c-reg" value="${esc(st.regimen || '')}" placeholder="Normal, RST…"></label>
        <label class="f"><span>Actividad</span><input id="c-act" value="${esc(st.actividad || '')}"></label>
        <label class="f full"><span>Formatos que reporta</span><div class="row">${['606', '607'].map(f => `<label><input type="checkbox" class="c-fmt" value="${f}" ${(st.formatos || ['606', '607']).includes(f) ? 'checked' : ''}> ${f}</label>`).join('')}</div></label>
        <label class="f full"><span>Notas</span><textarea id="c-notes" rows="2">${esc(st.notas || '')}</textarea></label>
      </div>`,
      onOk: async m => {
        const v = id => m.querySelector(id)?.value ?? '';
        const body = { legal_name: v('#c-name'), rnc: v('#c-rnc'), cedula: v('#c-ced'), email: v('#c-email'), phone: v('#c-phone'),
          settings: { default_tipo_bienes_servicios: v('#c-tbs') || null, default_tipo_ingreso: v('#c-ti') || null, default_split: v('#c-split') || null, cierre_fiscal: v('#c-cierre') || null,
            regimen: v('#c-reg'), actividad: v('#c-act'), notas: v('#c-notes'), formatos: [...m.querySelectorAll('.c-fmt:checked')].map(x => x.value) } };
        if (client) body.status = v('#c-status');
        const r = client ? await NALA.api('PATCH', `clients/${client.id}`, body) : await NALA.api('POST', 'clients', body);
        NALA.toast('Empresa guardada', 'ok');
        return r.client;
      },
    });
  }

  function wireRncCheck() {
    // Delegated: the modal is created asynchronously.
    document.addEventListener('click', async e => {
      if (e.target.id !== 'c-check') return;
      const out = document.getElementById('c-rnc-result');
      const val = document.getElementById('c-rnc').value || document.getElementById('c-ced').value;
      out.textContent = 'Consultando…';
      try {
        const r = await NALA.api('GET', `rnc/${encodeURIComponent(val)}`);
        out.innerHTML = rncSummary(r, true);
        out.querySelector('[data-use-name]')?.addEventListener('click', ev => { document.getElementById('c-name').value = ev.target.dataset.useName; });
      } catch (err) { out.textContent = err.message; }
    });
  }
  wireRncCheck();

  // Guía central de empresas: en el formulario de cliente, al escribir/elegir el
  // nombre de una empresa ya registrada se rellena su RNC (y cédula), y al
  // escribir un RNC conocido se rellena el nombre. Usa NALA.state.clients (la
  // misma guía de la firma). Solo rellena campos vacíos, nunca pisa lo escrito.
  document.addEventListener('input', e => {
    const list = NALA.state.clients || [];
    if (e.target.id === 'c-name') {
      const c = list.find(x => x.legal_name && x.legal_name.toLowerCase() === e.target.value.trim().toLowerCase());
      if (!c) return;
      const rncEl = document.getElementById('c-rnc'); const cedEl = document.getElementById('c-ced');
      if (rncEl && c.rnc && !rncEl.value.trim()) rncEl.value = c.rnc;
      if (cedEl && c.cedula && !cedEl.value.trim()) cedEl.value = c.cedula;
    } else if (e.target.id === 'c-rnc') {
      const d = (e.target.value || '').replace(/\D/g, '');
      if (!d) return;
      const c = list.find(x => String(x.rnc || '') === d);
      const nameEl = document.getElementById('c-name');
      if (c && nameEl && !nameEl.value.trim()) nameEl.value = c.legal_name;
    }
  });

  function rncSummary(r, compact = false) {
    const s = r.structure; const o = r.official;
    const structure = s.structureValid ? `<span class="badge ok">Estructura válida · ${s.kind === 'rnc' ? 'RNC (9)' : 'Cédula (11)'}</span>` : `<span class="badge crit">Estructura inválida</span> ${esc(s.message)}`;
    const digit = s.structureValid ? (s.checkDigitValid ? '<span class="badge ok">Dígito verificador correcto</span>' : '<span class="badge warn">Dígito verificador no coincide</span>') : '';
    let official = '<span class="badge">Sin consulta oficial</span>';
    if (o?.status === 'ok' && o.found) official = `<span class="badge ok">DGII: ${esc(o.data.estado || 'inscrito')}</span> <b>${esc(o.data.nombre || '')}</b>${compact ? ` <button class="btn sm" type="button" data-use-name="${esc(o.data.nombre || '')}">Usar nombre</button>` : ''}`;
    else if (o?.status === 'ok') official = `<span class="badge crit">DGII: ${esc(o.data?.message || 'No inscrito')}</span>`;
    else if (o?.status === 'unavailable') official = `<span class="badge warn">DGII no disponible</span> ${esc(o.message)}`;
    return `${structure} ${digit}<br>${official}${o?.fetched_at ? ` <span class="muted">· ${esc(o.source)} · ${NALA.dateTime(o.fetched_at)}${o.cached ? ' (caché)' : ''}</span>` : ''}`;
  }

  NALA.views.clientes = {
    title: 'Empresas clientes',
    async render(root) {
      const canManage = NALA.can('clients_manage');
      root.innerHTML = `<div class="stack">
        <div style="position:relative">
          <svg style="position:absolute;left:13px;top:50%;transform:translateY(-50%);pointer-events:none;opacity:.55" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input id="cq" placeholder="Buscar empresa por nombre, RNC o cédula…" autocomplete="off" style="width:100%;box-sizing:border-box;padding:12px 14px 12px 42px;font-size:15px;border-radius:10px">
        </div>
        <div class="row">
          <label class="f"><span>Estado</span><select id="cs"><option value="">Todas</option><option value="active">Activas</option><option value="inactive">Inactivas</option></select></label>
          ${canManage ? '<button class="btn primary" id="cnew" style="margin-left:auto">+ Registrar empresa</button>' : ''}
        </div>
        <div id="ctable"></div></div>`;
      // Filters on each column of the table (like Excel) plus sorting by
      // clicking a title; applied on the list already loaded.
      const colFilter = { name: '', id: '', status: '', config: '', source: '' };
      let sort = { key: 'name', dir: 1 };
      let clients = [];
      const configOf = c => ({ has606: !!c.settings?.default_tipo_bienes_servicios, has607: !!c.settings?.default_tipo_ingreso });
      const draw = () => {
        const cat = NALA.state.me.catalogs;
        const norm = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const sources = [...new Set(clients.map(c => c.source).filter(Boolean))].sort();
        const rows = clients.filter(c => {
          const cfg = configOf(c);
          if (colFilter.name && !norm(`${c.legal_name} ${c.email || ''}`).includes(norm(colFilter.name))) return false;
          if (colFilter.id && !String(c.rnc || c.cedula || '').includes(colFilter.id.replace(/\D/g, ''))) return false;
          if (colFilter.status && (c.status === 'inactive' ? 'inactive' : 'active') !== colFilter.status) return false;
          if (colFilter.config === 'complete' && !(cfg.has606 && cfg.has607)) return false;
          if (colFilter.config === 'missing' && cfg.has606 && cfg.has607) return false;
          if (colFilter.config === 'no606' && cfg.has606) return false;
          if (colFilter.config === 'no607' && cfg.has607) return false;
          if (colFilter.source && c.source !== colFilter.source) return false;
          return true;
        });
        const val = { name: c => norm(c.legal_name), id: c => String(c.rnc || c.cedula || ''), status: c => c.status || 'active', config: c => Number(configOf(c).has606) + Number(configOf(c).has607), source: c => c.source || '' };
        rows.sort((a, b) => { const x = val[sort.key](a); const y = val[sort.key](b); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir; });
        const th = (key, label) => `<th class="sortable" data-sort="${key}" style="cursor:pointer;user-select:none">${label} <span class="muted">${sort.key === key ? (sort.dir > 0 ? '▲' : '▼') : '↕'}</span></th>`;
        const sel = (key, options) => `<select data-cf="${key}" style="width:100%">${options.map(([v, l]) => `<option value="${esc(v)}" ${colFilter[key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
        root.querySelector('#ctable').innerHTML = `<div class="table-wrap"><table>
          <tr>${th('name', 'Empresa')}${th('id', 'RNC / Cédula')}${th('status', 'Estado')}${th('config', 'Configuración contable')}${th('source', 'Origen')}<th></th></tr>
          <tr class="filters">
            <th><input data-cf="name" placeholder="Filtrar empresa…" value="${esc(colFilter.name)}" style="width:100%"></th>
            <th><input data-cf="id" placeholder="RNC o cédula…" inputmode="numeric" value="${esc(colFilter.id)}" style="width:100%"></th>
            <th>${sel('status', [['', 'Todas'], ['active', 'Activas'], ['inactive', 'Inactivas']])}</th>
            <th>${sel('config', [['', 'Todas'], ['complete', '606 y 607 configurados'], ['missing', 'Falta configurar'], ['no606', 'Sin 606'], ['no607', 'Sin 607']])}</th>
            <th>${sel('source', [['', 'Todos'], ...sources.map(x => [x, x])])}</th>
            <th class="num muted">${rows.length} de ${clients.length}${Object.values(colFilter).some(Boolean) ? ' <button class="btn sm" id="cf-clear">Quitar filtros</button>' : ''}</th></tr>
          ${rows.length ? rows.map(c => `<tr><td><b>${esc(c.legal_name)}</b>${c.email ? `<div class="muted">${esc(c.email)}</div>` : ''}</td><td class="mono">${esc(c.rnc || c.cedula || '—')}</td>
            <td>${c.status === 'inactive' ? '<span class="badge">Inactiva</span>' : '<span class="badge ok">Activa</span>'}</td>
            <td class="muted">${c.settings?.default_tipo_bienes_servicios ? `606: ${esc(cat.tipoBienesServicios[c.settings.default_tipo_bienes_servicios])}` : '606: —'}<br>${c.settings?.default_tipo_ingreso ? `607: ${esc(cat.tipoIngreso[c.settings.default_tipo_ingreso])}` : '607: —'}</td>
            <td>${esc(c.source)}</td><td class="num"><button class="btn sm" data-use="${c.id}">Activar</button> ${canManage ? `<button class="btn sm" data-edit="${c.id}">Editar</button>` : ''}</td></tr>`).join('')
          : '<tr><td colspan="6" class="empty">No hay empresas que coincidan con los filtros.</td></tr>'}</table></div>`;
        root.querySelectorAll('[data-sort]').forEach(h => h.addEventListener('click', () => { sort = { key: h.dataset.sort, dir: sort.key === h.dataset.sort ? -sort.dir : 1 }; draw(); }));
        root.querySelectorAll('select[data-cf]').forEach(el => el.addEventListener('change', () => { colFilter[el.dataset.cf] = el.value; draw(); }));
        root.querySelectorAll('input[data-cf]').forEach(el => el.addEventListener('input', () => {
          colFilter[el.dataset.cf] = el.value; const pos = el.selectionStart; draw();
          const again = root.querySelector(`input[data-cf="${el.dataset.cf}"]`); again.focus(); again.setSelectionRange(pos, pos);
        }));
        root.querySelector('#cf-clear')?.addEventListener('click', () => { Object.keys(colFilter).forEach(k => { colFilter[k] = ''; }); draw(); });
        root.querySelectorAll('[data-use]').forEach(b => b.addEventListener('click', () => { NALA.setScope({ client: b.dataset.use }); NALA.go('#/empresa'); }));
        root.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', async () => {
          const saved = await clientModal(clients.find(c => c.id === b.dataset.edit));
          if (saved) { await NALA.loadClients(); load(); }
        }));
      };
      const load = async () => {
        const qs = new URLSearchParams({ q: root.querySelector('#cq').value, status: root.querySelector('#cs').value });
        clients = (await NALA.api('GET', `clients?${qs}`)).clients;
        if (!clients.length) { root.querySelector('#ctable').innerHTML = '<div class="card empty">No hay empresas que coincidan.</div>'; return; }
        draw();
      };
      let timer;
      root.querySelector('#cq').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
      root.querySelector('#cs').addEventListener('change', load);
      root.querySelector('#cnew')?.addEventListener('click', async () => { const saved = await clientModal(); if (saved) { await NALA.loadClients(); load(); } });
      await load();
    },
  };

  function age(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const now = new Date(); let years = now.getFullYear() - y; let months = now.getMonth() + 1 - m;
    if (now.getDate() < d) months -= 1;
    if (months < 0) { years -= 1; months += 12; }
    const parts = [years ? `${years} año${years === 1 ? '' : 's'}` : '', months ? `${months} mes${months === 1 ? '' : 'es'}` : ''].filter(Boolean);
    return { date: `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`, text: parts.join(' y ') || 'menos de un mes' };
  }

  NALA.views.rnc = {
    title: 'Consulta RNC',
    async render(root, { params }) {
      root.innerHTML = `<div class="stack" style="max-width:760px">
        <div class="card"><h2>Consulta de RNC o cédula</h2>
          <p class="muted" style="margin-bottom:10px">Muestra de quién es el RNC, su estado, actividad, régimen, antigüedad y cumplimiento según la DGII. NALA distingue tres comprobaciones: la <b>estructura</b> (cantidad de dígitos), el <b>dígito verificador</b> (algoritmo de las herramientas DGII) y la <b>consulta oficial</b> a la DGII (Consulta RNC de dgii.gov.do). Sólo la consulta oficial indica si el contribuyente está inscrito y su estado.</p>
          <form class="row" id="rf"><label class="f" style="flex:1"><span>RNC o cédula</span><input id="rv" inputmode="numeric" placeholder="101010632" value="${esc(params.id || '')}"></label><button class="btn primary">Consultar</button></form></div>
        <div id="rres"></div></div>`;
      const run = async refresh => {
        const v = root.querySelector('#rv').value.trim(); if (!v) return;
        const out = root.querySelector('#rres'); out.innerHTML = '<div class="card empty">Consultando a la DGII…</div>';
        try {
          const r = await NALA.api('GET', `rnc/${encodeURIComponent(v)}${refresh ? '?refresh=1' : ''}`);
          const s = r.structure; const o = r.official;
          const rows = o?.status === 'ok' && o.found ? Object.entries(o.data).map(([k, val]) => `<tr><th style="position:static">${esc(k.replace(/_/g, ' '))}</th><td>${esc(val)}</td></tr>`).join('') : '';
          const known = (NALA.state.clients || []).find(c => c.rnc === s.digits || c.cedula === s.digits);
          const reg = r.registry; const of = o?.status === 'ok' && o.found ? o.data : null;
          const since = reg?.found && reg.fecha_constitucion ? age(reg.fecha_constitucion) : null;
          const estado = of?.estado || reg?.estado;
          const estadoCls = /ACTIVO/i.test(estado || '') ? 'ok' : (estado ? 'crit' : '');
          const summary = (of || reg?.found) ? `<div class="card" style="margin-bottom:12px"><h2>${esc(of?.nombre || reg?.nombre || '')}${estado ? ` <span class="badge ${estadoCls}">${esc(estado)}</span>` : ''}</h2>
            <div class="grid kpis">
              <div class="kpi"><div class="label">Nombre comercial</div><div>${esc(of?.nombre_comercial || reg?.nombre_comercial || '—')}</div></div>
              <div class="kpi"><div class="label">Actividad económica</div><div>${esc(of?.actividad_economica || reg?.actividad || '—')}</div></div>
              <div class="kpi"><div class="label">Régimen de pagos</div><div>${esc(of?.regimen_pagos || reg?.regimen || '—')}</div></div>
              <div class="kpi"><div class="label">${s.kind === 'rnc' ? 'Fecha de constitución' : 'Inicio de operaciones'}</div><div>${since ? `<b>${esc(since.date)}</b><br><span class="muted">hace ${esc(since.text)}</span>` : '—'}</div></div>
              <div class="kpi"><div class="label">Facturador electrónico</div><div>${esc(of?.facturador_electronico || '—')}</div></div>
            </div></div>` : '';
          out.innerHTML = `${summary}<div class="grid cols-2">
            <div class="card"><h2>1 · Estructura</h2>${s.structureValid ? `<span class="badge ok">Válida</span> ${s.kind === 'rnc' ? 'RNC de 9 dígitos (Tipo Id 1)' : 'Cédula de 11 dígitos (Tipo Id 2)'}` : `<span class="badge crit">Inválida</span> ${esc(s.message)}`}</div>
            <div class="card"><h2>2 · Dígito verificador</h2>${s.structureValid ? (s.checkDigitValid ? '<span class="badge ok">Correcto</span>' : '<span class="badge warn">No coincide</span> <span class="muted">Puede ser un error de digitación; confirme con la consulta oficial.</span>') : '<span class="muted">No aplica</span>'}</div></div>
            <div class="card" style="margin-top:12px"><h2>3 · Consulta oficial DGII<span class="spacer"></span>${s.structureValid ? '<button class="btn sm" id="rrefresh">Consultar de nuevo</button>' : ''}</h2>
              ${!o ? '<span class="muted">No se consulta una identificación con estructura inválida.</span>'
                : o.status === 'unavailable' ? `<div class="issue warning"><span class="ico">!</span><div>${esc(o.message)}${o.stale ? `<br>Último dato guardado (${NALA.dateTime(o.stale.fetched_at)}): ${o.stale.found ? esc(o.stale.data?.nombre) : 'no inscrito'}` : ''}<br>NALA no marca el RNC como verificado sin respuesta oficial.</div></div>`
                : o.found ? `<div class="table-wrap"><table>${rows}</table></div>` : `<div class="issue critical"><span class="ico">✕</span>${esc(o.data?.message || 'No inscrito')}</div>`}
              ${o?.fetched_at ? `<p class="muted" style="margin-top:8px">Fuente: <a href="${esc(o.source_url)}" target="_blank" rel="noopener">${esc(o.source)}</a> · ${NALA.dateTime(o.fetched_at)}${o.cached ? ' · resultado guardado (máx. 24 h)' : ''}</p>` : ''}
              ${o?.found && !known && NALA.can('clients_manage') ? `<button class="btn primary" id="radd" style="margin-top:8px">Registrar como empresa cliente</button>` : ''}
              ${known ? `<p style="margin-top:8px"><span class="badge ok">✓ Registrada</span> Ya es una empresa cliente: <b>${esc(known.legal_name)}</b>. <button class="btn sm" id="rgo">Ver en Empresas clientes</button> <button class="btn sm primary" id="ropen">Abrir su panel</button></p>` : ''}
            </div>
            <div class="card" style="margin-top:12px"><h2>4 · Antigüedad (archivo oficial de RNC)</h2>
              ${!reg ? '<span class="muted">No aplica.</span>' : reg.status === 'unavailable' ? `<div class="issue warning"><span class="ico">!</span>${esc(reg.message)}</div>`
                : !reg.found ? '<span class="muted">No aparece en el archivo de RNC publicado por la DGII.</span>'
                : `${since ? `${s.kind === 'rnc' ? 'Constituida' : 'Inicio de operaciones'} el <b>${esc(since.date)}</b> — hace <b>${esc(since.text)}</b>.` : 'El archivo no indica fecha de constitución o inicio de operaciones.'}
                  <p class="muted" style="margin-top:6px">La DGII publica la fecha de constitución (empresas) o de inicio de operaciones (personas), no la fecha de inscripción del RNC. Fuente: <a href="${esc(reg.source_url)}" target="_blank" rel="noopener">${esc(reg.source)}</a>${reg.file_date ? ` · publicado ${esc(NALA.dateTime(reg.file_date))}` : ''}.</p>`}</div>
            <div class="card" style="margin-top:12px"><h2>5 · Cumplimiento con la DGII</h2><div class="stack" style="gap:6px">
              ${estado ? `<div class="issue ${estadoCls === 'ok' ? 'info' : 'critical'}"><span class="ico">${estadoCls === 'ok' ? '✓' : '✕'}</span>Estado en la DGII: <b>${esc(estado)}</b>${estadoCls === 'ok' ? '' : ' — no está activo; sus comprobantes pueden ser rechazados.'}</div>` : ''}
              ${o?.adecuacion ? `<div class="issue ${o.adecuacion.status === 'pendiente' ? 'warning' : 'info'}"><span class="ico">${o.adecuacion.status === 'pendiente' ? '!' : '✓'}</span>${esc(o.adecuacion.message)}</div>` : ''}
              <div class="issue warning"><span class="ico">🔒</span><span><b>Deudas y si está al día:</b> ${esc(r.debts.message)}</span></div></div></div>`;
          out.querySelector('#rrefresh')?.addEventListener('click', () => run(true));
          out.querySelector('#radd')?.addEventListener('click', async ev => {
            const btn = ev.target; btn.disabled = true; const prev = btn.textContent; btn.textContent = 'Registrando…';
            try {
              await NALA.api('POST', 'clients', { legal_name: o.data.nombre, [s.kind === 'rnc' ? 'rnc' : 'cedula']: s.digits });
              await NALA.loadClients();
              NALA.toast('Registrada como empresa cliente', 'ok');
              run(false); // re-dibuja: ahora aparece el aviso "✓ Registrada" con los atajos
            } catch (err) {
              btn.disabled = false; btn.textContent = prev;
              NALA.toast(err.message || 'No se pudo registrar la empresa', 'err');
            }
          });
          out.querySelector('#rgo')?.addEventListener('click', () => NALA.go('#/clientes'));
          out.querySelector('#ropen')?.addEventListener('click', () => { if (known) { NALA.setScope({ client: known.id }); NALA.go('#/empresa'); } });
        } catch (e) { out.innerHTML = `<div class="card empty">⚠️ ${esc(e.message)}</div>`; }
      };
      root.querySelector('#rf').addEventListener('submit', e => { e.preventDefault(); run(false); });
      if (params.id) run(false);
    },
  };
})();
