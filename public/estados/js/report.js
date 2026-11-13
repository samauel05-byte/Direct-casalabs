/* Estados Financieros — detalle de un informe: encabezado, pendientes, datos, ajustes, documentos, importaciones e historial. */
(function () {
  const { esc, money, dateOnly, dateTime } = EF;
  const SEV = { blocking: 'Bloqueante', warning: 'Advertencia', info: 'Nota' };
  const ACTION = { report_created: 'Informe creado', report_updated: 'Informe editado', import_applied: 'Importación aplicada', import_reverted: 'Importación revertida', report_reopened: 'Informe reabierto',
    state_en_revision: 'Pasó a revisión', state_observado: 'Observado', state_aprobado: 'Aprobado', state_cerrado: 'Cerrado', state_borrador: 'Volvió a borrador', state_pendiente_cierre: 'Volvió a pendiente de cierre',
    state_pendiente_legalizacion: 'Pendiente de legalización', assumption_created: 'Supuesto agregado', assumption_updated: 'Supuesto editado', assumption_removed: 'Supuesto retirado',
    adjustment_created: 'Ajuste registrado', adjustment_removed: 'Ajuste retirado', documents_updated: 'Documentos actualizados', report_exported: 'Exportado' };

  EF.views.r = {
    title: 'Informe',
    async render(root, { arg, params }) {
      let tab = params.tab || 'datos';
      const load = async () => {
        const d = await EF.api('GET', `reports/${arg}`);
        draw(d);
      };
      const draw = d => {
        const r = d.report; const m = EF.mod(r.modality); const c = d.completeness;
        document.getElementById('title').textContent = `${m.singular} · ${r.title}`;
        const approved = ['aprobado', 'cerrado', 'pendiente_legalizacion'].includes(r.status);
        const tabs = [['datos', r.modality === 'proyectado' ? 'Supuestos y valores' : 'Cuentas y registros'], ...(r.modality !== 'proyectado' ? [['ajustes', 'Ajustes y cierre']] : []), ['docs', 'Documentos'], ['import', 'Importaciones'], ['hist', 'Historial']];
        if (!tabs.some(t => t[0] === tab)) tab = 'datos';
        root.innerHTML = `<div class="stack">
          <div class="banner ${approved && c.complete ? 'final' : 'prelim'}">${approved && c.complete ? `Documento ${esc(d.status_label.toLowerCase())}` : `DOCUMENTO PRELIMINAR — ${!approved ? `NO APROBADO (${esc(d.status_label)})` : 'INCOMPLETO'}${!c.complete ? ' · tiene información pendiente' : ''}`}</div>
          <div class="card"><h2>${esc(r.title)} ${EF.modTag(r.modality)} ${EF.statusBadge(r.status)}<span class="spacer"></span>
            <span class="btn-row no-print">${d.transitions.map(t => `<button class="btn sm ${t.to === 'aprobado' ? 'ok' : ''}" data-tr="${t.to}" data-reason="${t.reason ? 1 : 0}" data-reopen="${t.reopen ? 1 : 0}">${t.reopen ? '↺ Reabrir' : '→'} ${esc(t.reopen ? '' : t.label)}${t.reopen ? ` (a ${esc(t.label)})` : ''}</button>`).join('')}
              ${d.can_edit ? '<button class="btn sm" id="edit">✎ Editar datos del informe</button>' : ''}
              <button class="btn sm" id="xls">⬇ Excel</button><button class="btn sm" id="print">🖨 Imprimir / PDF</button>${d.config.compare_enabled ? '<button class="btn sm" id="cmp">⇄ Comparar</button>' : ''}</span></h2>
            <dl class="rpt-head">
              <div><dt>Modalidad</dt><dd>${esc(m.singular)}</dd></div><div><dt>Empresa</dt><dd>${esc(r.client_name)}${r.client_rnc ? ` · ${esc(r.client_rnc)}` : ''}</dd></div>
              ${r.scenario ? `<div><dt>Escenario</dt><dd>${esc(r.scenario)}</dd></div>` : ''}${r.fiscal_year ? `<div><dt>Año fiscal</dt><dd>${r.fiscal_year}</dd></div>` : ''}${r.fiscal_period ? `<div><dt>Período fiscal</dt><dd>${esc(r.fiscal_period)}</dd></div>` : ''}
              <div><dt>${r.modality === 'proyectado' ? 'Período proyectado' : 'Período / fecha de corte'}</dt><dd>${dateOnly(r.period_start)} – ${dateOnly(r.period_end)}</dd></div>
              ${r.modality !== 'proyectado' ? `<div><dt>La información llega hasta</dt><dd>${d.data_through ? dateOnly(d.data_through) : '<span style="color:var(--crit)">Sin información cargada</span>'}</dd></div>` : ''}
              <div><dt>Moneda</dt><dd>${esc(r.currency)}</dd></div><div><dt>Versión</dt><dd>v${r.version}</dd></div><div><dt>Fecha de preparación</dt><dd>${dateOnly(r.prepared_on)}</dd></div>
              <div><dt>Fecha de generación</dt><dd>${dateTime(d.generated_at)}</dd></div>
              <div><dt>Responsable (preparó)</dt><dd>${esc(d.people[r.prepared_by] || '—')}</dd></div><div><dt>Revisó</dt><dd>${esc(d.people[r.reviewed_by] || '—')}${r.reviewed_at ? ` · ${dateTime(r.reviewed_at)}` : ''}</dd></div>
              <div><dt>Aprobó</dt><dd>${esc(d.people[r.approved_by] || '—')}${r.approved_at ? ` · ${dateTime(r.approved_at)}` : ''}</dd></div><div><dt>Cerró</dt><dd>${esc(d.people[r.closed_by] || '—')}${r.closed_at ? ` · ${dateTime(r.closed_at)}` : ''}</dd></div>
              <div style="grid-column:1/-1"><dt>Origen de la información</dt><dd>${d.origin.length ? d.origin.map(o => (o.type === 'archivo' ? `📎 ${esc(o.file_name)} <span class="muted">(${o.rows} filas${o.stored ? '' : ', archivo no guardado'})</span>` : esc(o.description))).join(' · ') : (r.modality === 'proyectado' ? 'Supuestos y valores ingresados por el usuario' : '<span style="color:var(--crit)">Sin información cargada</span>')}</dd></div>
              ${r.notes ? `<div style="grid-column:1/-1"><dt>Notas</dt><dd>${esc(r.notes)}</dd></div>` : ''}</dl></div>
          <div class="card"><h2>Información pendiente ${c.complete ? '<span class="badge ok">Completo</span>' : `<span class="badge crit">${c.blocking} bloqueante(s)</span>`}</h2>
            ${c.items.length ? `<ul class="pend">${c.items.map(i => `<li class="${i.severity}"><b>${SEV[i.severity]}:</b> ${esc(i.message)}</li>`).join('')}</ul>` : '<p class="muted">Sin pendientes.</p>'}
            <p class="muted" style="margin-top:6px">Un informe con pendientes bloqueantes no se puede aprobar ni cerrar.</p></div>
          <div class="tabs no-print">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div>
          <div id="tabbody"></div></div>`;
        root.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; draw(d); }));
        bindActions(d);
        drawTab(d);
      };

      const bindActions = d => {
        const r = d.report;
        root.querySelectorAll('[data-tr]').forEach(b => b.addEventListener('click', async () => {
          try {
            let note = '';
            if (b.dataset.reason === '1') { note = await EF.askReason(b.dataset.reopen === '1' ? 'Reabrir el informe' : 'Motivo del cambio de estado'); if (!note) return; }
            await EF.api('POST', `reports/${r.id}/transition`, { to: b.dataset.tr, note });
            EF.toast('Estado actualizado', 'ok'); load();
          } catch (e) {
            if (e.data?.pending) { EF.modal({ title: 'No se puede continuar: el informe tiene pendientes', okText: '', cancelText: 'Cerrar', body: `<ul class="pend">${e.data.pending.map(i => `<li class="blocking">${esc(i.message)}</li>`).join('')}</ul>` }); } else EF.fail(e);
          }
        }));
        root.querySelector('#edit')?.addEventListener('click', () => editHeader(d));
        root.querySelector('#xls')?.addEventListener('click', async () => { try { EF.download((await EF.api('GET', `reports/${r.id}/export`)).file); } catch (e) { EF.fail(e); } });
        root.querySelector('#print')?.addEventListener('click', () => window.print());
        root.querySelector('#cmp')?.addEventListener('click', () => compare(d));
      };

      const drawTab = d => {
        const body = root.querySelector('#tabbody'); const r = d.report;
        ({ datos: () => (r.modality === 'proyectado' ? assumptionsTab(body, d) : accountsTab(body, d)), ajustes: () => adjustmentsTab(body, d), docs: () => docsTab(body, d), import: () => importsTab(body, d), hist: () => historyTab(body, d) }[tab])();
      };

      // ── Proyectados: supuestos y valores estimados ──
      const assumptionForm = (a = {}) => `<div class="map-grid">
        <label class="f"><span>Tipo *</span><select id="a-kind"><option value="supuesto" ${a.kind === 'supuesto' ? 'selected' : ''}>Supuesto</option><option value="valor_estimado" ${a.kind === 'valor_estimado' ? 'selected' : ''}>Valor estimado</option></select></label>
        <label class="f"><span>Concepto *</span><input id="a-name" maxlength="200" value="${esc(a.name || '')}"></label>
        <label class="f"><span>Período</span><input id="a-period" maxlength="40" value="${esc(a.period || '')}" placeholder="2027-01, T1 2027…"></label>
        <label class="f"><span>Código de cuenta (para comparar con cifras reales)</span><input id="a-acc" maxlength="60" value="${esc(a.account_code || '')}"></label>
        <label class="f"><span>Valor (cifra dada por Contabilidad)</span><input id="a-amount" inputmode="decimal" value="${a.amount ?? ''}"></label>
        <label class="f"><span>Unidad</span><input id="a-unit" maxlength="40" value="${esc(a.unit || '')}" placeholder="RD$, %, unidades"></label>
        <label class="f" style="grid-column:1/-1"><span>Descripción (de dónde sale o qué significa)</span><textarea id="a-desc" rows="2" maxlength="1000">${esc(a.description || '')}</textarea></label>
        <label class="f" style="grid-column:1/-1"><span>Fuente</span><input id="a-source" maxlength="300" value="${esc(a.source || '')}"></label>
        <label style="grid-column:1/-1"><input type="checkbox" id="a-pending" ${a.pending ? 'checked' : ''}> Pendiente de confirmar (el informe queda incompleto mientras esté marcado)</label></div>`;
      const readAssumption = m => { const v = s => m.querySelector(s).value.trim(); return { kind: v('#a-kind'), name: v('#a-name'), period: v('#a-period'), account_code: v('#a-acc'), amount: v('#a-amount'), unit: v('#a-unit'), description: v('#a-desc'), source: v('#a-source'), pending: m.querySelector('#a-pending').checked }; };
      const assumptionsTab = (body, d) => {
        body.innerHTML = `<div class="card"><h2>Supuestos y valores estimados <span class="proj-tag">PROYECTADO · son estimaciones, no hechos</span><span class="spacer"></span>${d.can_edit ? '<button class="btn sm primary" id="add">+ Agregar</button><button class="btn sm" id="imp">⬆ Cargar Excel/CSV</button>' : ''}</h2>
          <p class="muted">Direct no calcula proyecciones: muestra solo las cifras que usted cargó. Las fórmulas y datos base los define Contabilidad.</p>
          ${d.assumptions.length ? `<div class="table-wrap"><table><tr><th>Tipo</th><th>Concepto</th><th>Descripción</th><th>Período</th><th>Cuenta</th><th class="num">Valor</th><th>Fuente</th><th></th></tr>
            ${d.assumptions.map(a => `<tr><td>${a.kind === 'supuesto' ? 'Supuesto' : 'Valor estimado'} ${a.pending ? '<span class="badge warn">Pendiente</span>' : ''}</td><td><b>${esc(a.name)}</b></td><td>${esc(a.description || '—')}</td><td>${esc(a.period || '—')}</td><td>${esc(a.account_code || '—')}</td>
              <td class="num">${a.amount === null ? '—' : `${money(a.amount)} ${esc(a.unit || '')}`}</td><td>${esc(a.source || '—')}</td>
              <td class="no-print">${d.can_edit ? `<button class="btn sm" data-ea="${a.id}">Editar</button> <button class="btn sm danger" data-da="${a.id}">Retirar</button>` : ''}</td></tr>`).join('')}</table></div>` : '<div class="empty">No hay supuestos ni valores estimados. Agréguelos o cargue el Excel que entregue Contabilidad.</div>'}</div>`;
        body.querySelector('#add')?.addEventListener('click', async () => { const ok = await EF.modal({ title: 'Agregar supuesto o valor estimado', okText: 'Guardar', wide: true, body: assumptionForm(), onOk: async m => { await EF.api('POST', `reports/${d.report.id}/assumptions`, readAssumption(m)); return true; } }); if (ok) load(); });
        body.querySelector('#imp')?.addEventListener('click', async () => { if (await EF.openImport(d)) load(); });
        body.querySelectorAll('[data-ea]').forEach(b => b.addEventListener('click', async () => { const a = d.assumptions.find(x => x.id === b.dataset.ea); const ok = await EF.modal({ title: 'Editar', okText: 'Guardar', wide: true, body: assumptionForm(a), onOk: async m => { await EF.api('PATCH', `assumptions/${a.id}`, readAssumption(m)); return true; } }); if (ok) load(); }));
        body.querySelectorAll('[data-da]').forEach(b => b.addEventListener('click', async () => { if (!confirm('¿Retirar este elemento? Queda en el historial.')) return; try { await EF.api('DELETE', `assumptions/${b.dataset.da}`); load(); } catch (e) { EF.fail(e); } }));
      };

      // ── Interinos y del año: cuentas y registros ──
      const accountsTab = (body, d) => {
        body.innerHTML = `<div class="card"><h2>Resumen por cuenta <span class="real-tag">REAL</span><span class="spacer"></span>${d.can_edit ? '<button class="btn sm primary" id="imp">⬆ Cargar Excel/CSV</button>' : ''}<button class="btn sm" id="rows">Ver registros</button></h2>
          <p class="muted">Movimientos reales sumados por cuenta, tal como se cargaron (sin interpretarlos). Total: ${d.totals.entries} registro(s) · débitos ${money(d.totals.debit)} · créditos ${money(d.totals.credit)}.</p>
          ${d.accounts.length ? `<div class="table-wrap"><table><tr><th>Cuenta</th><th>Nombre</th><th>Clasificación</th><th class="num">Débitos</th><th class="num">Créditos</th><th class="num">Neto</th><th class="num">Ajustes</th><th class="num">Neto con ajustes</th></tr>
            ${d.accounts.map(a => `<tr><td class="mono">${esc(a.account_code)}</td><td>${esc(a.account_name || '—')}</td><td>${esc(a.classification || '—')}</td><td class="num">${money(a.debit)}</td><td class="num">${money(a.credit)}</td><td class="num">${money(a.net)}</td><td class="num">${money(a.adj_debit - a.adj_credit)}</td><td class="num">${money(a.net_with_adjustments)}</td></tr>`).join('')}</table></div>` : '<div class="empty">No hay información contable cargada. Descargue la plantilla desde «Plantillas y pendientes» o cargue el libro/auxiliar de Contabilidad.</div>'}</div>`;
        body.querySelector('#imp')?.addEventListener('click', async () => { if (await EF.openImport(d)) load(); });
        body.querySelector('#rows').addEventListener('click', () => entriesModal(d));
      };
      const entriesModal = async (d, page = 1, q = '') => {
        const out = await EF.api('GET', `reports/${d.report.id}/entries?page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
        const pages = Math.max(1, Math.ceil(out.total / out.size));
        const r = await EF.modal({ title: `Registros (${out.total})`, okText: '', cancelText: 'Cerrar', wide: true, body: `<div class="row" style="margin-bottom:8px"><input id="eq" placeholder="Buscar concepto, referencia o cuenta" value="${esc(q)}" style="flex:1"><button class="btn sm" id="ego">Buscar</button><span class="muted">Página ${page}/${pages}</span><button class="btn sm" id="eprev" ${page <= 1 ? 'disabled' : ''}>‹</button><button class="btn sm" id="enext" ${page >= pages ? 'disabled' : ''}>›</button></div>
          <div class="table-wrap"><table><tr><th>Fila</th><th>Fecha</th><th>Cuenta</th><th>Concepto</th><th>Ref.</th><th class="num">Débito</th><th class="num">Crédito</th></tr>${out.entries.map(e => `<tr><td>${e.row_no ?? ''}</td><td>${dateOnly(e.entry_date)}</td><td class="mono">${esc(e.account_code)}</td><td>${esc(e.concept || '')}</td><td>${esc(e.reference || '')}</td><td class="num">${money(e.debit)}</td><td class="num">${money(e.credit)}</td></tr>`).join('')}</table></div>`,
          onOpen: (m, { close }) => { m.querySelector('#ego').addEventListener('click', () => close({ page: 1, q: m.querySelector('#eq').value })); m.querySelector('#eprev').addEventListener('click', () => close({ page: page - 1, q })); m.querySelector('#enext').addEventListener('click', () => close({ page: page + 1, q })); } });
        if (r && r.page) entriesModal(d, r.page, r.q);
      };

      // ── Ajustes y cierre ──
      const adjustmentsTab = (body, d) => {
        const r = d.report;
        body.innerHTML = `<div class="card"><h2>${r.modality === 'anual' ? 'Ajustes y asientos de cierre' : 'Ajustes o registros adicionales'}<span class="spacer"></span>${d.can_edit ? '<button class="btn sm primary" id="add">+ Registrar</button>' : ''}</h2>
          ${d.adjustments.length ? `<div class="table-wrap"><table><tr><th>Tipo</th><th>Fecha</th><th>Referencia</th><th>Concepto</th><th>Cuenta</th><th class="num">Débito</th><th class="num">Crédito</th><th></th></tr>${d.adjustments.map(a => `<tr><td>${a.kind === 'cierre' ? 'Cierre' : 'Ajuste'}</td><td>${dateOnly(a.adj_date)}</td><td>${esc(a.reference || '—')}</td><td>${esc(a.concept)}</td><td class="mono">${esc(a.account_code)}</td><td class="num">${money(a.debit)}</td><td class="num">${money(a.credit)}</td><td class="no-print">${d.can_edit ? `<button class="btn sm danger" data-dj="${a.id}">Retirar</button>` : ''}</td></tr>`).join('')}</table></div>` : '<div class="empty">No hay ajustes registrados.</div>'}</div>`;
        body.querySelector('#add')?.addEventListener('click', async () => {
          const ok = await EF.modal({ title: 'Registrar ajuste', okText: 'Guardar', wide: true, body: `<div class="map-grid">${r.modality === 'anual' ? '<label class="f"><span>Tipo</span><select id="j-kind"><option value="ajuste">Ajuste</option><option value="cierre">Asiento de cierre</option></select></label>' : ''}
            <label class="f"><span>Fecha *</span><input id="j-date" type="date" min="${r.period_start || ''}" max="${r.period_end || ''}"></label><label class="f"><span>Referencia / asiento</span><input id="j-ref" maxlength="80"></label>
            <label class="f"><span>Código de cuenta *</span><input id="j-acc" maxlength="60"></label><label class="f"><span>Nombre de cuenta</span><input id="j-name" maxlength="200"></label>
            <label class="f"><span>Débito</span><input id="j-deb" inputmode="decimal"></label><label class="f"><span>Crédito</span><input id="j-cre" inputmode="decimal"></label>
            <label class="f" style="grid-column:1/-1"><span>Concepto *</span><input id="j-con" maxlength="500"></label></div><p class="muted">Registre el débito y el crédito de un asiento en líneas separadas con la misma referencia.</p>`,
            onOk: async m => { const v = s => m.querySelector(s)?.value.trim(); await EF.api('POST', `reports/${r.id}/adjustments`, { kind: v('#j-kind') || 'ajuste', adj_date: v('#j-date'), reference: v('#j-ref'), account_code: v('#j-acc'), account_name: v('#j-name'), debit: v('#j-deb'), credit: v('#j-cre'), concept: v('#j-con') }); return true; } });
          if (ok) load();
        });
        body.querySelectorAll('[data-dj]').forEach(b => b.addEventListener('click', async () => { if (!confirm('¿Retirar este ajuste? Queda en el historial.')) return; try { await EF.api('DELETE', `adjustments/${b.dataset.dj}`); load(); } catch (e) { EF.fail(e); } }));
      };

      // ── Documentos del informe (los define Contabilidad) ──
      const docsTab = (body, d) => {
        const docs = d.report.documents || [];
        body.innerHTML = `<div class="card"><h2>Documentos que forman parte del informe</h2>
          ${docs.length ? `<div class="table-wrap"><table><tr><th>Documento</th><th>Obligatorio</th><th>Estado</th><th>Nota</th></tr>${docs.map(x => `<tr><td><b>${esc(x.label)}</b></td><td>${x.required !== false ? 'Sí' : 'No'}</td>
            <td><select data-dk="${esc(x.key)}" ${d.can_edit ? '' : 'disabled'}><option value="pendiente" ${x.status !== 'incluido' ? 'selected' : ''}>Pendiente</option><option value="incluido" ${x.status === 'incluido' ? 'selected' : ''}>Incluido / listo</option></select></td>
            <td><input data-dn="${esc(x.key)}" value="${esc(x.note || '')}" maxlength="300" ${d.can_edit ? '' : 'disabled'}></td></tr>`).join('')}</table></div>${d.can_edit ? '<div class="btn-row" style="margin-top:8px"><button class="btn primary sm" id="save">Guardar</button></div>' : ''}`
          : '<div class="empty">Contabilidad todavía no definió los documentos de esta modalidad (balance, resultados, flujos…). Se definen en Configuración y se copian a cada informe nuevo.</div>'}</div>`;
        body.querySelector('#save')?.addEventListener('click', async () => {
          try { await EF.api('PUT', `reports/${d.report.id}/documents`, { documents: docs.map(x => ({ key: x.key, status: body.querySelector(`[data-dk="${x.key}"]`).value, note: body.querySelector(`[data-dn="${x.key}"]`).value })) }); EF.toast('Documentos guardados', 'ok'); load(); } catch (e) { EF.fail(e); }
        });
      };

      // ── Importaciones ──
      const importsTab = (body, d) => {
        body.innerHTML = `<div class="card"><h2>Archivos cargados<span class="spacer"></span>${d.can_edit ? '<button class="btn sm primary" id="imp">⬆ Cargar Excel/CSV</button>' : ''}<button class="btn sm" id="tpl">⬇ Plantilla</button></h2>
          ${d.imports.length ? `<div class="table-wrap"><table><tr><th>Archivo</th><th>Hoja</th><th class="num">Filas</th><th>SHA-256</th><th>Cargó</th><th>Fecha</th><th>Estado</th><th></th></tr>${d.imports.map(i => `<tr><td>📎 ${esc(i.file_name)}${i.storage_path ? '' : ' <span class="muted">(solo registro, archivo no guardado)</span>'}</td><td>${esc(i.sheet || '—')}</td><td class="num">${i.row_count}</td><td class="mono" title="${esc(i.sha256 || '')}">${esc(String(i.sha256 || '').slice(0, 12))}…</td><td>${esc(i.created_by_name || '—')}</td><td>${dateTime(i.created_at)}</td>
            <td>${i.status === 'reverted' ? `<span class="badge">Revertida</span><br><span class="muted">${esc(i.revert_reason || '')}</span>` : '<span class="badge ok">Aplicada</span>'}</td><td class="no-print">${d.can_edit && i.status === 'applied' ? `<button class="btn sm danger" data-rv="${i.id}">Revertir</button>` : ''}</td></tr>`).join('')}</table></div>` : '<div class="empty">Todavía no se ha cargado ningún archivo.</div>'}
          <p class="muted" style="margin-top:6px">Revertir deja las filas fuera del informe pero conservadas en el historial.</p></div>`;
        body.querySelector('#imp')?.addEventListener('click', async () => { if (await EF.openImport(d)) load(); });
        body.querySelector('#tpl').addEventListener('click', () => EF.downloadTemplate(d.report.modality));
        body.querySelectorAll('[data-rv]').forEach(b => b.addEventListener('click', async () => { const reason = await EF.askReason('Revertir la importación'); if (!reason) return; try { await EF.api('POST', `imports/${b.dataset.rv}/revert`, { reason }); EF.toast('Importación revertida', 'ok'); load(); } catch (e) { EF.fail(e); } }));
      };

      // ── Historial ──
      const historyTab = (body, d) => {
        body.innerHTML = `<div class="grid cols-2"><div class="card"><h2>Versiones</h2><div class="table-wrap"><table><tr><th>Ver.</th><th>Cambio</th><th>Por</th><th>Fecha</th><th></th></tr>${d.versions.map(v => `<tr><td>v${v.version}</td><td>${esc(v.change_type)}${v.note ? `<br><span class="muted">${esc(v.note)}</span>` : ''}</td><td>${esc(v.changed_by_name || '—')}</td><td>${dateTime(v.changed_at)}</td><td><button class="btn sm" data-ver="${v.version}">Ver</button></td></tr>`).join('')}</table></div></div>
          <div class="card"><h2>Registro de cambios</h2><div class="table-wrap"><table><tr><th>Fecha</th><th>Quién</th><th>Acción</th></tr>${d.events.map(e => `<tr><td>${dateTime(e.created_at)}</td><td>${esc(e.user_name || '—')}</td><td>${esc(ACTION[e.action] || e.action)}${e.details?.note ? `<br><span class="muted">${esc(e.details.note)}</span>` : ''}${e.details?.reason ? `<br><span class="muted">${esc(e.details.reason)}</span>` : ''}</td></tr>`).join('')}</table></div></div></div>`;
        body.querySelectorAll('[data-ver]').forEach(b => b.addEventListener('click', async () => {
          try { const { version } = await EF.api('GET', `reports/${d.report.id}/versions/${b.dataset.ver}`); const h = version.snapshot.header || {};
            EF.modal({ title: `Versión ${version.version} · ${version.change_type}`, okText: '', cancelText: 'Cerrar', wide: true, body: `<p class="muted">${dateTime(version.changed_at)}${version.note ? ` · ${esc(version.note)}` : ''}</p><div class="table-wrap"><table>${Object.entries(h).filter(([k]) => k !== 'documents').map(([k, v]) => `<tr><th style="position:static">${esc(k)}</th><td>${esc(v ?? '—')}</td></tr>`).join('')}</table></div>
              <p>Registros: ${version.snapshot.entries_count ?? '—'} · Ajustes: ${version.snapshot.adjustments_count ?? '—'} · Supuestos: ${(version.snapshot.assumptions || []).length}</p>` });
          } catch (e) { EF.fail(e); }
        }));
      };

      const editHeader = d => {
        const r = d.report;
        EF.modal({ title: 'Editar datos del informe', okText: 'Guardar', wide: true, body: `<div class="map-grid">
          <label class="f"><span>Nombre</span><input id="h-title" value="${esc(r.title)}" maxlength="160"></label>
          ${r.modality === 'proyectado' ? `<label class="f"><span>Escenario</span><input id="h-sc" value="${esc(r.scenario || '')}" maxlength="120"></label>` : ''}
          ${r.modality === 'anual' ? `<label class="f"><span>Año fiscal</span><input id="h-fy" type="number" value="${r.fiscal_year || ''}"></label>` : ''}
          <label class="f"><span>Período fiscal</span><input id="h-fp" value="${esc(r.fiscal_period || '')}" maxlength="60"></label>
          <label class="f"><span>Inicio</span><input id="h-s" type="date" value="${r.period_start || ''}"></label><label class="f"><span>Fin / corte</span><input id="h-e" type="date" value="${r.period_end || ''}"></label>
          <label class="f"><span>Moneda</span><input id="h-cur" value="${esc(r.currency)}" maxlength="3"></label><label class="f"><span>Fecha de preparación</span><input id="h-prep" type="date" value="${r.prepared_on || ''}"></label>
          <label class="f" style="grid-column:1/-1"><span>Notas</span><textarea id="h-notes" rows="2" maxlength="4000">${esc(r.notes || '')}</textarea></label></div>`,
          onOk: async m => { const v = s => m.querySelector(s)?.value.trim(); await EF.api('PATCH', `reports/${r.id}`, { title: v('#h-title'), scenario: v('#h-sc'), fiscal_year: v('#h-fy'), fiscal_period: v('#h-fp'), period_start: v('#h-s'), period_end: v('#h-e'), currency: v('#h-cur'), prepared_on: v('#h-prep'), notes: v('#h-notes') }); load(); return true; } });
      };

      const compare = async d => {
        const { reports } = await EF.api('GET', `reports?client_id=${d.report.client_id}`);
        const others = reports.filter(x => x.id !== d.report.id);
        if (!others.length) { EF.toast('No hay otros informes de esta empresa para comparar.', 'err'); return; }
        const pick = await EF.modal({ title: 'Comparar con otro informe', okText: 'Comparar', body: `<label class="f"><span>Informe</span><select id="c-with">${others.map(o => `<option value="${o.id}">${esc(EF.mod(o.modality).singular)} · ${esc(o.title)} (${dateOnly(o.period_start)} – ${dateOnly(o.period_end)})</option>`).join('')}</select></label>`, onOk: m => m.querySelector('#c-with').value });
        if (!pick) return;
        try {
          const c = await EF.api('GET', `reports/${d.report.id}/compare?with=${pick}`);
          const who = x => `${esc(EF.mod(x.modality).singular)} «${esc(x.title)}» (${dateOnly(x.period_start)} – ${dateOnly(x.period_end)}; ${esc(x.status)}; v${x.version}; origen: ${x.source.length ? esc(x.source.join(', ')) : 'ingreso manual'})`;
          EF.modal({ title: 'Comparación', okText: '', cancelText: 'Cerrar', wide: true, body: `<p><b>A:</b> ${who(c.a)}<br><b>B:</b> ${who(c.b)}</p><p class="muted">${esc(c.note)}</p><div class="table-wrap"><table>${c.kind === 'proyectado_vs_real'
            ? `<tr><th>Cuenta</th><th>Concepto</th><th>Período</th><th class="num"><span class="proj-tag">Proyectado</span></th><th class="num"><span class="real-tag">Real</span></th><th class="num">Diferencia</th></tr>${c.rows.map(x => `<tr><td class="mono">${esc(x.account_code)}</td><td>${esc(x.name)}</td><td>${esc(x.period || '—')}</td><td class="num">${money(x.projected)}</td><td class="num">${x.real_found ? money(x.real) : 'sin registros'}</td><td class="num">${money(x.difference)}</td></tr>`).join('')}`
            : `<tr><th>Cuenta</th><th>Nombre</th><th class="num">A</th><th class="num">B</th><th class="num">B − A</th></tr>${c.rows.map(x => `<tr><td class="mono">${esc(x.account_code)}</td><td>${esc(x.name || '—')}</td><td class="num">${money(x.a)}</td><td class="num">${money(x.b)}</td><td class="num">${money(x.difference)}</td></tr>`).join('')}`}</table></div>` });
        } catch (e) { EF.fail(e); }
      };

      await load();
    },
  };
})();
