/* Estados Financieros — plantillas y pendientes, configuración (Contabilidad) y equipo/permisos. */
(function () {
  const { esc } = EF;

  EF.views.plantillas = {
    title: 'Plantillas y pendientes',
    async render(root) {
      const mods = EF.state.me.modalities;
      root.innerHTML = `<div class="stack"><div class="card"><p class="muted">Cada modalidad tiene su plantilla de carga. Son <b>propuestas sin cifras</b>: las columnas finales las confirma Contabilidad. En la carga puede asociar las columnas de su archivo con los campos de Direct, así que no hace falta que coincidan exactamente.</p></div>
        ${Object.entries(mods).map(([k, m]) => `<div class="card"><h2>${esc(m.label)} ${EF.modTag(k)}<span class="spacer"></span><button class="btn sm primary" data-tpl="${k}">⬇ Plantilla de ${esc(m.label)}</button></h2>
          <div class="grid cols-2"><div><b>Columnas propuestas</b> <span class="badge warn">por confirmar</span><div class="table-wrap"><table><tr><th>Columna</th><th>Obligatoria</th><th>Qué lleva</th></tr>${m.fields.map(f => `<tr><td>${esc(f.label)}</td><td>${f.required ? 'Sí' : 'No'}</td><td class="muted">${esc(f.hint)}</td></tr>`).join('')}</table></div></div>
          <div><b>Falta que Contabilidad entregue</b><ul class="pend">${m.pending_from_accounting.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div></div></div>`).join('')}</div>`;
      root.querySelectorAll('[data-tpl]').forEach(b => b.addEventListener('click', () => EF.downloadTemplate(b.dataset.tpl)));
    },
  };

  EF.views.config = {
    title: 'Configuración',
    async render(root) {
      const { config: cfg } = await EF.api('GET', 'config');
      const labels = EF.state.me.state_labels; const mods = EF.state.me.modalities;
      const allStates = Object.keys(labels);
      root.innerHTML = `<div class="stack"><div class="card"><p class="muted">Aquí Contabilidad ajusta el flujo y las reglas. Lo que no esté confirmado queda marcado como pendiente. Los cambios aplican a los informes nuevos y a los cambios de estado futuros.</p></div>
        <div class="card"><h2>Estados del flujo</h2><p class="muted">Nombres de los estados. «Pendiente de legalización» queda apagado hasta que Contabilidad confirme que aplica y explique los pasos, documentos y aprobaciones.</p>
          <div class="map-grid">${allStates.map(k => `<label class="f"><span>${esc(k)}</span><input data-lbl="${k}" value="${esc(cfg.labels[k] || '')}" maxlength="60"></label>`).join('')}</div>
          <label style="display:block;margin-top:8px"><input type="checkbox" id="leg-on" ${cfg.legalizacion.enabled ? 'checked' : ''}> El estado «pendiente de legalización» aplica (después de «cerrado», solo informe del año)</label>
          <label class="f" style="margin-top:6px"><span>Proceso de legalización (pasos, documentos, aprobaciones — por definir por Contabilidad)</span><textarea id="leg-notes" rows="3" maxlength="2000">${esc(cfg.legalizacion.notes)}</textarea></label></div>
        <div class="card"><h2>Cuadre de débitos y créditos</h2>
          <div class="map-grid"><label class="f"><span>Regla</span><select id="br"><option value="por_asiento" ${cfg.balance_rule === 'por_asiento' ? 'selected' : ''}>Por asiento (agrupa por referencia)</option><option value="global" ${cfg.balance_rule === 'global' ? 'selected' : ''}>Global (total débitos = total créditos)</option><option value="ninguna" ${cfg.balance_rule === 'ninguna' ? 'selected' : ''}>No validar cuadre</option></select></label>
            <label class="f"><span>Tolerancia (diferencia permitida)</span><input id="bt" inputmode="decimal" value="${cfg.balance_tolerance}"></label></div>
          <label style="display:block;margin-top:6px"><input type="checkbox" id="brc" ${cfg.balance_rule_confirmed ? 'checked' : ''}> Contabilidad confirmó esta regla (si no, se muestra como provisional)</label></div>
        <div class="card"><h2>Comparaciones</h2><label><input type="checkbox" id="cmp" ${cfg.compare_enabled ? 'checked' : ''}> Habilitar comparaciones entre informes (solo cuando Contabilidad lo solicite y haya datos suficientes)</label></div>
        <div class="card"><h2>Datos de la firma (portada, informe del contador y pie de página)</h2><p class="muted">Salen en el paquete de estados financieros que se imprime. Los puede cambiar en cada informe.</p>
          <div class="map-grid"><label class="f"><span>Nombre de la firma (pie de cada página)</span><input id="fm-name" maxlength="120" value="${esc(cfg.firm.name)}" placeholder="SAVE CONSULTORES SRL"></label>
            <label class="f"><span>Teléfonos</span><input id="fm-phones" maxlength="160" value="${esc(cfg.firm.phones)}"></label>
            <label class="f" style="grid-column:1/-1"><span>Dirección</span><input id="fm-addr" maxlength="300" value="${esc(cfg.firm.address)}"></label>
            <label class="f"><span>Firmante (nombre)</span><input id="fm-sn" maxlength="120" value="${esc(cfg.firm.signer.name)}"></label><label class="f"><span>Título (Licda., Lic., CPA…)</span><input id="fm-st" maxlength="120" value="${esc(cfg.firm.signer.title)}"></label>
            <label class="f"><span>Exequátur</span><input id="fm-se" maxlength="60" value="${esc(cfg.firm.signer.exequatur)}"></label><label class="f"><span>ICPARD</span><input id="fm-si" maxlength="60" value="${esc(cfg.firm.signer.icpard)}"></label>
            <label class="f"><span>Ciudad</span><input id="fm-sc" maxlength="120" value="${esc(cfg.firm.signer.city)}"></label></div>
          <div class="row" style="margin-top:8px"><label class="btn sm">🖼 Logo de la firma (PNG o JPG, máx. 250 KB)<input id="fm-logo" type="file" accept="image/png,image/jpeg" hidden></label><img id="fm-logo-img" alt="" style="max-height:60px;display:${cfg.firm.logo ? 'block' : 'none'}" src="${cfg.firm.logo}"><button class="btn sm" id="fm-logo-del" type="button" ${cfg.firm.logo ? '' : 'hidden'}>Quitar logo</button></div>
          <label class="f" style="margin-top:8px"><span>Texto del informe del contador (variables: {EMPRESA} {RNC} {DESDE} {HASTA} {ANIO} {TIPO} {TIPOS}; línea en blanco = nuevo párrafo)</span><textarea id="fm-txt" rows="9" maxlength="4000">${esc(cfg.firm.informe_text)}</textarea></label></div>
        <div class="card"><h2>Documentos de cada modalidad</h2><p class="muted">Balance, resultados, flujos u otros que Contabilidad defina. Se copian a cada informe nuevo y los obligatorios deben estar «incluidos» para poder aprobar.</p>
          ${Object.keys(mods).map(k => `<div style="margin-top:8px"><b>${esc(mods[k].label)}</b><div data-docs="${k}"></div><button class="btn sm" data-adddoc="${k}">+ Agregar documento</button></div>`).join('')}</div>
        <div class="btn-row"><button class="btn primary" id="save">Guardar configuración</button></div></div>`;
      const docs = JSON.parse(JSON.stringify(cfg.documents));
      const drawDocs = () => Object.keys(mods).forEach(k => {
        root.querySelector(`[data-docs="${k}"]`).innerHTML = docs[k].length ? docs[k].map((d, i) => `<div class="row" style="margin:4px 0"><input data-dl="${k}:${i}" value="${esc(d.label)}" maxlength="120" style="flex:1"><label><input type="checkbox" data-dr="${k}:${i}" ${d.required ? 'checked' : ''}> obligatorio</label><button class="btn sm danger" data-dx="${k}:${i}">Quitar</button></div>`).join('') : '<div class="muted">Sin definir (pendiente de Contabilidad).</div>';
        root.querySelectorAll(`[data-dx^="${k}:"]`).forEach(b => b.addEventListener('click', () => { collect(); docs[k].splice(Number(b.dataset.dx.split(':')[1]), 1); drawDocs(); }));
      });
      const collect = () => { for (const k of Object.keys(mods)) docs[k] = docs[k].map((d, i) => ({ ...d, label: root.querySelector(`[data-dl="${k}:${i}"]`)?.value ?? d.label, required: root.querySelector(`[data-dr="${k}:${i}"]`)?.checked ?? d.required })); };
      drawDocs();
      root.querySelectorAll('[data-adddoc]').forEach(b => b.addEventListener('click', () => { collect(); const k = b.dataset.adddoc; docs[k].push({ key: `doc_${Date.now().toString(36)}`, label: 'Nuevo documento', required: true }); drawDocs(); }));
      let logo = cfg.firm.logo;
      root.querySelector('#fm-logo').addEventListener('change', e => { const f = e.target.files[0]; if (!f) return; if (f.size > 250 * 1024) { EF.toast('El logo pesa más de 250 KB. Use una imagen más liviana.', 'err'); return; } const rd = new FileReader(); rd.onload = () => { logo = String(rd.result); const im = root.querySelector('#fm-logo-img'); im.src = logo; im.style.display = 'block'; root.querySelector('#fm-logo-del').hidden = false; }; rd.readAsDataURL(f); });
      root.querySelector('#fm-logo-del').addEventListener('click', () => { logo = ''; root.querySelector('#fm-logo-img').style.display = 'none'; root.querySelector('#fm-logo-del').hidden = true; });
      root.querySelector('#save').addEventListener('click', async () => {
        collect();
        const next = { ...cfg, labels: Object.fromEntries([...root.querySelectorAll('[data-lbl]')].map(i => [i.dataset.lbl, i.value])), legalizacion: { enabled: root.querySelector('#leg-on').checked, notes: root.querySelector('#leg-notes').value },
          balance_rule: root.querySelector('#br').value, balance_tolerance: Number(root.querySelector('#bt').value), firm: { name: root.querySelector('#fm-name').value, phones: root.querySelector('#fm-phones').value, address: root.querySelector('#fm-addr').value, logo, signer: { name: root.querySelector('#fm-sn').value, title: root.querySelector('#fm-st').value, exequatur: root.querySelector('#fm-se').value, icpard: root.querySelector('#fm-si').value, city: root.querySelector('#fm-sc').value }, informe_text: root.querySelector('#fm-txt').value }, balance_rule_confirmed: root.querySelector('#brc').checked, compare_enabled: root.querySelector('#cmp').checked, documents: docs };
        next.states = { ...cfg.states, anual: next.legalizacion.enabled ? [...new Set([...cfg.states.anual, 'pendiente_legalizacion'])] : cfg.states.anual.filter(s => s !== 'pendiente_legalizacion') };
        try { await EF.api('PUT', 'config', { config: next }); EF.state.me = await EF.api('GET', 'me'); EF.toast('Configuración guardada', 'ok'); EF.route(); } catch (e) { EF.fail(e); }
      });
    },
  };

  EF.views.equipo = {
    title: 'Equipo y permisos',
    async render(root) {
      const t = await EF.api('GET', 'team');
      root.innerHTML = `<div class="stack"><div class="card"><p class="muted">Aquí se asigna el rol y las empresas de cada persona. Para que alguien vea el módulo, primero se le activa «Estados Financieros» en Direct → Usuarios. Quien tiene acceso y aún no tiene rol entra como <b>Solo lectura</b>.</p>
        <div class="table-wrap"><table><tr><th>Rol</th>${t.all_permissions.map(p => `<th>${esc(t.permission_labels[p])}</th>`).join('')}</tr>${t.roles.map(r => `<tr><td><b>${esc(r.label)}</b></td>${t.all_permissions.map(p => `<td>${r.permissions.includes(p) ? '✓' : ''}</td>`).join('')}</tr>`).join('')}</table></div></div>
        <div class="card"><h2>Personas</h2><div class="table-wrap"><table><tr><th>Persona</th><th>Rol</th><th>Empresas</th><th></th></tr>${t.members.map(m => `<tr><td><b>${esc(m.username)}</b></td><td>${esc(m.role_label)}</td><td>${m.app_role === 'admin' || m.all_clients ? 'Todas' : `${m.client_ids.length} asignada(s)`}</td><td>${m.app_role === 'admin' ? '<span class="muted">Administrador: todos los permisos</span>' : `<button class="btn sm" data-edit="${m.user_id}">Configurar</button>`}</td></tr>`).join('')}</table></div></div></div>`;
      root.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', async () => {
        const m = t.members.find(x => x.user_id === b.dataset.edit);
        const ok = await EF.modal({ title: `Permisos de ${m.username}`, okText: 'Guardar', wide: true, body: `<div class="map-grid"><label class="f"><span>Rol</span><select id="m-role">${t.roles.map(r => `<option value="${r.key}" ${r.key === m.fin_role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>
            <label class="f"><span>Empresas</span><select id="m-all"><option value="1" ${m.all_clients ? 'selected' : ''}>Todas las empresas</option><option value="0" ${!m.all_clients ? 'selected' : ''}>Solo las asignadas</option></select></label></div>
          <div id="m-clients" style="margin-top:8px" ${m.all_clients ? 'hidden' : ''}><b>Empresas asignadas</b><div class="map-grid">${EF.state.clients.map(c => `<label><input type="checkbox" data-c="${c.id}" ${m.client_ids.includes(c.id) ? 'checked' : ''}> ${esc(c.legal_name)}</label>`).join('')}</div></div>
          <div style="margin-top:8px"><b>Ajustes puntuales sobre el rol</b> <span class="muted">(vacío = según el rol)</span><div class="map-grid">${t.all_permissions.filter(p => p !== 'team_manage').map(p => `<label class="f"><span>${esc(t.permission_labels[p])}</span><select data-p="${p}"><option value="">Según el rol</option><option value="1" ${m.overrides[p] === true ? 'selected' : ''}>Permitir</option><option value="0" ${m.overrides[p] === false ? 'selected' : ''}>Quitar</option></select></label>`).join('')}</div></div>`,
          onOpen: mdl => mdl.querySelector('#m-all').addEventListener('change', e => { mdl.querySelector('#m-clients').hidden = e.target.value === '1'; }),
          onOk: async mdl => {
            const permissions = {}; mdl.querySelectorAll('[data-p]').forEach(s => { if (s.value !== '') permissions[s.dataset.p] = s.value === '1'; });
            await EF.api('PUT', `team/${m.user_id}`, { fin_role: mdl.querySelector('#m-role').value, all_clients: mdl.querySelector('#m-all').value === '1', client_ids: [...mdl.querySelectorAll('[data-c]:checked')].map(c => c.dataset.c), permissions });
            return true;
          } });
        if (ok) EF.route();
      }));
    },
  };
})();
