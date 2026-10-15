/* Equipo y oficiales, Configuración y Asistente (chat e IR-17 originales). */
(function () {
  const { esc, int } = NALA;
  const PERM_LABELS = { view: 'Ver', upload: 'Cargar', edit: 'Editar', approve: 'Aprobar', revert: 'Revertir', relocate: 'Reubicar', exclude: 'Excluir', reprocess: 'Reprocesar',
    export: 'Exportar', submit: 'Registrar envío DGII', clients_manage: 'Gestionar empresas', rnc: 'Consulta RNC', team_manage: 'Gestionar equipo', settings_manage: 'Configuración', retention_purge: 'Depurar retención' };

  NALA.views.equipo = {
    title: 'Equipo y oficiales',
    async render(root) {
      const t = await NALA.api('GET', 'team');
      const canManage = NALA.can('team_manage');
      root.innerHTML = `<div class="stack">
        <div class="card"><h2>Roles de NALA</h2><div class="table-wrap"><table><tr><th>Rol</th>${t.all_permissions.filter(p => !['team_manage', 'settings_manage', 'retention_purge'].includes(p)).map(p => `<th>${esc(PERM_LABELS[p])}</th>`).join('')}</tr>
          ${t.roles.map(r => `<tr><td><b>${esc(r.label)}</b></td>${t.all_permissions.filter(p => !['team_manage', 'settings_manage', 'retention_purge'].includes(p)).map(p => `<td>${r.permissions.includes(p) ? '✓' : ''}</td>`).join('')}</tr>`).join('')}</table></div>
          <p class="muted" style="margin-top:8px">Los administradores de la empresa operadora tienen todos los permisos. Los usuarios se crean en SERP → Usuarios (casilla NALA); aquí se asignan rol y empresas. Los permisos se validan en el servidor.</p></div>
        <div class="card"><h2>Miembros</h2><div class="table-wrap"><table><tr><th>Usuario</th><th>Rol NALA</th><th>Empresas asignadas</th><th>Permisos efectivos</th><th></th></tr>
          ${t.members.map(m => `<tr><td><b>${esc(m.username)}</b>${m.app_role === 'admin' ? ' <span class="badge accent">Admin</span>' : ''}</td><td>${esc(m.role_label)}</td>
            <td>${m.all_clients ? 'Todas' : (m.client_ids.length ? m.client_ids.map(id => esc(NALA.clientName(id))).join(', ') : '<span class="badge crit">Ninguna</span>')}</td>
            <td class="muted" style="max-width:320px">${m.permissions.map(p => PERM_LABELS[p] || p).join(', ')}</td>
            <td>${canManage && m.app_role !== 'admin' ? `<button class="btn sm" data-edit="${m.user_id}">Editar</button>` : ''}</td></tr>`).join('')}</table></div></div></div>`;
      root.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', async () => {
        const m = t.members.find(x => x.user_id === b.dataset.edit);
        const saved = await NALA.modal({ title: `Rol y empresas de ${m.username}`, okText: 'Guardar', wide: true,
          body: `<div class="fields"><label class="f"><span>Rol</span><select id="m-role">${t.roles.map(r => `<option value="${r.key}" ${r.key === m.nala_role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>
            <label class="f"><span>Empresas</span><select id="m-all"><option value="1" ${m.all_clients ? 'selected' : ''}>Todas las empresas</option><option value="0" ${!m.all_clients ? 'selected' : ''}>Sólo las asignadas</option></select></label>
            <div class="full" id="m-clients" style="${m.all_clients ? 'display:none' : ''};max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px">${(NALA.state.clients || []).map(c => `<label style="display:block"><input type="checkbox" class="m-c" value="${c.id}" ${m.client_ids.includes(c.id) ? 'checked' : ''}> ${esc(c.legal_name)}</label>`).join('')}</div>
            <div class="full"><b>Ajustes de permisos</b> <span class="muted">(opcional; sobre el rol)</span></div>
            ${Object.keys(PERM_LABELS).filter(p => !['team_manage', 'settings_manage', 'retention_purge', 'view'].includes(p)).map(p => `<label class="f"><span>${esc(PERM_LABELS[p])}</span><select class="m-p" data-p="${p}"><option value="">Según rol</option><option value="true" ${m.overrides[p] === true ? 'selected' : ''}>Permitir</option><option value="false" ${m.overrides[p] === false ? 'selected' : ''}>Denegar</option></select></label>`).join('')}</div>`,
          onOk: async modal => {
            const all = modal.querySelector('#m-all').value === '1';
            const permissions = {}; modal.querySelectorAll('.m-p').forEach(s => { if (s.value) permissions[s.dataset.p] = s.value === 'true'; });
            const body = { nala_role: modal.querySelector('#m-role').value, all_clients: all, client_ids: all ? [] : [...modal.querySelectorAll('.m-c:checked')].map(x => x.value), permissions };
            if (!all && !body.client_ids.length) throw new Error('Asigne al menos una empresa.');
            await NALA.api('PUT', `team/${m.user_id}`, body);
            return true;
          } });
        if (saved) { NALA.toast('Miembro actualizado', 'ok'); NALA.route(); }
      }));
    },
  };
  document.addEventListener('change', e => { if (e.target.id === 'm-all') document.getElementById('m-clients').style.display = e.target.value === '1' ? 'none' : ''; });

  // ── Plantillas DGII del usuario (606 y 607) ──────────────────────────────
  function putFile(url, file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Carga rechazada (${xhr.status})`)));
      xhr.onerror = () => reject(new Error('Error de red al subir el archivo'));
      xhr.send(file);
    });
  }
  async function uploadTemplate(format, kind, file) {
    const { path, upload_url } = await NALA.api('POST', 'templates/upload-url', { format, kind, name: file.name, size: file.size });
    await putFile(upload_url, file);
    return NALA.api('POST', 'templates', { format, kind, path, name: file.name });
  }
  const TPL_FORMATS = [{ fmt: '606', title: 'Formato 606 · Compras' }, { fmt: '607', title: 'Formato 607 · Ventas' }];
  function templateBlock(fmt, t, canEdit) {
    const ex = t.excel; const st = t.txt_style;
    const badge = (ok, txt) => `<span class="badge ${ok ? 'ok' : 'warn'}">${esc(txt)}</span>`;
    return `<div class="stack" style="gap:12px" data-tpl="${fmt}">
        <div><b>1. Herramienta de la DGII vacía, con macros (.xlsm)</b>
          <div class="muted">NALA la guarda y, en cada exportación del ${fmt}, se la devuelve llena (encabezado y filas desde B12) con sus macros, lista para pulsar Validar y Generar Archivo.</div>
          ${ex ? `<div class="issue ${ex.fillable ? 'info' : 'warning'}" style="margin-top:6px"><span class="ico">${ex.fillable ? '✓' : '!'}</span><div><b>${esc(ex.name)}</b> ${badge(ex.fillable, ex.fillable ? 'Lista para llenar' : 'No se puede llenar')}<br>${esc(ex.message || '')}<br><span class="muted">Subida ${NALA.dateTime(ex.uploaded_at)}</span></div>${canEdit ? `<button class="btn sm danger" data-del="excel" data-format="${fmt}">Quitar</button>` : ''}</div>` : '<div class="muted" style="margin-top:6px">Todavía no ha subido la herramienta.</div>'}
          ${canEdit ? `<label class="btn" style="margin-top:6px">${ex ? 'Reemplazar' : 'Subir'} herramienta<input type="file" data-up="excel" data-format="${fmt}" accept="*/*" hidden></label>` : ''}</div>
        <div><b>2. TXT que usted ya envió a la DGII (ejemplos)</b>
          <div class="muted">NALA aprende de ellos cómo escribir el suyo: montos con o sin decimales y qué campos deja vacíos.</div>
          ${st ? `<div class="issue info" style="margin-top:6px"><span class="ico">✓</span><div>Aprendido de ${st.from_examples} ejemplo(s): montos ${st.amount_format === 'excel' ? 'como los escribe la herramienta (1000, 500.5)' : 'con 2 decimales (1000.00)'}${st.blank_zero?.length ? '; montos en cero se dejan vacíos' : '; montos en cero se escriben 0.00'}.</div></div>` : ''}
          ${(t.examples || []).map((e, i) => `<div class="row" style="margin-top:6px;gap:8px"><span class="mono">${esc(e.name)}</span><span class="muted">${e.lines || 0} línea(s) · ${esc(e.rnc || '')} · ${esc(e.period || '')}</span>${e.problems?.length ? `<span class="badge warn" title="${esc(e.problems.join(' · '))}">${e.problems.length} problema(s): no se usa para aprender</span>` : '<span class="badge ok">Usado</span>'}${canEdit ? `<button class="btn sm" data-del="txt" data-format="${fmt}" data-i="${i}">Quitar</button>` : ''}</div>`).join('')}
          ${canEdit ? `<label class="btn" style="margin-top:6px">Subir TXT de ejemplo<input type="file" data-up="txt" data-format="${fmt}" accept="*/*" multiple hidden></label>` : ''}</div>
      </div>`;
  }
  function templatesCard(tpl, canEdit) {
    return `<div class="card" id="dgii-tpl"><h2>Plantillas DGII · Formatos 606 y 607</h2>
      <p class="muted" style="margin-bottom:10px">Súbale a NALA cómo usted envía a la DGII. Se acepta cualquier tipo de archivo (.xlsm, .xls, .xlsx, .txt…); NALA le dice cuál puede usar.</p>
      ${TPL_FORMATS.map(({ fmt, title }) => `<details ${tpl[fmt]?.excel || (tpl[fmt]?.examples || []).length || fmt === '606' ? 'open' : ''} style="margin-bottom:10px"><summary style="cursor:pointer;font-weight:600;padding:4px 0">${title}</summary>${templateBlock(fmt, tpl[fmt] || {}, canEdit)}</details>`).join('')}</div>`;
  }
  function bindTemplates(root) {
    const done = msg => { NALA.toast(msg, 'ok'); NALA.route(); };
    root.querySelectorAll('#dgii-tpl input[data-up="excel"]').forEach(inp => inp.addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      const format = inp.dataset.format;
      try { NALA.toast('Subiendo y revisando la herramienta…'); const r = await uploadTemplate(format, 'excel', file); const ex = r.templates[format].excel; NALA.toast(ex.fillable ? 'Herramienta guardada: lista para llenar.' : ex.message, ex.fillable ? 'ok' : 'err'); NALA.route(); } catch (err) { NALA.fail(err); }
    }));
    root.querySelectorAll('#dgii-tpl input[data-up="txt"]').forEach(inp => inp.addEventListener('change', async e => {
      const files = [...e.target.files]; if (!files.length) return;
      const format = inp.dataset.format;
      try { for (const f of files) await uploadTemplate(format, 'txt', f); done(`${files.length} TXT de ejemplo guardado(s)`); } catch (err) { NALA.fail(err); }
    }));
    root.querySelectorAll('#dgii-tpl [data-del]').forEach(b => b.addEventListener('click', async () => {
      try { await NALA.api('DELETE', `templates/${b.dataset.format}/${b.dataset.del}${b.dataset.i !== undefined ? '/' + b.dataset.i : ''}`); done('Quitado'); } catch (err) { NALA.fail(err); }
    }));
  }

  NALA.views.config = {
    title: 'Configuración',
    async render(root) {
      const [{ settings, integrations, rules }, retention] = await Promise.all([NALA.api('GET', 'settings'), NALA.api('GET', 'retention')]);
      const canEdit = NALA.can('settings_manage');
      const dis = canEdit ? '' : 'disabled';
      const L = settings.limits;
      const field = (k, label, min, max) => `<label class="f"><span>${esc(label)}</span><input type="number" data-limit="${k}" value="${L[k]}" min="${min}" max="${max}" ${dis}></label>`;
      const integ = (ok, label, detail) => `<div class="issue ${ok ? 'info' : 'warning'}"><span class="ico">${ok ? '✓' : '!'}</span><div><b>${esc(label)}</b><br>${detail}</div></div>`;
      root.innerHTML = `<div class="stack" style="max-width:980px">
        <div class="card"><h2>Integraciones</h2><div class="stack" style="gap:6px">
          ${integ(integrations.openai.configured, 'Extracción OCR/IA (OpenAI)', integrations.openai.configured ? `Configurada en el servidor · modelo ${esc(integrations.openai.model)}` : 'Falta la variable de entorno <span class="mono">OPENAI_API_KEY</span> en el servidor. Sin ella los trabajos de extracción fallan con un mensaje claro; no se simulan resultados.')}
          ${integ(true, 'Consulta RNC oficial', `DGII — <span class="mono">${esc(integrations.dgii_rnc.source)}</span>. Si la DGII no responde, NALA lo indica y no marca el RNC como verificado.`)}
          ${integ(integrations.storage.status === 'ok', 'Almacenamiento privado de originales', `Bucket <span class="mono">${esc(integrations.storage.bucket)}</span> · ${esc(integrations.storage.status)} · descargas por enlace temporal de 5 minutos.`)}
          ${integ(integrations.worker.scheduled_secret_configured || integrations.worker.cron_secret_configured, 'Procesamiento en segundo plano', `${integrations.worker.scheduled_secret_configured ? 'Worker programado con <span class="mono">NALA_WORKER_SECRET</span>.' : 'Sin <span class="mono">NALA_WORKER_SECRET</span>: los lotes avanzan mientras haya una pestaña de NALA abierta y con la recuperación diaria (Vercel Cron + <span class="mono">CRON_SECRET</span>).'} Ver docs/nala/README.md.`)}
        </div></div>
        <div class="card"><h2>Límites de carga y procesamiento</h2><div class="fields" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
          ${field('max_file_mb', 'Tamaño máx. por archivo (MB)', 1, 50)}${field('max_files_per_batch', 'Archivos por lote', 1, 2000)}${field('max_pages_per_document', 'Páginas por documento', 1, 1000)}
          ${field('pages_per_chunk', 'Páginas por trabajo de extracción', 1, 10)}${field('max_attempts', 'Intentos por trabajo', 1, 10)}${field('zip_max_uncompressed_mb', 'ZIP descomprimido máx. (MB)', 10, 1000)}${field('concurrent_jobs', 'Trabajos simultáneos', 1, 5)}</div></div>
        <div class="card"><h2>Reglas contables</h2><div class="fields" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
          <label class="f"><span>Tolerancia total calculado vs. documento (RD$)</span><input id="tol" value="${esc(settings.rules.total_tolerance)}" inputmode="decimal" ${dis}></label>
          <div class="muted">Reglas fiscales versionadas: <b>${esc(rules.version)}</b> · ITBIS ${rules.itbis_rates.join('% / ')}% · consumo resumido < RD$${Number(rules.consumer_threshold).toLocaleString('es-DO')} · máximo ${int(rules.max_records['606'])} registros (606) y ${int(rules.max_records['607'])} (607).</div></div></div>
        <div class="card"><h2>Retención documental</h2><div class="row"><label class="f"><span>Conservar originales (años)</span><input type="number" id="ret" min="10" max="30" value="${settings.retention.years}" ${dis}></label>
          <span class="muted">Código Tributario, art. 50: mínimo 10 años. ${int(retention.documents.length)} documento(s) anteriores a ${NALA.dateTime(retention.cutoff)} pueden depurarse (se conserva su huella SHA-256 y el historial).</span>
          ${NALA.can('retention_purge') && retention.documents.length ? '<button class="btn danger" id="purge">Depurar originales vencidos</button>' : ''}</div></div>
        ${templatesCard(settings.dgii_templates || {}, canEdit)}
        <div class="card"><h2>Plantillas de Excel personalizado</h2><p class="muted" style="margin-bottom:8px">Columnas separadas por coma (ej. <span class="mono">x_counterpart,rnc_cedula,ncf,fecha_comprobante,itbis</span>). La plantilla oficial no se modifica.</p>
          <div id="tpls">${settings.excel_templates.map(t => `<div class="row tpl" style="margin-bottom:6px"><input class="t-name" value="${esc(t.name)}" placeholder="Nombre" ${dis}><select class="t-format" ${dis}><option ${t.format === '606' ? 'selected' : ''}>606</option><option ${t.format === '607' ? 'selected' : ''}>607</option></select><input class="t-cols" style="flex:1" value="${esc(t.columns.join(','))}" ${dis}></div>`).join('')}</div>
          ${canEdit ? '<button class="btn sm" id="addtpl">+ Plantilla</button>' : ''}</div>
        ${canEdit ? '<div><button class="btn primary" id="savecfg">Guardar configuración</button></div>' : '<p class="muted">Sólo administradores pueden cambiar la configuración.</p>'}</div>`;
      bindTemplates(root);
      root.querySelector('#addtpl')?.addEventListener('click', () => {
        root.querySelector('#tpls').insertAdjacentHTML('beforeend', '<div class="row tpl" style="margin-bottom:6px"><input class="t-name" placeholder="Nombre"><select class="t-format"><option>606</option><option>607</option></select><input class="t-cols" style="flex:1" placeholder="columnas"></div>');
      });
      root.querySelector('#savecfg')?.addEventListener('click', async () => {
        const limits = {}; root.querySelectorAll('[data-limit]').forEach(i => { limits[i.dataset.limit] = Number(i.value); });
        const excel_templates = [...root.querySelectorAll('.tpl')].map(r => ({ name: r.querySelector('.t-name').value, format: r.querySelector('.t-format').value, columns: r.querySelector('.t-cols').value.split(',').map(s => s.trim()).filter(Boolean) }));
        try { await NALA.api('PUT', 'settings', { settings: { limits, rules: { total_tolerance: root.querySelector('#tol').value }, retention: { years: Number(root.querySelector('#ret').value) }, excel_templates } }); NALA.toast('Configuración guardada', 'ok'); NALA.route(); } catch (e) { NALA.fail(e); }
      });
      root.querySelector('#purge')?.addEventListener('click', async () => {
        const ok = await NALA.modal({ title: 'Depurar originales vencidos', okText: 'Depurar', okClass: 'danger',
          body: `<p>Se eliminarán del almacenamiento ${int(retention.documents.length)} original(es) más antiguos que el plazo de retención. Se conservan los datos, la huella SHA-256 y el historial.</p><label class="f" style="margin-top:8px"><span>Escriba DEPURAR para confirmar</span><input id="cf"></label>`,
          onOk: m => { if (m.querySelector('#cf').value !== 'DEPURAR') throw new Error('Escriba DEPURAR.'); return true; } });
        if (!ok) return;
        try { const r = await NALA.api('POST', 'retention/purge', { confirm: 'DEPURAR' }); NALA.toast(`${r.purged} original(es) depurados`, 'ok'); NALA.route(); } catch (e) { NALA.fail(e); }
      });
    },
  };

  NALA.views.asistente = {
    title: 'Asistente NALA',
    render(root) {
      root.innerHTML = '<p class="muted" style="margin-bottom:8px">Chat contable y lectura rápida de facturas 606, 607 e IR-17 (sin guardar en lotes). Para el flujo auditado use Carga masiva y lotes.</p><iframe class="assistant" src="/nala/asistente.html" title="Asistente NALA"></iframe>';
    },
  };
})();
