/* Auditoría fiscal: vista por lote y vista unificada; espacio de trabajo con
   el original a la izquierda (zoom, rotación, páginas) y los datos editables
   a la derecha (formulario u hoja). Guardar y aprobar son acciones distintas;
   la aprobación se valida de nuevo en el servidor. */
(function () {
  const { esc, money, int, period } = NALA;

  // Cent-exact helpers for the live reconciliation (server remains authoritative).
  const cents = v => { const t = String(v ?? '').trim().replace(/,/g, ''); if (!/^-?\d+(\.\d+)?$/.test(t)) return null; const [i, f = ''] = t.replace('-', '').split('.'); let c = BigInt(i) * 100n + BigInt((f + '00').slice(0, 2)); if (f.length > 2 && Number(f[2]) >= 5) c += 1n; return t.startsWith('-') ? -c : c; };
  const fmtC = c => (c === null ? '—' : money(Number(c) / 100));
  const sumC = arr => { let any = false; let t = 0n; for (const v of arr) { const c = cents(v); if (c !== null) { t += c; any = true; } } return any ? t : null; };

  // Mini-calculadora para los campos de monto (como en Excel). Si el valor
  // empieza con "=" o "+", se evalúa como fórmula: números y + - * / ( ). Útil
  // para facturas de súper que sólo traen el total: en Subtotal escribes
  // "=5815-888" (total − ITBIS) y guarda 4927.00. Sin "+"/"=" es un monto normal.
  function evalExpr(src) {
    const s = String(src); let i = 0;
    const ws = () => { while (i < s.length && s[i] === ' ') i++; };
    function numTok() { ws(); let j = i, dot = false; while (i < s.length && ((s[i] >= '0' && s[i] <= '9') || s[i] === '.')) { if (s[i] === '.') { if (dot) return NaN; dot = true; } i++; } return i === j ? NaN : Number(s.slice(j, i)); }
    function factor() { ws(); if (s[i] === '+') { i++; return factor(); } if (s[i] === '-') { i++; const v = factor(); return isNaN(v) ? NaN : -v; } if (s[i] === '(') { i++; const v = expr(); ws(); if (s[i] !== ')') return NaN; i++; return v; } return numTok(); }
    function term() { let v = factor(); ws(); while (s[i] === '*' || s[i] === '/') { const op = s[i++]; const r = factor(); if (isNaN(v) || isNaN(r)) return NaN; v = op === '*' ? v * r : (r === 0 ? NaN : v / r); ws(); } return v; }
    function expr() { ws(); let v = term(); ws(); while (s[i] === '+' || s[i] === '-') { const op = s[i++]; const r = term(); if (isNaN(v) || isNaN(r)) return NaN; v = op === '+' ? v + r : v - r; ws(); } return v; }
    if (/[^0-9.+\-*/() ]/.test(s)) return NaN;
    const v = expr(); ws();
    return (i === s.length && isFinite(v)) ? v : NaN;
  }
  // Devuelve el monto calculado (string con 2 decimales), null si no es fórmula,
  // o 'ERR' si empieza con =/+ pero no se puede evaluar.
  function formulaValue(raw) {
    const t = String(raw).trim();
    if (!(t.startsWith('=') || t.startsWith('+'))) return null;
    const body = t.slice(1).trim();
    if (body === '') return null;
    const v = evalExpr(body);
    if (!isFinite(v)) return 'ERR';
    return (Math.round((Math.abs(v) + Number.EPSILON) * 100) / 100 * Math.sign(v || 1)).toFixed(2);
  }

  const GROUPS = {
    '606': [
      ['Proveedor (emisor)', ['emisor_nombre', 'emisor_id', 'tipo_id']], ['Comprador (receptor)', ['receptor_nombre', 'receptor_id']],
      ['Comprobante', ['ncf', 'ncf_modificado', 'fecha_comprobante', 'fecha_pago', 'tipo_bienes_servicios', 'forma_pago']],
      ['Moneda', ['moneda', 'moneda_simbolo', 'tasa_cambio', 'tasa_fecha', 'tasa_fuente']],
      ['Montos', ['monto_servicios', 'monto_bienes', 'itbis', 'isc', 'otros_impuestos', 'propina', 'total']],
      ['ITBIS y retenciones', ['itbis_retenido', 'itbis_proporcionalidad', 'itbis_costo', 'itbis_percibido', 'isr_tipo_retencion', 'isr_retenido', 'isr_percibido']],
    ],
    '607': [
      ['Cliente (receptor)', ['receptor_nombre', 'receptor_id', 'tipo_id']], ['Emisor', ['emisor_nombre', 'emisor_id']],
      ['Comprobante', ['ncf', 'ncf_modificado', 'fecha_comprobante', 'tipo_ingreso', 'fecha_retencion']],
      ['Moneda', ['moneda', 'moneda_simbolo', 'tasa_cambio', 'tasa_fecha', 'tasa_fuente']],
      ['Montos', ['monto_facturado', 'itbis', 'isc', 'otros_impuestos', 'propina', 'total']],
      ['Retenciones de terceros', ['itbis_retenido', 'itbis_percibido', 'isr_retenido', 'isr_percibido']],
      ['Formas de pago (incluyen impuestos)', ['pago_efectivo', 'pago_cheque', 'pago_tarjeta', 'pago_credito', 'pago_bonos', 'pago_permuta', 'pago_otros']],
    ],
  };
  const READONLY = new Set(['moneda_simbolo']);
  const CURRENCIES = ['DOP', 'USD', 'EUR', 'CAD', 'GBP'];
  // "Incompleta": aún tiene algo que atender (error crítico o advertencia),
  // es decir, datos por llenar o revisar. Una factura limpia (✓) se salta.
  const isIncomplete = inv => (inv.critical_count || 0) > 0 || (inv.warning_count || 0) > 0;

  // Constructor de un control de edición de un campo, compartido por el espacio
  // de trabajo (detalle) y por la edición en línea de la lista.
  function fieldInput(key, defs, values, cat, editable) {
    const def = defs[key] || { label: key, type: 'text' }; const v = values[key] ?? '';
    const dis = !editable || READONLY.has(key) ? 'disabled' : '';
    const catalog = { tipo_bienes_servicios: cat.tipoBienesServicios, forma_pago: cat.formaPago, isr_tipo_retencion: cat.tipoRetencionIsr, tipo_ingreso: cat.tipoIngreso, tipo_id: cat.tipoId }[key];
    if (key === 'tipo_id') return `<select data-k="${key}" ${dis}><option value="">Automático (según RNC/cédula)</option>${NALA.catalogOptions(catalog, v, { blank: false })}</select>`;
    if (catalog) return `<select data-k="${key}" ${dis}>${NALA.catalogOptions(catalog, v)}</select>`;
    if (key === 'moneda') return `<select data-k="${key}" ${dis}><option value="">— Sin confirmar —</option>${CURRENCIES.map(c => `<option ${v === c ? 'selected' : ''}>${c}</option>`).join('')}${v && !CURRENCIES.includes(v) ? `<option selected>${esc(v)}</option>` : ''}</select>`;
    if (def.type === 'date') return `<input type="date" data-k="${key}" value="${esc(v)}" ${dis}>`;
    const amountHint = def.type === 'amount' ? ' title="Puedes escribir una fórmula: empieza con = o + (ej.: =5815-888 resta el ITBIS del total) y hace el cálculo solo."' : '';
    return `<input data-k="${key}" value="${esc(v)}" ${def.type === 'amount' || def.type === 'rate' ? 'inputmode="decimal" class="num"' : ''}${amountHint} ${dis} autocomplete="off">`;
  }

  function listQuery(params) {
    const s = NALA.state;
    const p = { batch_id: params.batch || '', client_id: params.batch ? '' : (params.client ?? s.client), period: params.batch ? '' : (params.period ?? s.period), format: params.batch ? '' : (params.format ?? s.format),
      status: params.status || '', has: params.has || '', q: params.q || '' };
    return new URLSearchParams(Object.entries(p).filter(([, v]) => v)).toString();
  }

  // ── Lista (por lote o unificada) ────────────────────────────────────────
  async function listView(root, params) {
    const s = NALA.state;
    const mode = params.batch ? 'batch' : 'unified';
    const qs = listQuery(params);
    const [{ invoices, total }, batchInfo, batchList] = await Promise.all([
      NALA.api('GET', `invoices?${qs}`),
      params.batch ? NALA.api('GET', `batches/${params.batch}`) : Promise.resolve(null),
      NALA.api('GET', `batches?${new URLSearchParams(Object.entries({ client_id: s.client, period: s.period, format: s.format }).filter(([, v]) => v))}`),
    ]);
    NALA.cache.auditList = { qs, ids: invoices.map(i => i.id), incomplete: invoices.filter(isIncomplete).map(i => i.id) };
    const set = (k, v) => { const p = { ...params, [k]: v }; if (!v) delete p[k]; NALA.go(`#/auditoria?${new URLSearchParams(p)}`); };
    // Aprobación masiva: sólo las de "cotejo verde" (sin errores ni avisos) que
    // aún estén pendientes de aprobar. El resto no se puede marcar.
    const isGreen = i => !i.critical_count && !i.warning_count && ['pending_review', 'reviewed'].includes(i.status);
    const canBulk = NALA.can('approve');
    const canEdit = NALA.can('edit');
    const canApprove = NALA.can('approve');
    const canExclude = NALA.can('exclude');
    const cat = s.me.catalogs || {};
    const defs = s.me.field_defs || {};
    const orderFor = fmt => (s.me.format_fields && s.me.format_fields[fmt]) || [];
    const approvable = invoices.filter(isGreen);
    const byId = Object.fromEntries(invoices.map(i => [i.id, i]));
    const editableInv = i => canEdit && ['pending_review', 'reviewed'].includes(i.status);
    const hasFixables = i => isIncomplete(i) || i.issues.some(x => x.code === 'DUPLICADO');
    const showFix = i => editableInv(i) && hasFixables(i);
    const unifiedCol = mode === 'unified' && !s.client;
    const cols = (canBulk ? 1 : 0) + 9 + (unifiedCol ? 1 : 0);
    let bulkRefresh = null;
    // Celdas que la edición en línea refresca sin recargar toda la tabla.
    const fixBtn = i => showFix(i) ? ` <button class="btn sm fix-btn" data-fix="${i.id}" title="Corregir aquí, sin abrir el detalle">✎ Corregir</button>` : '';
    const reviewCell = i => `${NALA.issueBadges(i)}${fixBtn(i)}`;
    const cpCell = i => `${esc(i.counterpart_name || '—')}<div class="muted mono">${esc(i.counterpart_id || '')}</div>`;
    const rowHtml = (i, n) => `<tr class="clickable" data-id="${i.id}">${canBulk ? `<td class="chk" data-c="chk">${isGreen(i) ? `<input type="checkbox" class="row-chk" data-cid="${i.id}">` : ''}</td>` : ''}<td class="muted">${n + 1}</td><td class="mono" data-c="ncf">${esc(i.ncf || '—')}</td><td data-c="cp">${cpCell(i)}</td>
      <td data-c="date">${esc(i.invoice_date || '—')}</td>${unifiedCol ? `<td>${esc(NALA.clientName(i.client_id))}</td>` : ''}<td>${i.format}</td><td>${esc(i.currency || '?')}</td><td class="num" data-c="total">${money(i.total_dop)}</td><td data-c="status">${NALA.badge(i.status)}</td><td data-c="review">${reviewCell(i)}</td></tr>
      <tr class="inline-edit" data-edit="${i.id}" hidden><td colspan="${cols}"></td></tr>`;
    root.innerHTML = `<div class="stack">
      <div class="tabs"><button class="${mode === 'batch' ? 'active' : ''}" id="t-batch">Vista por lotes</button><button class="${mode === 'unified' ? 'active' : ''}" id="t-uni">Vista unificada (empresa y período)</button></div>
      ${mode === 'batch' ? `<div class="row"><label class="f" style="min-width:320px"><span>Lote</span><select id="pick-batch">${batchList.batches.map(b => `<option value="${b.id}" ${b.id === params.batch ? 'selected' : ''}>${esc(b.name)} · ${esc(NALA.clientName(b.client_id))} · ${b.format} ${period(b.period)}</option>`).join('')}
        ${batchInfo && !batchList.batches.some(b => b.id === params.batch) ? `<option selected value="${params.batch}">${esc(batchInfo.batch.name)}</option>` : ''}</select></label>
        ${batchInfo ? `<span class="muted">${esc(batchInfo.batch.client_name)} · ${batchInfo.batch.format} · ${period(batchInfo.batch.period)} · ${NALA.badge(batchInfo.batch.status)}</span>` : ''}</div>`
        : `<div class="muted">${s.client ? esc(NALA.clientName(s.client)) : 'Todas las empresas (consolidado)'} · ${period(params.period ?? s.period)} · ${(params.format ?? s.format) || '606 y 607'} — cambie la empresa activa, el período o el formato arriba.</div>`}
      <div class="row">
        <label class="f"><span>Estado</span><select id="f-status"><option value="">Todos (sin excluidos)</option><option value="pending_review,reviewed" ${params.status === 'pending_review,reviewed' ? 'selected' : ''}>Pendientes</option><option value="approved" ${params.status === 'approved' ? 'selected' : ''}>Aprobados</option><option value="excluded" ${params.status === 'excluded' ? 'selected' : ''}>Excluidos</option></select></label>
        <label class="f"><span>Observaciones</span><select id="f-has"><option value="">Todas</option><option value="errors" ${params.has === 'errors' ? 'selected' : ''}>Con errores críticos</option><option value="warnings" ${params.has === 'warnings' ? 'selected' : ''}>Con advertencias</option><option value="duplicates" ${params.has === 'duplicates' ? 'selected' : ''}>Duplicados</option><option value="foreign" ${params.has === 'foreign' ? 'selected' : ''}>Moneda extranjera</option></select></label>
        <label class="f" style="flex:1;min-width:200px"><span>Buscar</span><input id="f-q" value="${esc(params.q || '')}" placeholder="NCF, RNC o nombre"></label>
        <span class="muted">${int(total)} comprobante(s)</span></div>
      ${invoices.some(showFix) ? '<div class="muted" style="font-size:12px">💡 Pulse <b>✎ Corregir</b> para arreglar lo señalado sin salir de la lista. Abra el detalle sólo si necesita ver el documento.</div>' : ''}
      ${canBulk && approvable.length ? `<div class="row" id="bulkbar" style="align-items:center;gap:12px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer" title="Marca todas las que tienen cotejo verde (sin errores ni avisos)"><input type="checkbox" id="sel-all"> Todas las de cotejo verde (${approvable.length})</label>
        <span class="spacer" style="flex:1"></span>
        <button class="btn ok" id="bulk-approve" disabled>✓ Aprobar seleccionadas (<span id="sel-count">0</span>)</button></div>` : ''}
      ${invoices.length ? `<div class="table-wrap"><table><tr>${canBulk ? '<th></th>' : ''}<th>#</th><th>NCF</th><th>Contraparte</th><th>Fecha</th>${unifiedCol ? '<th>Empresa</th>' : ''}<th>Fmt</th><th>Mon.</th><th class="num">Total DOP</th><th>Estado</th><th>Revisión</th></tr>
        ${invoices.map((i, n) => rowHtml(i, n)).join('')}</table></div>`
        : '<div class="card empty">No hay comprobantes con estos filtros.</div>'}</div>`;
    root.querySelector('#t-batch').addEventListener('click', () => NALA.go(`#/auditoria?batch=${batchList.batches[0]?.id || ''}`));
    root.querySelector('#t-uni').addEventListener('click', () => NALA.go('#/auditoria'));
    root.querySelector('#pick-batch')?.addEventListener('change', e => set('batch', e.target.value));
    root.querySelector('#f-status').addEventListener('change', e => set('status', e.target.value));
    root.querySelector('#f-has').addEventListener('change', e => set('has', e.target.value));
    root.querySelector('#f-q').addEventListener('change', e => set('q', e.target.value.trim()));
    root.querySelectorAll('tr.clickable[data-id]').forEach(tr => tr.addEventListener('click', e => {
      if (e.target.closest('.chk') || e.target.closest('.fix-btn') || e.target.closest('[data-act]')) return;
      NALA.go(`#/auditoria/${tr.dataset.id}?${new URLSearchParams(params)}`);
    }));

    // ── Edición en línea: corregir lo señalado sin abrir el detalle ─────────
    const editorRow = id => root.querySelector(`tr.inline-edit[data-edit="${id}"]`);
    const collapse = id => { const er = editorRow(id); if (er) { er.hidden = true; er.querySelector('td').innerHTML = ''; } root.querySelector(`[data-fix="${id}"]`)?.classList.remove('active'); };
    const readFields = td => { const out = {}; td.querySelectorAll('[data-k]').forEach(el => { out[el.dataset.k] = el.value.trim() === '' ? null : el.value.trim(); }); return out; };

    function buildEditor(td, inv) {
      const order = orderFor(inv.format);
      const sevOf = k => { const is = inv.issues.filter(x => x.field === k); return is.some(x => x.severity === 'critical') ? 'has-crit' : (is.some(x => x.severity === 'warning') ? 'has-warn' : ''); };
      const flagged = [...new Set(inv.issues.filter(x => x.field && x.severity !== 'info').map(x => x.field))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const notes = inv.issues.filter(x => x.severity !== 'info');
      const dup = inv.issues.find(x => x.code === 'DUPLICADO');
      const green = !inv.critical_count && !inv.warning_count;
      const values = { ...inv.fields };
      const notesHtml = notes.length ? notes.map(x => `<div class="issue ${x.severity}"><span class="ico">${x.severity === 'critical' ? '✕' : '!'}</span><span>${esc(x.message)}</span></div>`).join('') : '<div class="issue info"><span class="ico">✓</span>Sin observaciones. Puede aprobar.</div>';
      const hasFields = flagged.length > 0;
      const fieldsHtml = hasFields ? `<div class="fields" style="margin-top:8px">${flagged.map(k => `<label class="f ${sevOf(k)}" data-field="${k}"><span>${esc((defs[k] || {}).label || k)}</span>${fieldInput(k, defs, values, cat, true)}</label>`).join('')}</div>`
        : (green ? '' : '<p class="muted" style="margin-top:8px">Esta observación no se corrige con un solo campo: abra el detalle para revisarla.</p>');
      const detailLink = `#/auditoria/${inv.id}?${new URLSearchParams(params)}`;
      td.innerHTML = `<div class="inline-editor">
        <div class="stack" style="gap:4px">${dup ? `<div class="issue critical"><span class="ico">⛔</span><span><b>Factura repetida (dos copias).</b> ${esc(dup.message)} <b>Deja una y elimina la otra.</b></span>${dup.ref ? `<a class="btn sm" href="#/auditoria/${dup.ref}">Ver la otra</a>` : ''}</div>` : notesHtml}</div>
        ${dup ? '' : fieldsHtml}
        <div class="row" style="margin-top:10px;gap:8px;align-items:center">
          ${dup && canExclude ? '<button class="btn sm danger" data-act="discard">🗑 Descartar esta</button>' : ''}
          ${dup && dup.ref && canExclude ? `<button class="btn sm danger" data-act="discard-other" data-other="${esc(dup.ref)}">🗑 Descartar la otra</button>` : ''}
          ${!dup && hasFields ? '<button class="btn sm primary" data-act="save">Guardar</button>' : ''}
          ${!dup && canApprove ? `<button class="btn sm ok" data-act="approve" ${green ? '' : 'disabled'} title="${green ? 'Aprobar este comprobante' : 'Primero corrija lo señalado'}">✓ Aprobar</button>` : ''}
          <a class="btn sm" href="${detailLink}">Abrir detalle ▸</a>
          <span class="spacer" style="flex:1"></span>
          <button class="btn sm" data-act="close">Cerrar</button></div></div>`;
      td.querySelector('[data-act="close"]')?.addEventListener('click', () => collapse(inv.id));
      td.querySelector('[data-act="save"]')?.addEventListener('click', e => doSave(e.target, td, inv));
      td.querySelector('[data-act="approve"]')?.addEventListener('click', e => doApprove(e.target, inv));
      td.querySelector('[data-act="discard"]')?.addEventListener('click', e => doDiscard(e.target, inv));
      td.querySelector('[data-act="discard-other"]')?.addEventListener('click', e => doDiscardOther(e.target, inv));
      td.querySelectorAll('[data-k]').forEach(el => el.addEventListener('keydown', ev => { if (ev.key === 'Enter' && el.tagName !== 'SELECT') { ev.preventDefault(); td.querySelector('[data-act="save"]')?.click(); } }));
    }
    const expand = id => { const er = editorRow(id); if (!er) return; buildEditor(er.querySelector('td'), byId[id]); er.hidden = false; root.querySelector(`[data-fix="${id}"]`)?.classList.add('active'); er.querySelector('[data-k]')?.focus(); };
    const toggle = id => { const er = editorRow(id); if (er && !er.hidden) collapse(id); else expand(id); };
    const wireFix = scope => scope.querySelectorAll('[data-fix]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); toggle(b.dataset.fix); }));

    function handleInlineError(e) {
      if (e.status === 422 && e.data?.issues) { NALA.toast(`No se puede aprobar: ${e.data.issues.map(i => i.message).join(' · ')}`, 'err'); NALA.route(); return; }
      if ([409, 423].includes(e.status)) { NALA.toast(e.message, 'err'); NALA.route(); return; }
      NALA.fail(e);
    }
    function applyUpdate(upd) {
      byId[upd.id] = upd;
      const tr = root.querySelector(`tr.clickable[data-id="${upd.id}"]`);
      if (tr) {
        const set2 = (c, html) => { const el = tr.querySelector(`[data-c="${c}"]`); if (el) el.innerHTML = html; };
        set2('ncf', esc(upd.ncf || '—')); set2('cp', cpCell(upd)); set2('date', esc(upd.invoice_date || '—'));
        set2('total', money(upd.total_dop)); set2('status', NALA.badge(upd.status)); set2('review', reviewCell(upd));
        const chk = tr.querySelector('[data-c="chk"]');
        if (chk) { chk.innerHTML = isGreen(upd) && bulkRefresh ? `<input type="checkbox" class="row-chk" data-cid="${upd.id}">` : '';
          const nc = chk.querySelector('.row-chk'); if (nc && bulkRefresh) { nc.addEventListener('change', bulkRefresh); chk.addEventListener('click', e => e.stopPropagation()); } }
        wireFix(tr);
      }
      const er = editorRow(upd.id);
      // Si el editor está abierto se reconstruye con la versión nueva; se mantiene
      // abierto aunque ya quede verde, para poder «Aprobar» ahí mismo. Sólo se
      // cierra cuando el comprobante sale de edición (aprobado o excluido).
      if (er && !er.hidden) { if (editableInv(upd)) buildEditor(er.querySelector('td'), upd); else collapse(upd.id); }
      if (bulkRefresh) bulkRefresh();
    }
    async function doSave(btn, td, inv) {
      const current = readFields(td);
      const changed = {}; for (const [k, v] of Object.entries(current)) if ((inv.fields[k] ?? null) !== v) changed[k] = v;
      const confirmations = Object.fromEntries((inv.issues || []).filter(x => x.code === 'CLASIFICACION_SUGERIDA' && x.field).map(x => [x.field, x.field in current ? current[x.field] : (inv.fields[x.field] ?? null)]));
      const fields = { ...confirmations, ...changed };
      if (!Object.keys(fields).length) { NALA.toast('No hay cambios que guardar.', 'err'); return; }
      btn.disabled = true; btn.textContent = 'Guardando…';
      try { const r = await NALA.api('PATCH', `invoices/${inv.id}`, { version: inv.version, fields }); applyUpdate(r.invoice);
        NALA.toast(isIncomplete(r.invoice) ? 'Guardado. Aún quedan observaciones.' : 'Guardado. Cotejo verde ✓', 'ok'); } catch (e) { handleInlineError(e); }
    }
    async function doApprove(btn, inv) {
      btn.disabled = true; btn.textContent = 'Aprobando…';
      try { const r = await NALA.api('POST', `invoices/${inv.id}/approve`, { version: inv.version }); applyUpdate(r.invoice); NALA.toast('Comprobante aprobado ✓', 'ok'); collapse(inv.id); } catch (e) { handleInlineError(e); }
    }
    async function doDiscard(btn, inv) {
      const dup = inv.issues.find(x => x.code === 'DUPLICADO');
      btn.disabled = true;
      try { const r = await NALA.api('POST', `invoices/${inv.id}/exclude`, { reason: `Factura repetida. ${dup?.message || ''}`.slice(0, 500) }); applyUpdate(r.invoice); NALA.toast('Copia descartada', 'ok'); collapse(inv.id); } catch (e) { handleInlineError(e); }
    }
    // Descarta la OTRA copia (la del otro lote) y conserva ésta.
    async function doDiscardOther(btn, inv) {
      const dup = inv.issues.find(x => x.code === 'DUPLICADO');
      if (!dup?.ref) return;
      if (!confirm('¿Descartar la OTRA copia (la del otro lote) y conservar ésta? Se excluye la otra factura, no la que ves aquí.')) return;
      btn.disabled = true;
      try { await NALA.api('POST', `invoices/${dup.ref}/exclude`, { reason: 'Factura repetida; se conserva la otra copia.' }); NALA.toast('La otra copia fue descartada', 'ok'); NALA.route(); } catch (e) { btn.disabled = false; handleInlineError(e); }
    }

    // Aprobación masiva (sólo cotejo verde).
    if (canBulk && approvable.length) {
      const rowChks = () => Array.from(root.querySelectorAll('.row-chk'));
      const selAll = root.querySelector('#sel-all');
      const btn = root.querySelector('#bulk-approve');
      const refreshSel = () => { const n = rowChks().filter(c => c.checked).length; const cnt = root.querySelector('#sel-count'); if (cnt) cnt.textContent = n; if (btn) btn.disabled = !n;
        if (selAll) selAll.checked = n > 0 && n === rowChks().length; };
      bulkRefresh = refreshSel;
      root.querySelectorAll('.chk').forEach(td => td.addEventListener('click', e => e.stopPropagation()));
      rowChks().forEach(c => c.addEventListener('change', refreshSel));
      selAll?.addEventListener('change', () => { rowChks().forEach(c => { c.checked = selAll.checked; }); refreshSel(); });
      btn.addEventListener('click', async () => {
        const ids = rowChks().filter(c => c.checked).map(c => c.dataset.cid);
        if (!ids.length) return;
        const ok = await NALA.modal({ title: 'Aprobar en lote', okText: 'Aprobar', okClass: 'ok',
          body: `<p>Se aprobarán <b>${ids.length}</b> comprobante(s) de cotejo verde (sin errores ni avisos). Los que tengan errores o advertencias se omiten y se aprueban uno por uno.</p>` });
        if (!ok) return;
        btn.disabled = true; btn.textContent = 'Aprobando…';
        try {
          const r = await NALA.api('POST', 'invoices/approve-bulk', { ids });
          const extra = r.skipped_count ? `, ${r.skipped_count} omitida(s)` : '';
          NALA.toast(`${r.approved_count} aprobada(s)${extra}.`, r.approved_count ? 'ok' : 'err');
          NALA.route();
        } catch (e) { NALA.fail(e); btn.disabled = false; btn.textContent = '✓ Aprobar seleccionadas'; }
      });
    }
    wireFix(root);
  }

  // ── Visor del original ──────────────────────────────────────────────────
  async function mountViewer(el, documentId, startPage) {
    if (!documentId) { el.innerHTML = '<div class="empty">Sin documento original.</div>'; return; }
    let info;
    try { info = await NALA.api('GET', `documents/${documentId}/url`); } catch (e) { el.innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`; return; }
    const doc = info.document;
    const st = { zoom: 1, rot: 0, page: startPage || 1, pages: doc.page_count || 1, pdf: null, fit: true };
    el.innerHTML = `<div class="viewer-tools"><button class="btn sm" data-a="prev" title="Página anterior">◀</button><span class="muted" data-pg></span><button class="btn sm" data-a="next" title="Página siguiente">▶</button>
      <button class="btn sm" data-a="out" title="Alejar">−</button><span class="muted" data-zm></span><button class="btn sm" data-a="in" title="Acercar">+</button><button class="btn sm" data-a="fit">Ajustar</button>
      <button class="btn sm" data-a="rot" title="Rotar">⟳ 90°</button><a class="btn sm" href="${esc(info.url)}" target="_blank" rel="noopener">Abrir original</a><span class="muted mono" title="Huella SHA-256 del original">${esc((doc.sha256 || '').slice(0, 12))}…</span></div>
      <div class="viewer-canvas" data-canvas></div>`;
    const canvasBox = el.querySelector('[data-canvas]');
    const draw = async () => {
      el.querySelector('[data-pg]').textContent = `Pág. ${st.page}/${st.pages}`;
      el.querySelector('[data-zm]').textContent = `${Math.round(st.zoom * 100)}%`;
      const avail = Math.max(200, canvasBox.clientWidth - 24);
      if (doc.kind === 'image') {
        let img = canvasBox.querySelector('img');
        if (!img) {
          // Primero la previsualización (ligera); si falla, el original. Un
          // aviso de carga evita que el visor se vea congelado mientras llega.
          if (!canvasBox.querySelector('img')) canvasBox.innerHTML = '<div class="muted" style="padding:16px">Cargando imagen…</div>';
          img = document.createElement('img'); img.alt = doc.name; img.decoding = 'async';
          const full = info.url;
          // Si la previsualización ya falló antes en esta sesión (transformación
          // no disponible), se va directo al original y no se pierde una petición.
          const preview = (NALA.cache.imgPreviewBroken || !info.preview_url) ? full : info.preview_url;
          await new Promise(resolve => {
            let usedPreview = preview !== full;
            img.onload = resolve;
            img.onerror = () => { if (usedPreview) { usedPreview = false; NALA.cache.imgPreviewBroken = true; img.src = full; } else resolve(); };
            img.src = preview;
          });
          canvasBox.innerHTML = ''; canvasBox.appendChild(img);
          st.base = img.naturalWidth || 800; st.baseH = img.naturalHeight || 800;
        }
        const sideways = st.rot % 180 !== 0;
        if (st.fit) st.zoom = Math.min(4, avail / (sideways ? st.baseH : st.base));
        img.style.width = `${st.base * st.zoom}px`;
        // Rotating with CSS keeps the layout box; reserve room so nothing is clipped.
        img.style.transform = `rotate(${st.rot}deg)`;
        img.style.margin = sideways ? `${(st.base - st.baseH) * st.zoom / 2}px auto` : '0 auto';
      } else {
        if (!st.pdf) {
          // Cargar el documento una vez y reusarlo al navegar entre comprobantes
          // del mismo archivo, pero dejando que pdf.js lo pida por rangos: así la
          // página que se mira aparece enseguida sin esperar a descargar todo el
          // PDF (que puede pesar decenas de MB en escaneos de muchas páginas).
          const key = `${documentId}:${doc.sha256 || ''}`;
          if (NALA.cache.viewerPdf?.key !== key) {
            if (!canvasBox.querySelector('canvas')) canvasBox.innerHTML = '<div class="muted" style="padding:16px">Cargando documento…</div>';
            NALA.cache.viewerPdf = { key, pdf: await pdfjsLib.getDocument({ url: info.url, disableAutoFetch: true, rangeChunkSize: 262144 }).promise };
          }
          st.pdf = NALA.cache.viewerPdf.pdf; st.pages = st.pdf.numPages;
        }
        const page = await st.pdf.getPage(st.page);
        const natural = page.getViewport({ scale: 1, rotation: st.rot });
        if (st.fit) st.zoom = Math.min(4, avail / natural.width / 1.5);
        const viewport = page.getViewport({ scale: 1.5 * st.zoom, rotation: st.rot });
        const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        canvasBox.innerHTML = ''; canvasBox.appendChild(canvas);
        el.querySelector('[data-pg]').textContent = `Pág. ${st.page}/${st.pages}`;
      }
    };
    el.querySelector('.viewer-tools').addEventListener('click', e => {
      const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
      if (a === 'prev' && st.page > 1) st.page--; if (a === 'next' && st.page < st.pages) st.page++;
      if (a === 'in') { st.fit = false; st.zoom = Math.min(4, st.zoom + 0.25); }
      if (a === 'out') { st.fit = false; st.zoom = Math.max(0.25, st.zoom - 0.25); }
      if (a === 'fit') st.fit = true;
      if (a === 'rot') st.rot = (st.rot + 90) % 360;
      draw().catch(err => NALA.fail(err));
    });
    if (typeof pdfjsLib !== 'undefined') pdfjsLib.GlobalWorkerOptions.workerSrc = '/cami/vendor/pdf.worker.min.js';
    await draw().catch(err => { canvasBox.innerHTML = `<div class="empty">No se pudo mostrar el documento: ${esc(err.message)}</div>`; });
  }

  // ── Espacio de trabajo de una factura ───────────────────────────────────
  async function workspace(root, id, params, isCurrent, onCleanup) {
    const d = await NALA.api('GET', `invoices/${id}`);
    if (!isCurrent()) return;
    const inv = d.invoice; const defs = d.field_defs; const cat = NALA.state.me.catalogs;
    const editable = NALA.can('edit') && ['pending_review', 'reviewed'].includes(inv.status) && !d.lock.locked_by_other;
    const values = { ...inv.fields };
    const undo = [];
    let mode = 'form';
    NALA.dirty = false;
    // Neighbors from the list the user came from.
    let cached = NALA.cache.auditList?.qs === listQuery(params) ? NALA.cache.auditList : null;
    if (!cached) { const r = await NALA.api('GET', `invoices?${listQuery(params)}`); cached = { qs: listQuery(params), ids: r.invoices.map(i => i.id), incomplete: r.invoices.filter(isIncomplete).map(i => i.id) }; NALA.cache.auditList = cached; }
    const ids = cached.ids;
    const incompleteSet = new Set(cached.incomplete || []);
    const pos = ids.indexOf(inv.id);
    const back = `#/auditoria?${new URLSearchParams(params)}`;
    // Con "Solo incompletas" activo, Anterior/Siguiente saltan las ya limpias.
    const skipComplete = () => root.querySelector('#skip-complete')?.checked ?? false;
    const seekIndex = dir => { for (let k = pos + dir; k >= 0 && k < ids.length; k += dir) { if (!skipComplete() || incompleteSet.has(ids[k])) return k; } return -1; };
    const navTo = dir => { const k = seekIndex(dir); if (k >= 0) NALA.go(`#/auditoria/${ids[k]}?${new URLSearchParams(params)}`); };
    const refreshNav = () => {
      const p = root.querySelector('#prev'); const n = root.querySelector('#next'); const c = root.querySelector('#nav-count');
      if (p) p.disabled = seekIndex(-1) < 0;
      if (n) n.disabled = seekIndex(1) < 0;
      if (c) c.textContent = skipComplete() ? `${incompleteSet.size} por revisar` : (pos >= 0 ? `${pos + 1} de ${ids.length}` : '');
    };

    const issuesByField = {};
    for (const i of inv.issues) if (i.field) (issuesByField[i.field] ||= []).push(i);

    const input = key => fieldInput(key, defs, values, cat, editable);
    const fieldLabel = key => {
      const sev = (issuesByField[key] || []).some(i => i.severity === 'critical') ? 'has-crit' : ((issuesByField[key] || []).some(i => i.severity === 'warning') ? 'has-warn' : '');
      const changed = (values[key] ?? null) !== (inv.fields[key] ?? null) ? 'changed' : '';
      return `<label class="f ${sev} ${changed} ${['emisor_nombre', 'receptor_nombre', 'tasa_fuente'].includes(key) ? 'full' : ''}" data-field="${key}"><span>${esc(defs[key]?.label || key)}${inv.corrected_fields.includes(key) ? ' <span class="badge accent" title="Revisado por una persona">✎</span>' : ''}</span>${input(key)}</label>`;
    };

    function recon() {
      const f = values;
      const sub = inv.format === '606' ? sumC([f.monto_servicios, f.monto_bienes]) : cents(f.monto_facturado);
      const taxes = sumC([f.itbis, f.isc, f.otros_impuestos, f.propina]);
      const calc = sub === null ? null : sub + (taxes || 0n);
      const ext = cents(f.total);
      const diff = calc !== null && ext !== null ? ext - calc : null;
      const pays = inv.format === '607' ? sumC([f.pago_efectivo, f.pago_cheque, f.pago_tarjeta, f.pago_credito, f.pago_bonos, f.pago_permuta, f.pago_otros]) : null;
      return `<div><small>Subtotal</small><b>${fmtC(sub)}</b></div><div><small>Impuestos</small><b>${fmtC(taxes)}</b></div><div><small>Total calculado</small><b>${fmtC(calc)}</b></div><div><small>Total</small><b>${fmtC(ext)}</b></div>
        <div class="${diff !== null && diff !== 0n ? 'bad' : ''}"><small>Diferencia</small><b>${fmtC(diff)}</b></div>${inv.format === '607' ? `<div class="${pays !== null && calc !== null && pays !== calc ? 'bad' : ''}"><small>Formas de pago</small><b>${fmtC(pays)}</b></div>` : ''}
        ${f.moneda && f.moneda !== 'DOP' ? `<div><small>Total en DOP</small><b>${money(inv.total_dop)}</b></div>` : ''}<div><small>Moneda</small><b>${esc(f.moneda || '¿?')}</b></div>`;
    }

    // "Total" se calcula solo: suma de las casillas de Montos (base + impuestos).
    const TOTAL_PARTS = inv.format === '606'
      ? ['monto_servicios', 'monto_bienes', 'itbis', 'isc', 'otros_impuestos', 'propina']
      : ['monto_facturado', 'itbis', 'isc', 'otros_impuestos', 'propina'];
    const centsToStr = c => { if (c === null) return null; const neg = c < 0n; const a = neg ? -c : c; return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };
    function syncTotal() {
      values.total = centsToStr(sumC(TOTAL_PARTS.map(k => values[k])));
      const el = root.querySelector('#fieldsbox [data-k="total"]');
      if (el) { el.value = values.total ?? ''; el.closest('[data-field]')?.classList.toggle('changed', (inv.fields.total ?? null) !== (values.total ?? null)); }
      const rec = root.querySelector('#recon'); if (rec) rec.innerHTML = recon();
    }

    const groups = GROUPS[inv.format];
    const sheet = () => `<div class="table-wrap sheet"><table><tr><th>Campo</th><th>Valor</th><th></th></tr>${groups.flatMap(([, keys]) => keys).map(k => `<tr data-field="${k}"><td>${esc(defs[k]?.label || k)}</td><td>${input(k)}</td><td>${(issuesByField[k] || []).map(i => `<span class="badge ${i.severity === 'critical' ? 'crit' : i.severity === 'warning' ? 'warn' : 'info'}" title="${esc(i.message)}">${i.severity === 'critical' ? '✕' : '!'}</span>`).join('')}</td></tr>`).join('')}</table></div>`;
    const form = () => groups.map(([title, keys]) => `<div style="margin:10px 0 4px;font-weight:700;font-size:12px">${esc(title)}</div><div class="fields">${keys.map(fieldLabel).join('')}</div>`).join('');

    const issueHtml = inv.issues.length ? inv.issues.map(i => `<div class="issue ${i.severity}"><span class="ico">${i.severity === 'critical' ? '✕' : i.severity === 'warning' ? '!' : 'i'}</span><span>${esc(i.message)}</span>
      ${i.ref ? `<button class="btn sm" data-open="${i.ref}">Ver otro</button>` : ''}${i.field ? `<button class="btn sm" data-focus="${i.field}">Ir al campo</button>` : ''}</div>`).join('') : '<div class="issue info"><span class="ico">✓</span>Sin observaciones.</div>';

    root.innerHTML = `<div class="stack">
      <div class="row"><button class="btn" data-href="${back}">← Volver a la lista</button><button class="btn" id="prev">◀ Anterior</button><span class="muted" id="nav-count"></span><button class="btn" id="next">Siguiente ▶</button>
        <label class="muted" style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer" title="Salta las facturas que ya están completas (sin errores ni avisos)"><input type="checkbox" id="skip-complete" checked> Solo incompletas</label>
        <span class="spacer" style="flex:1"></span>${NALA.badge(inv.status)} <span class="badge">${inv.format}</span> <span class="muted">${esc(d.client.legal_name)} · ${period(inv.period)}${d.batch ? ` · lote <a href="#/lotes/${d.batch.id}">${esc(d.batch.name)}</a>` : ''}${d.reallocated ? ' · <span class="badge info">Reubicada</span>' : ''}</span></div>
      ${(() => { const dup = inv.issues.find(i => i.code === 'DUPLICADO'); if (!dup || inv.status === 'excluded') return ''; return `<div class="issue critical" style="font-size:14px;padding:12px;flex-wrap:wrap"><span class="ico">⛔</span><span><b>Factura repetida: hay dos copias del mismo NCF.</b> ${esc(dup.message)} <b>Deja una y elimina la otra:</b></span>
        ${dup.ref ? `<a class="btn sm" href="#/auditoria/${dup.ref}">Ver la otra</a>` : ''}${NALA.can('exclude') && inv.status !== 'approved' ? '<button class="btn sm danger" id="discard-copy">🗑 Descartar esta</button>' : ''}${dup.ref && NALA.can('exclude') ? `<button class="btn sm danger" id="discard-other" data-other="${esc(dup.ref)}">🗑 Descartar la otra</button>` : ''}</div>`; })()}
      ${d.lock.locked_by_other ? '<div class="issue warning"><span class="ico">🔒</span>Otro usuario está editando este comprobante. Se muestra en sólo lectura hasta que lo libere.</div>' : ''}
      ${inv.status === 'approved' ? `<div class="issue info"><span class="ico">✓</span>Aprobado ${NALA.dateTime(inv.approved_at)}${inv.approval_reason ? ` · motivo: ${esc(inv.approval_reason)}` : ''}. Para editar, revierta la aprobación.</div>` : ''}
      <div class="audit">
        <div class="card viewer" id="viewer"></div>
        <div class="card editor">
          <div class="tabs"><button class="active" data-tab="data">Datos</button><button data-tab="history">Historial (${d.events.length})</button>${d.exports.length ? `<button data-tab="exports">Exportaciones (${d.exports.length})</button>` : ''}</div>
          <div class="editor-body" id="ebody">
            <div data-pane="data"><div class="stack" style="gap:6px">${issueHtml}</div>
              <div class="recon" id="recon">${recon()}</div>
              <div class="row" style="justify-content:space-between"><div class="tabs" style="border:0;margin:0"><button class="active" data-mode="form">Formulario</button><button data-mode="sheet">Hoja</button></div><span class="muted">Página(s) ${inv.page_from ?? '—'}${inv.page_to && inv.page_to !== inv.page_from ? `–${inv.page_to}` : ''} · v${inv.version}</span></div>
              <div id="fieldsbox">${form()}</div></div>
            <div data-pane="history" hidden><div class="timeline">${d.events.map(e => `<div><b>${esc(NALA.actionLabel(e.action))}</b> · ${NALA.dateTime(e.created_at)}${e.reason ? `<br>Motivo: ${esc(e.reason)}` : ''}${e.details?.changes ? `<br>${Object.entries(e.details.changes).map(([k, [a, b]]) => `${esc(defs[k]?.label || k)}: <s>${esc(a ?? '∅')}</s> → ${esc(b ?? '∅')}`).join('<br>')}` : ''}${e.details?.from ? `<br>De ${esc(NALA.clientName(e.details.from.client_id))} ${period(e.details.from.period)} a ${esc(NALA.clientName(e.details.to.client_id))} ${period(e.details.to.period)}` : ''}</div>`).join('')}</div></div>
            <div data-pane="exports" hidden>${d.exports.map(x => `<div><a href="#/exportar/${x.export_id}">${esc(x.file_name)}</a> · línea ${x.line_no} · ${NALA.badge(x.status)}</div>`).join('')}</div>
          </div>
          <div class="row" style="border-top:1px solid var(--border);padding-top:10px;margin-top:8px">
            ${editable ? '<button class="btn" id="undo" disabled>↶ Deshacer</button><button class="btn primary" id="save" disabled>Guardar</button>' : ''}
            ${editable && NALA.can('approve') ? '<button class="btn ok" id="approve">Aprobar</button>' : ''}
            ${inv.status === 'approved' && NALA.can('revert') ? '<button class="btn danger" id="revert">Revertir aprobación</button>' : ''}
            ${editable && NALA.can('relocate') ? '<button class="btn" id="relocate">Reubicar</button>' : ''}
            ${editable && NALA.can('exclude') ? '<button class="btn danger" id="exclude">Excluir</button>' : ''}
            ${inv.status === 'excluded' && NALA.can('exclude') ? '<button class="btn" id="restore">Restaurar</button>' : ''}
          </div></div></div></div>`;

    mountViewer(root.querySelector('#viewer'), inv.document_id, inv.page_from);
    root.querySelectorAll('[data-href]').forEach(el => el.addEventListener('click', () => NALA.go(el.dataset.href)));
    root.querySelector('#prev').addEventListener('click', () => navTo(-1));
    root.querySelector('#next').addEventListener('click', () => navTo(1));
    root.querySelector('#skip-complete')?.addEventListener('change', refreshNav);
    refreshNav();
    root.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
      root.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === b));
      root.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.tab; });
    }));
    root.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => NALA.go(`#/auditoria/${b.dataset.open}`)));
    const bindFields = () => {
      root.querySelectorAll('#fieldsbox [data-k]').forEach(el => el.addEventListener('change', () => {
        const k = el.dataset.k;
        if (defs[k]?.type === 'amount') {
          const fv = formulaValue(el.value);
          if (fv === 'ERR') { NALA.toast('Fórmula inválida: use sólo números y + - * / ( ).', 'err'); el.value = values[k] ?? ''; return; }
          if (fv !== null) el.value = fv; // "=5815-888" → "4927.00"
        }
        const v = el.value.trim() === '' ? null : el.value.trim();
        if ((values[k] ?? null) === v) return;
        undo.push([k, values[k] ?? null]); values[k] = v; NALA.dirty = true;
        el.closest('[data-field]')?.classList.toggle('changed', (inv.fields[k] ?? null) !== v);
        if (TOTAL_PARTS.includes(k)) syncTotal(); else root.querySelector('#recon').innerHTML = recon();
        refreshButtons();
      }));
      // El Total no se teclea: se calcula solo con la suma de las casillas.
      const tot = root.querySelector('#fieldsbox [data-k="total"]');
      if (tot && editable) { tot.readOnly = true; tot.classList.add('auto'); tot.title = 'Se calcula solo: suma de las casillas de Montos'; }
      syncTotal();
      // Spreadsheet-like keyboard navigation in the sheet view.
      root.querySelectorAll('.sheet [data-k]').forEach((el, i, all) => el.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); el.dispatchEvent(new Event('change')); all[i + 1]?.focus(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); el.dispatchEvent(new Event('change')); all[i - 1]?.focus(); }
      }));
    };
    root.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
      mode = b.dataset.mode; root.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('active', x === b));
      root.querySelector('#fieldsbox').innerHTML = mode === 'form' ? form() : sheet(); bindFields();
    }));
    bindFields();
    root.querySelectorAll('[data-focus]').forEach(b => b.addEventListener('click', () => { const el = root.querySelector(`#fieldsbox [data-k="${b.dataset.focus}"]`); el?.scrollIntoView({ block: 'center' }); el?.focus(); }));

    const changedFields = () => Object.fromEntries(Object.keys(values).concat(Object.keys(inv.fields)).filter((k, i, a) => a.indexOf(k) === i && (values[k] ?? null) !== (inv.fields[k] ?? null)).map(k => [k, values[k] ?? null]));
    // Suggested classifications count as reviewed when the auditor saves.
    const confirmations = () => Object.fromEntries((inv.issues || []).filter(i => i.code === 'CLASIFICACION_SUGERIDA' && i.field).map(i => [i.field, values[i.field] ?? null]));
    function refreshButtons() {
      const dirty = Object.keys(changedFields()).length > 0;
      NALA.dirty = dirty;
      if (root.querySelector('#save')) root.querySelector('#save').disabled = !dirty && !(inv.status === 'pending_review');
      if (root.querySelector('#undo')) root.querySelector('#undo').disabled = !undo.length;
    }
    refreshButtons();
    root.querySelector('#undo')?.addEventListener('click', () => {
      const last = undo.pop(); if (!last) return;
      values[last[0]] = last[1];
      root.querySelector('#fieldsbox').innerHTML = mode === 'form' ? form() : sheet(); bindFields();
      root.querySelector('#recon').innerHTML = recon(); refreshButtons();
    });
    const save = async () => {
      const r = await NALA.api('PATCH', `invoices/${inv.id}`, { version: inv.version, fields: { ...confirmations(), ...changedFields() } });
      NALA.dirty = false; NALA.toast('Guardado', 'ok');
      return r.invoice;
    };
    const handleConflict = e => { if (e.status === 409 || e.status === 423) { NALA.dirty = false; NALA.toast(e.message, 'err'); NALA.route(); } else NALA.fail(e); };
    root.querySelector('#save')?.addEventListener('click', async () => { try { await save(); NALA.route(); } catch (e) { handleConflict(e); } });
    root.querySelector('#approve')?.addEventListener('click', async () => {
      try {
        let current = inv;
        if (Object.keys(changedFields()).length || inv.status === 'pending_review') current = await save();
        if (current.critical_count > 0) { NALA.toast('No se puede aprobar: hay errores críticos.', 'err'); NALA.route(); return; }
        const warnings = current.issues.filter(i => i.severity === 'warning');
        let body = { version: current.version };
        if (warnings.length) {
          const reason = await NALA.modal({ title: 'Aprobar con advertencias', okText: 'Aprobar', okClass: 'ok',
            body: `<div class="stack" style="gap:6px;margin-bottom:10px">${warnings.map(w => `<div class="issue warning"><span class="ico">!</span>${esc(w.message)}</div>`).join('')}</div>
              <label><input type="checkbox" id="acc"> Revisé las advertencias contra el documento original</label>
              <label class="f" style="margin-top:8px"><span>Motivo</span><textarea id="why" rows="2"></textarea></label>`,
            onOk: m => { if (!m.querySelector('#acc').checked) throw new Error('Confirme que revisó las advertencias.'); const v = m.querySelector('#why').value.trim(); if (v.length < 5) throw new Error('Indique el motivo (mín. 5 caracteres).'); return v; } });
          if (!reason) { NALA.route(); return; }
          body = { ...body, accept_warnings: true, reason };
        }
        await NALA.api('POST', `invoices/${inv.id}/approve`, body);
        NALA.toast('Comprobante aprobado', 'ok');
        if (ids[pos + 1]) navTo(1); else NALA.route();
      } catch (e) { if (e.status === 422 && e.data?.issues) NALA.toast(`No se puede aprobar: ${e.data.issues.map(i => i.message).join(' · ')}`, 'err'); handleConflict(e); }
    });
    root.querySelector('#revert')?.addEventListener('click', async () => {
      const reason = await NALA.askReason('Revertir aprobación', { extra: '<p class="muted" style="margin-bottom:8px">El comprobante vuelve a revisión. Si estaba en una exportación generada (no enviada), esa exportación queda reemplazada.</p>' });
      if (!reason) return;
      try { await NALA.api('POST', `invoices/${inv.id}/revert`, { reason }); NALA.toast('Aprobación revertida', 'ok'); NALA.route(); } catch (e) { handleConflict(e); }
    });
    root.querySelector('#relocate')?.addEventListener('click', async () => {
      if (NALA.dirty) { NALA.toast('Guarde o deshaga los cambios antes de reubicar.', 'err'); return; }
      const r = await NALA.modal({ title: 'Reubicar comprobante', okText: 'Reubicar',
        body: `<p class="muted" style="margin-bottom:8px">El mismo comprobante (sin copiarlo) pasa a otra empresa o período autorizado. Queda registrado en el historial.</p>
          <div class="fields"><label class="f full"><span>Empresa destino</span><select id="rc">${NALA.clientOptions(inv.client_id)}</select></label>
          <label class="f"><span>Período destino</span><input type="month" id="rp" value="${inv.period.slice(0, 4)}-${inv.period.slice(4)}"></label>
          <label class="f full"><span>Motivo</span><textarea id="rr" rows="2"></textarea></label></div>`,
        onOk: m => ({ client_id: m.querySelector('#rc').value, period: m.querySelector('#rp').value.replace('-', ''), reason: m.querySelector('#rr').value.trim() }) });
      if (!r) return;
      try { await NALA.api('POST', `invoices/${inv.id}/relocate`, r); NALA.toast('Comprobante reubicado', 'ok'); NALA.route(); } catch (e) { handleConflict(e); }
    });
    root.querySelector('#exclude')?.addEventListener('click', async () => {
      const reason = await NALA.askReason('Excluir comprobante', { extra: '<p class="muted" style="margin-bottom:8px">No se reporta ni se cuenta en los indicadores. Puede restaurarse.</p>' });
      if (!reason) return;
      try { await NALA.api('POST', `invoices/${inv.id}/exclude`, { reason }); NALA.toast('Excluido', 'ok'); NALA.route(); } catch (e) { handleConflict(e); }
    });
    root.querySelector('#discard-copy')?.addEventListener('click', async () => {
      try { await NALA.api('POST', `invoices/${inv.id}/exclude`, { reason: `Factura repetida. ${inv.issues.find(i => i.code === 'DUPLICADO').message}`.slice(0, 500) }); NALA.dirty = false; NALA.toast('Copia descartada', 'ok'); if (ids[pos + 1]) navTo(1); else NALA.route(); } catch (e) { handleConflict(e); }
    });
    root.querySelector('#discard-other')?.addEventListener('click', async (ev) => {
      const other = ev.currentTarget.dataset.other;
      if (!confirm('¿Descartar la OTRA copia (la del otro lote) y conservar ésta? Se excluye la otra factura, no la que ves aquí.')) return;
      try { await NALA.api('POST', `invoices/${other}/exclude`, { reason: 'Factura repetida; se conserva la otra copia.' }); NALA.dirty = false; NALA.toast('La otra copia fue descartada', 'ok'); NALA.route(); } catch (e) { handleConflict(e); }
    });
    root.querySelector('#restore')?.addEventListener('click', async () => {
      try { await NALA.api('POST', `invoices/${inv.id}/restore`, { reason: '' }); NALA.toast('Restaurado', 'ok'); NALA.route(); } catch (e) { handleConflict(e); }
    });

    // Concurrent editing: hold a short lock while the workspace is open.
    if (editable) {
      const lock = () => NALA.api('POST', `invoices/${inv.id}/lock`).catch(e => { if (e.status === 423) { NALA.toast(e.message, 'err'); NALA.route(); } });
      await lock();
      const beat = setInterval(lock, 60000);
      onCleanup(() => { clearInterval(beat); NALA.api('DELETE', `invoices/${inv.id}/lock`).catch(() => {}); });
    }
  }

  NALA.views.auditoria = {
    title: 'Auditoría fiscal',
    render(root, { id, params, isCurrent, onCleanup }) { return id ? workspace(root, id, params, isCurrent, onCleanup) : listView(root, params); },
  };
})();
