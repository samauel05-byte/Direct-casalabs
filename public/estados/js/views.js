/* Estados Financieros — inicio, listas por modalidad y creación de informes. */
(function () {
  const { esc, dateOnly, dateTime } = EF;

  const CURRENCIES = [['DOP', 'DOP · Peso dominicano'], ['USD', 'USD · Dólar'], ['EUR', 'EUR · Euro']];

  EF.views.inicio = {
    title: 'Estados Financieros',
    async render(root) {
      const { reports } = await EF.api('GET', `reports${EF.state.client ? `?client_id=${EF.state.client}` : ''}`);
      const mods = EF.state.me.modalities;
      const count = k => reports.filter(r => r.modality === k).length;
      const open = k => reports.filter(r => r.modality === k && !['aprobado', 'cerrado', 'pendiente_legalizacion'].includes(r.status)).length;
      root.innerHTML = `<div class="stack">
        <div class="card"><p class="muted">Módulo de Contabilidad para preparar, revisar, guardar y exportar estados financieros. Elija una modalidad. Direct <b>no inventa cifras</b>: lo que falta se muestra como pendiente y el informe queda incompleto hasta que se cargue.</p></div>
        <div class="mod-cards">${Object.entries(mods).map(([k, m]) => `<button class="mod-card" data-mod="${k}">
          <h2>${esc(m.label)} ${EF.modTag(k)}</h2><div class="muted">${esc(m.blurb)}</div>
          <div><span class="n">${count(k)}</span> informe(s) · <b>${open(k)}</b> sin aprobar</div></button>`).join('')}</div>
        <div class="card"><h2>Lo que Contabilidad todavía debe entregar</h2>
          <div class="grid cols-2">${Object.entries(mods).map(([k, m]) => `<div><b>${esc(m.label)}</b><ul class="pend">${m.pending_from_accounting.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`).join('')}</div>
          <p class="muted" style="margin-top:8px">Hasta entonces las plantillas, la regla de cuadre y los estados de cierre son propuestas marcadas «por confirmar».</p></div>
        <div class="card"><h2>Últimos informes</h2>${reportsTable(reports.slice(0, 8), true)}</div></div>`;
      root.querySelectorAll('[data-mod]').forEach(b => b.addEventListener('click', () => EF.go(`#/m/${b.dataset.mod}`)));
      bindRows(root);
    },
  };

  function reportsTable(list, withMod) {
    if (!list.length) return '<div class="empty">Todavía no hay informes.</div>';
    return `<div class="table-wrap"><table><tr>${withMod ? '<th>Modalidad</th>' : ''}<th>Informe</th><th>Empresa</th><th>Período / corte</th><th>Estado</th><th class="num">Versión</th><th>Preparó</th><th>Actualizado</th></tr>
      ${list.map(r => `<tr class="clickable" data-open="${r.id}">${withMod ? `<td>${esc(EF.mod(r.modality).singular)}</td>` : ''}<td><b>${esc(r.title)}</b>${r.scenario ? `<br><span class="muted">Escenario: ${esc(r.scenario)}</span>` : ''}${r.fiscal_year ? `<br><span class="muted">Año fiscal ${r.fiscal_year}</span>` : ''}</td>
        <td>${esc(r.client_name)}</td><td>${dateOnly(r.period_start)} – ${dateOnly(r.period_end)}</td><td>${EF.statusBadge(r.status)}</td><td class="num">v${r.version}</td><td>${esc(r.prepared_by_name || '—')}</td><td>${dateTime(r.updated_at)}</td></tr>`).join('')}</table></div>`;
  }
  function bindRows(root) { root.querySelectorAll('tr[data-open]').forEach(tr => tr.addEventListener('click', () => EF.go(`#/r/${tr.dataset.open}`))); }

  EF.views.m = {
    title: k => (EF.mod(k)?.label || 'Informes'),
    async render(root, { arg }) {
      const m = EF.mod(arg);
      if (!m) { root.innerHTML = '<div class="card empty">Modalidad desconocida.</div>'; return; }
      const qs = new URLSearchParams({ modality: arg, ...(EF.state.client ? { client_id: EF.state.client } : {}) });
      const { reports } = await EF.api('GET', `reports?${qs}`);
      const statuses = m.states;
      root.innerHTML = `<div class="stack">
        <div class="card"><div class="row"><div style="flex:1"><b>${esc(m.label)}</b> ${EF.modTag(arg)}<div class="muted">${esc(m.blurb)}</div></div>
          <div class="btn-row">${EF.canEditModality(arg) ? '<button class="btn primary" id="new">+ Nuevo informe</button>' : '<span class="muted">Su rol no permite crear informes de esta modalidad.</span>'}
          <button class="btn" id="tpl">⬇ Plantilla de carga</button></div></div></div>
        <div class="card"><div class="row" style="margin-bottom:8px"><label class="f"><span>Estado</span><select id="f-status"><option value="">Todos</option>${statuses.map(s => `<option value="${s}">${esc(EF.state.me.state_labels[s] || s)}</option>`).join('')}</select></label>
          <span class="muted">${reports.length} informe(s)</span></div><div id="list">${reportsTable(reports, false)}</div></div></div>`;
      const draw = () => { const st = root.querySelector('#f-status').value; root.querySelector('#list').innerHTML = reportsTable(st ? reports.filter(r => r.status === st) : reports, false); bindRows(root); };
      root.querySelector('#f-status').addEventListener('change', draw);
      root.querySelector('#new')?.addEventListener('click', async () => { const id = await EF.newReport(arg); if (id) EF.go(`#/r/${id}`); });
      root.querySelector('#tpl').addEventListener('click', () => EF.downloadTemplate(arg));
      bindRows(root);
    },
  };

  EF.downloadTemplate = async mod => { try { EF.download((await EF.api('GET', `templates/${mod}`)).file); } catch (e) { EF.fail(e); } };

  // Formulario de creación (cada modalidad tiene el suyo).
  EF.newReport = async mod => {
    const m = EF.mod(mod);
    if (!EF.state.clients.length) { EF.toast('No hay empresas disponibles. Cree o asigne una empresa en Direct → Clientes.', 'err'); return null; }
    const today = new Date().toISOString().slice(0, 10);
    const extra = {
      proyectado: `<label class="f"><span>Nombre del escenario *</span><input id="n-scenario" value="Base" maxlength="120"><small class="muted">El escenario base y los demás los define Contabilidad.</small></label>`,
      interino: `<label class="f"><span>Período fiscal al que pertenece *</span><input id="n-fp" maxlength="60" placeholder="Ej.: 2026"></label>`,
      anual: `<label class="f"><span>Año fiscal *</span><input id="n-fy" type="number" min="2000" max="2100" placeholder="Ej.: 2026"></label><label class="f"><span>Período fiscal (opcional)</span><input id="n-fp" maxlength="60"></label>`,
    }[mod];
    const dateLabels = { proyectado: ['Inicio del período proyectado *', 'Fin del período proyectado *'], interino: ['Fecha de inicio *', 'Fecha de corte *'], anual: ['Inicio del año fiscal *', 'Cierre del año fiscal *'] }[mod];
    const r = await EF.modal({ title: `Nuevo informe · ${m.singular}`, okText: 'Crear informe', wide: true,
      body: `<div class="map-grid">
        <label class="f"><span>Empresa *</span><select id="n-client">${EF.clientOptions(EF.state.client)}</select></label>
        <label class="f"><span>Nombre del informe *</span><input id="n-title" maxlength="160"></label>
        ${extra}
        <label class="f"><span>${dateLabels[0]}</span><input id="n-start" type="date"></label>
        <label class="f"><span>${dateLabels[1]}</span><input id="n-end" type="date"></label>
        <label class="f"><span>Moneda *</span><select id="n-cur">${CURRENCIES.map(([c, l]) => `<option value="${c}">${l}</option>`).join('')}</select></label>
        <label class="f"><span>Fecha de preparación</span><input id="n-prep" type="date" value="${today}"></label>
        <label class="f" style="grid-column:1/-1"><span>Notas (opcional)</span><textarea id="n-notes" rows="2" maxlength="4000"></textarea></label></div>
        <p class="muted" style="margin-top:8px">Quedará como <b>${esc(EF.state.me.state_labels[m.initial_state] || m.initial_state)}</b> a su nombre. Los datos se cargan después (Excel/CSV o manual).</p>`,
      onOk: async mdl => {
        const v = id => mdl.querySelector(id)?.value.trim();
        const body = { modality: mod, client_id: v('#n-client'), title: v('#n-title'), currency: v('#n-cur'), prepared_on: v('#n-prep'), period_start: v('#n-start'), period_end: v('#n-end'), notes: v('#n-notes'),
          scenario: v('#n-scenario'), fiscal_period: v('#n-fp'), fiscal_year: v('#n-fy') };
        const out = await EF.api('POST', 'reports', body);
        return out.report.id;
      } });
    return r && r !== true ? r : null;
  };
})();
