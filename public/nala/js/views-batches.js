/* Carga masiva y lotes. Los archivos van directo al almacenamiento privado
   con enlaces firmados; el procesamiento es un conjunto de trabajos
   persistentes en el servidor que avanzan aunque se cierre esta pantalla
   (worker programado) y que esta pestaña también impulsa mientras está abierta. */
(function () {
  const { esc, int, period, ms } = NALA;
  const ACCEPT = '.jpg,.jpeg,.png,.pdf,.zip,.rar';

  // Piso de progreso por lote: aunque el servidor ya calcula un porcentaje que
  // sólo sube para archivos sueltos, un ZIP puede revelar más archivos a mitad
  // de camino. Guardamos el máximo visto para que la barra nunca retroceda
  // mientras el lote procesa; se olvida cuando termina.
  const progressFloor = {};

  // ── Bomba de trabajos: mientras NALA esté abierto y haya trabajos ───────
  let pumping = false;
  NALA.pump = async function pump() {
    if (pumping) return; pumping = true;
    try {
      for (let i = 0; i < 200; i++) {
        const r = await NALA.api('POST', 'jobs/tick').catch(() => null);
        NALA.onTick?.(r);
        const s = await NALA.api('GET', 'stats').catch(() => null);
        if (!s || !s.stats.jobs_pending) break;
        await new Promise(res => setTimeout(res, r?.processed ? 300 : 2500));
      }
    } finally { pumping = false; NALA.onTick?.(null); }
  };

  async function sha256(file) {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function put(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Carga rechazada (${xhr.status})`)));
      xhr.onerror = () => reject(new Error('Error de red al subir el archivo'));
      xhr.send(file);
    });
  }

  // Uploads files into a batch: hash → register → signed PUT → complete.
  async function uploadFiles(batchId, files, report) {
    const prepared = [];
    for (const file of files) { report(file.name, 'Calculando huella…'); prepared.push({ file, sha256: await sha256(file) }); }
    const reg = await NALA.api('POST', `batches/${batchId}/files`, { files: prepared.map(p => ({ name: p.file.name, size: p.file.size, sha256: p.sha256 })) });
    let okCount = 0; let repeated = 0;
    for (const r of reg.files) {
      const p = prepared.find(x => x.file.name === r.name);
      if (r.error) { report(r.name, r.already_processed ? r.error : `✕ ${r.error}`, 'crit', r.already_processed?.batch_id); if (r.already_processed) repeated++; continue; }
      if (r.already && !r.upload_url) { report(r.name, 'Ya estaba en el lote (misma huella)', 'warn'); continue; }
      try {
        await put(r.upload_url, p.file, f => report(r.name, `Subiendo ${Math.round(f * 100)}%`));
        await NALA.api('POST', `batches/${batchId}/files/${r.document_id}/complete`);
        report(r.name, '✓ Recibido', 'ok'); okCount++;
      } catch (e) { report(r.name, `✕ ${e.message}`, 'crit'); }
    }
    if (repeated) NALA.toast(`${repeated} factura(s) ya habían sido cargadas antes y no se vuelven a leer.`, 'err');
    return okCount;
  }

  function uploadForm(root, { batch = null } = {}) {
    const s = NALA.state;
    const year = Number((s.period || NALA.prevMonth()).slice(0, 4)); const month = (s.period || NALA.prevMonth()).slice(4);
    root.innerHTML = `<div class="card stack" style="max-width:900px"><h2>${batch ? `Agregar archivos a "${esc(batch.name)}"` : 'Nuevo lote'}</h2>
      ${batch ? '' : `<div class="row">
        <label class="f" style="flex:2;min-width:240px"><span>Empresa</span><select id="b-client">${NALA.clientOptions(s.client, { includeAll: !s.client, allLabel: '— Elegir empresa —' })}</select></label>
        <label class="f"><span>Mes</span><select id="b-month">${Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map(m => `<option ${m === month ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label class="f"><span>Año</span><input id="b-year" type="number" min="2018" max="2099" value="${year}" style="width:90px"></label>
        <label class="f"><span>Formato</span><select id="b-format"><option value="606" ${s.format !== '607' ? 'selected' : ''}>606 · Compras</option><option value="607" ${s.format === '607' ? 'selected' : ''}>607 · Ventas</option></select></label>
        <label class="f" style="flex:2;min-width:200px"><span>Nombre del lote</span><input id="b-name" maxlength="120" placeholder="Ej. Compras agosto — caja chica"></label></div>`}
      <div class="drop" id="drop" tabindex="0">📎 Arrastre aquí facturas <b>JPG, PNG, PDF o ZIP</b>, o haga clic para elegirlas.<br><small>PDF de varias páginas y varias facturas por página se separan automáticamente. RAR no es compatible: use ZIP.</small></div>
      <input type="file" id="files" multiple accept="${ACCEPT}" hidden>
      <div id="flist"></div>
      <div class="row"><button class="btn primary" id="go" disabled>${batch ? 'Subir y procesar' : 'Crear lote, subir y procesar'}</button><button class="btn" id="cancel">Cancelar</button></div></div>`;
    let selected = [];
    const idem = crypto.randomUUID();
    const listEl = root.querySelector('#flist');
    const status = {};
    const draw = () => {
      listEl.innerHTML = selected.length ? `<div class="table-wrap"><table><tr><th>Archivo</th><th class="num">Tamaño</th><th>Estado</th></tr>${selected.map(f => `<tr><td>${esc(f.name)}</td><td class="num">${(f.size / 1024).toFixed(0)} KB</td><td>${status[f.name] ? (status[f.name][0].length > 40 ? `<div class="issue ${status[f.name][1] === 'crit' ? 'critical' : 'warning'}"><span class="ico">✕</span><span>${esc(status[f.name][0])}${status[f.name][2] ? ` <a class="btn sm" href="#/lotes/${encodeURIComponent(status[f.name][2])}">Abrir lote →</a>` : ''}</span></div>` : `<span class="badge ${status[f.name][1] || ''}">${esc(status[f.name][0])}</span>`) : ''}</td></tr>`).join('')}</table></div>` : '';
      root.querySelector('#go').disabled = !selected.length;
    };
    const add = list => {
      for (const f of list) if (!selected.some(x => x.name === f.name && x.size === f.size)) selected.push(f);
      for (const f of selected) if (/\.rar$/i.test(f.name)) status[f.name] = ['RAR no es compatible: comprima en ZIP', 'crit'];
      draw();
    };
    const drop = root.querySelector('#drop'); const input = root.querySelector('#files');
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); add(e.dataTransfer.files); });
    input.addEventListener('change', () => add(input.files));
    root.querySelector('#cancel').addEventListener('click', () => NALA.go(batch ? `#/lotes/${batch.id}` : '#/lotes'));
    // Se conserva el lote creado entre reintentos (no se crea uno nuevo cada vez).
    let currentBatch = batch;
    const RECEIVED = '✓ Recibido';
    root.querySelector('#go').addEventListener('click', async () => {
      const btn = root.querySelector('#go'); btn.disabled = true;
      try {
        if (!currentBatch) {
          const clientId = root.querySelector('#b-client').value;
          if (!clientId) throw new Error('Elija la empresa del lote.');
          const p = `${root.querySelector('#b-year').value}${root.querySelector('#b-month').value}`;
          const name = root.querySelector('#b-name').value.trim() || `${root.querySelector('#b-format').value} ${period(p)}`;
          currentBatch = (await NALA.api('POST', 'batches', { client_id: clientId, period: p, format: root.querySelector('#b-format').value, name, idempotency_key: idem })).batch;
        }
        const target = currentBatch;
        const files = selected.filter(f => !/\.rar$/i.test(f.name));
        // Reintenta solo los que aún no se recibieron; los ya subidos se saltan.
        const pending = files.filter(f => (status[f.name] || [])[0] !== RECEIVED);
        await uploadFiles(target.id, pending, (name, msg, cls, batchId) => { status[name] = [msg, cls, batchId]; draw(); });
        const anyFailed = files.some(f => (status[f.name] || [])[1] === 'crit');
        if (anyFailed) {
          btn.disabled = false;
          btn.textContent = 'Reintentar subida';
          NALA.toast('Algún archivo no subió. Pulsa «Reintentar subida» para intentarlo de nuevo sin volver a elegirlo.', 'err');
          return;
        }
        const totalOk = files.filter(f => (status[f.name] || [])[0] === RECEIVED).length;
        if (!totalOk) { btn.disabled = false; return; }
        await NALA.api('POST', `batches/${target.id}/start`);
        NALA.toast(`${totalOk} archivo(s) recibidos; procesamiento en segundo plano.`, 'ok');
        NALA.pump();
        setTimeout(() => NALA.go(`#/lotes/${target.id}`), 600);
      } catch (e) { NALA.fail(e); btn.disabled = false; }
    });
  }

  async function listView(root, params, onCleanup) {
    const s = NALA.state;
    if (params.nuevo) {
      if (!s.client) { NALA.toast('Elija primero la empresa activa (arriba) para crear un lote.', 'err'); return NALA.go('#/lotes'); }
      return uploadForm(root);
    }
    const qs = new URLSearchParams(Object.entries({ client_id: s.client, period: params.all ? '' : s.period, format: s.format }).filter(([, v]) => v));
    const { batches } = await NALA.api('GET', `batches?${qs}`);
    root.innerHTML = `<div class="stack"><div class="row">${NALA.can('upload') ? '<button class="btn primary" id="new">+ Nuevo lote</button>' : ''}
      <button class="btn" id="all">${params.all ? `Sólo ${period(s.period)}` : 'Todos los períodos'}</button><span class="muted" id="pumpinfo"></span></div>
      ${NALA.can('upload') && !s.client ? '<div class="issue warning"><span class="ico">ℹ️</span><span><b>Vista consolidada (todas las empresas).</b> Para subir facturas, elija una <b>empresa activa</b> en el selector de arriba.</span></div>' : ''}
      ${batches.length ? `<div class="table-wrap"><table><tr><th>Lote</th><th>Empresa</th><th>Período</th><th>Formato</th><th>Estado</th><th class="num">Docs</th><th class="num">Comprob.</th><th class="num">Pend.</th><th class="num">Errores</th><th class="num">Aprob.</th><th>Creado</th>${(NALA.can('reprocess') || NALA.can('upload')) ? '<th></th>' : ''}</tr>
        ${batches.map(b => `<tr class="clickable" data-id="${b.id}"><td><b>${esc(b.name)}</b></td><td>${esc(NALA.clientName(b.client_id))}</td><td>${period(b.period)}</td><td>${b.format}</td><td>${NALA.badge(b.status)}${b.summary?.jobs_pending ? ` <span class="muted">${int(b.summary.jobs_pending)} trabajos</span>` : ''}</td>
          <td class="num">${int(b.summary?.documents)}</td><td class="num">${int(b.summary?.invoices)}</td><td class="num">${int(b.summary?.pending)}</td><td class="num">${b.summary?.with_errors ? `<span class="badge crit">${int(b.summary.with_errors)}</span>` : '0'}</td><td class="num">${int(b.summary?.approved)}</td><td>${NALA.dateTime(b.created_at)}</td>${(NALA.can('reprocess') || NALA.can('upload')) ? `<td class="chk">${NALA.can('upload') ? `<button class="btn sm" data-edit="${b.id}" data-name="${esc(b.name)}" title="Editar nombre">✏️</button> ` : ''}${NALA.can('reprocess') ? `<button class="btn sm danger" data-del="${b.id}" data-name="${esc(b.name)}" title="Eliminar lote">🗑</button>` : ''}</td>` : ''}</tr>`).join('')}</table></div>`
        : '<div class="card empty">No hay lotes con estos filtros.</div>'}</div>`;
    root.querySelector('#new')?.addEventListener('click', () => {
      if (!s.client) { NALA.toast('Elija primero la empresa activa (arriba) para crear un lote.', 'err'); document.getElementById('scope-client')?.focus(); return; }
      NALA.go('#/lotes?nuevo=1');
    });
    root.querySelector('#all').addEventListener('click', () => NALA.go(params.all ? '#/lotes' : '#/lotes?all=1'));
    root.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', e => { if (e.target.closest('[data-del]') || e.target.closest('[data-edit]')) return; NALA.go(`#/lotes/${tr.dataset.id}`); }));
    root.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', async e => {
      e.stopPropagation();
      const name = await NALA.modal({ title: 'Editar nombre del lote', okText: 'Guardar',
        body: `<label class="f"><span>Nombre del lote</span><input id="b-rename" maxlength="120" value="${esc(btn.dataset.name)}"></label>`,
        onOk: m => { const v = m.querySelector('#b-rename').value.trim(); if (!v) throw new Error('Escriba un nombre.'); return v; } });
      if (!name) return;
      try { await NALA.api('PATCH', `batches/${btn.dataset.edit}`, { name }); NALA.toast('Nombre actualizado', 'ok'); NALA.route(); } catch (err) { NALA.fail(err); }
    }));
    root.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async e => {
      e.stopPropagation();
      const ok = await NALA.modal({ title: 'Eliminar lote', okText: 'Eliminar definitivamente', okClass: 'danger',
        body: `<p>Se eliminará el lote <b>${esc(btn.dataset.name)}</b> con sus comprobantes, documentos y archivos originales. Esta acción no se puede deshacer.</p>
          <p class="muted" style="margin-top:6px">Si algún comprobante ya está en una exportación generada, primero debe anularla.</p>
          <label style="display:flex;align-items:center;gap:6px;margin-top:8px"><input type="checkbox" id="confirm-del"> Entiendo que se borra todo el lote</label>`,
        onOk: m => { if (!m.querySelector('#confirm-del').checked) throw new Error('Marque la casilla para confirmar.'); return true; } });
      if (!ok) return;
      try { await NALA.api('DELETE', `batches/${btn.dataset.del}`); NALA.toast('Lote eliminado', 'ok'); NALA.route(); } catch (err) { NALA.fail(err); }
    }));
    if (batches.some(b => ['queued', 'processing'].includes(b.status))) {
      NALA.onTick = () => {}; NALA.pump();
      const timer = setInterval(() => NALA.route(), 5000);
      onCleanup(() => { clearInterval(timer); NALA.onTick = null; });
    }
  }

  async function detailView(root, id, params, isCurrent, onCleanup) {
    if (params.agregar) {
      const { batch } = await NALA.api('GET', `batches/${id}`);
      return uploadForm(root, { batch });
    }
    const d = await NALA.api('GET', `batches/${id}`);
    if (!isCurrent()) return;
    const b = d.batch; const st = d.stats; const p = d.progress;
    const active = ['queued', 'processing'].includes(b.status);
    // La barra nunca retrocede mientras procesa (ver progressFloor arriba).
    const pct = active ? Math.max(p.percent, progressFloor[b.id] || 0) : p.percent;
    if (active) progressFloor[b.id] = pct; else delete progressFloor[b.id];
    const top = d.documents.filter(x => !x.parent_id);
    const children = parent => d.documents.filter(x => x.parent_id === parent);
    const jobsFor = docId => d.jobs.filter(j => j.document_id === docId);
    const docRow = (doc, nested = false) => {
      const jobs = jobsFor(doc.id);
      const attempts = jobs.length ? Math.max(...jobs.map(j => j.attempts)) : 0;
      const dur = jobs.filter(j => j.duration_ms).reduce((s2, j) => s2 + j.duration_ms, 0);
      return `<tr><td>${nested ? '<span class="muted">↳</span> ' : ''}${esc(doc.original_name)}<div class="muted mono" title="SHA-256">${doc.sha256 ? doc.sha256.slice(0, 16) + '…' : ''}</div></td>
        <td>${doc.kind.toUpperCase()}</td><td class="num">${doc.page_count ?? '—'}</td><td>${NALA.badge(doc.status)}${doc.error ? `<div class="muted" style="max-width:360px">${esc(doc.error)}</div>` : ''}</td>
        <td class="num">${jobs.length ? `${jobs.filter(j => j.status === 'succeeded').length}/${jobs.length}` : '—'}${attempts > 1 ? ` <span class="badge warn" title="Intentos">${attempts} int.</span>` : ''}</td><td class="num">${dur ? ms(dur) : '—'}</td>
        <td>${doc.status === 'pending_upload'
            ? (NALA.can('upload') ? `<button class="btn sm" data-href="#/lotes/${b.id}?agregar=1">Reintentar subida</button>` : '<span class="muted">Sin subir</span>')
            : (doc.kind !== 'zip' && !['unsupported', 'purged'].includes(doc.status) ? `<button class="btn sm" data-doc="${doc.id}">Ver original</button>` : '')}</td></tr>`;
    };
    root.innerHTML = `<div class="stack">
      <div class="card"><h2>${esc(b.name)} ${NALA.badge(b.status)}<span class="spacer"></span>
        <button class="btn primary" data-href="#/auditoria?batch=${b.id}">🧾 Auditar lote</button>
        <button class="btn sm" id="refresh" title="Actualizar">↻ Actualizar</button>
        ${NALA.can('upload') ? `<button class="btn sm" data-href="#/lotes/${b.id}?agregar=1">+ Archivos</button>` : ''}
        ${NALA.can('reprocess') && (st.documents_failed || st.jobs_failed) ? '<button class="btn sm" id="reproc">Reprocesar fallidos</button>' : ''}
        ${NALA.can('reprocess') ? '<button class="btn sm" id="reproc-all" title="Vuelve a LEER todas las facturas con la IA. Conserva las correcciones hechas a mano y no toca las aprobadas ni las excluidas.">Reprocesar</button>' : ''}
        ${NALA.can('reprocess') ? '<button class="btn sm" id="reval" title="Vuelve a validar los comprobantes con las reglas y la configuración actuales (sin re-escanear)">Revalidar</button>' : ''}
        ${NALA.can('reprocess') ? '<button class="btn sm danger" id="del-batch">Eliminar</button>' : ''}</h2>
        <div class="muted">${esc(b.client_name)} · ${b.format} · ${period(b.period)} · creado ${NALA.dateTime(b.created_at)}</div>
        <div style="margin-top:10px" class="progress"><div style="width:${pct}%"></div></div>
        <div class="row muted" style="margin-top:6px;gap:16px"><span>${pct}%${p.docs_total ? ` · ${p.docs_done}/${p.docs_total} archivos leídos` : ''}</span><span>${p.jobs_done}/${p.jobs_total} trabajos · ${p.jobs_running} en ejecución · ${p.jobs_queued} en cola · ${p.jobs_failed} fallidos</span>
          <span>Duración ${ms(p.elapsed_ms)}${p.avg_job_ms ? ` · promedio ${ms(p.avg_job_ms)}/trabajo` : ''}</span>${active ? '<span>⏳ procesando en segundo plano…</span>' : ''}</div></div>
      <div class="grid kpis">
        <div class="card kpi"><div class="label">Comprobantes</div><div class="value">${int(st.invoices)}</div></div>
        <div class="card kpi clickable" data-href="#/auditoria?batch=${b.id}&status=pending_review,reviewed"><div class="label">Pendientes</div><div class="value">${int(st.pending)}</div></div>
        <div class="card kpi clickable" data-href="#/auditoria?batch=${b.id}&has=errors"><div class="label">Con errores</div><div class="value" style="color:var(--crit)">${int(st.with_errors)}</div></div>
        <div class="card kpi clickable" data-href="#/auditoria?batch=${b.id}&has=duplicates"><div class="label">Duplicados</div><div class="value">${int(st.duplicates)}</div></div>
        <div class="card kpi clickable" data-href="#/auditoria?batch=${b.id}&status=approved"><div class="label">Aprobados</div><div class="value" style="color:var(--ok)">${int(st.approved)}</div></div>
      </div>
      <div id="dups"></div>
      <div class="card"><h2>Documentos y trabajos</h2><div class="table-wrap"><table><tr><th>Archivo</th><th>Tipo</th><th class="num">Págs.</th><th>Estado</th><th class="num">Trabajos</th><th class="num">Duración</th><th></th></tr>
        ${top.map(doc => docRow(doc) + children(doc.id).map(ch => docRow(ch, true)).join('')).join('') || '<tr><td colspan="7" class="empty">Sin documentos.</td></tr>'}</table></div>
        ${d.jobs.some(j => j.status === 'failed') ? `<div class="stack" style="margin-top:10px">${d.jobs.filter(j => j.status === 'failed').map(j => `<div class="issue critical"><span class="ico">✕</span>${esc(j.kind === 'prepare' ? 'Preparación' : `Extracción págs. ${j.payload.page_from}-${j.payload.page_to}`)} falló tras ${j.attempts} intento(s): ${esc(j.last_error || '')}</div>`).join('')}</div>` : ''}</div>
      <div class="card"><h2>Historial del lote</h2><div class="timeline" id="tl">Cargando…</div></div></div>`;
    root.querySelectorAll('[data-href]').forEach(el => el.addEventListener('click', () => NALA.go(el.dataset.href)));
    root.querySelectorAll('[data-doc]').forEach(btn => btn.addEventListener('click', async () => {
      try { const r = await NALA.api('GET', `documents/${btn.dataset.doc}/url`); window.open(r.url, '_blank', 'noopener'); } catch (e) { NALA.fail(e); }
    }));
    root.querySelector('#refresh')?.addEventListener('click', () => NALA.route());
    root.querySelector('#reproc')?.addEventListener('click', async () => {
      try { const r = await NALA.api('POST', `batches/${b.id}/reprocess`, { failed_only: true }); NALA.toast(`${r.requeued} documento(s) en cola de nuevo`, 'ok'); NALA.pump(); NALA.route(); } catch (e) { NALA.fail(e); }
    });
    root.querySelector('#reproc-all')?.addEventListener('click', async () => {
      const ok = await NALA.modal({ title: 'Reprocesar (re-leer con IA)', okText: 'Reprocesar', okClass: 'primary',
        body: `<p>Se <b>vuelven a leer</b> todas las facturas del lote con la IA (y el OCR si está activo).</p>
          <ul style="margin:6px 0 0 16px"><li>Conserva las <b>correcciones hechas a mano</b>.</li><li><b>No toca</b> las aprobadas ni las excluidas.</li><li>Tiene costo de IA y puede tardar.</li></ul>` });
      if (!ok) return;
      try { const r = await NALA.api('POST', `batches/${b.id}/reprocess`, { failed_only: false }); NALA.toast(`Re-leyendo ${r.requeued} documento(s)…`, 'ok'); NALA.pump(); NALA.route(); } catch (e) { NALA.fail(e); }
    });
    root.querySelector('#reval')?.addEventListener('click', async () => {
      try { await NALA.api('POST', `batches/${b.id}/revalidate`); NALA.toast('Revalidando el lote…', 'ok'); NALA.pump(); NALA.route(); } catch (e) { NALA.fail(e); }
    });
    root.querySelector('#del-batch')?.addEventListener('click', async () => {
      const ok = await NALA.modal({ title: 'Eliminar lote', okText: 'Eliminar definitivamente', okClass: 'danger',
        body: `<p>Se eliminará el lote <b>${esc(b.name)}</b> con sus <b>${int(st.invoices)}</b> comprobante(s), sus documentos y los archivos originales. Esta acción no se puede deshacer.</p>
          <p class="muted" style="margin-top:6px">Si algún comprobante ya está en una exportación generada, primero debe anularla.</p>
          <label style="display:flex;align-items:center;gap:6px;margin-top:8px"><input type="checkbox" id="confirm-del"> Entiendo que se borra todo el lote</label>`,
        onOk: m => { if (!m.querySelector('#confirm-del').checked) throw new Error('Marque la casilla para confirmar.'); return true; } });
      if (!ok) return;
      try { await NALA.api('DELETE', `batches/${b.id}`); NALA.toast('Lote eliminado', 'ok'); NALA.go('#/lotes'); } catch (e) { NALA.fail(e); }
    });
    if (st.duplicates) NALA.api('GET', `invoices?batch_id=${b.id}&has=duplicates`).then(r => {
      const el = root.querySelector('#dups'); if (!el) return;
      const repeated = r.invoices.filter(i => i.issues.some(x => x.code === 'DUPLICADO'));
      if (!repeated.length) return;
      el.innerHTML = `<div class="card" style="border-color:var(--crit)"><h2 style="color:var(--crit)">⛔ ${repeated.length} factura(s) de este lote ya habían sido procesadas<span class="spacer"></span>
        ${NALA.can('exclude') ? '<button class="btn danger" id="discard">Descartar repetidas</button>' : ''}</h2>
        <div class="stack" style="gap:6px">${repeated.map(i => `<div class="issue critical"><span class="ico">✕</span><span><b class="mono">${esc(i.ncf)}</b> — ${esc(i.issues.find(x => x.code === 'DUPLICADO').message)}</span><a class="btn sm" href="#/auditoria/${i.id}?batch=${b.id}">Ver</a></div>`).join('')}</div></div>`;
      el.querySelector('#discard')?.addEventListener('click', async () => {
        if (!(await NALA.modal({ title: 'Descartar facturas repetidas', body: `<p>Se excluirán ${repeated.length} copia(s) que repiten facturas ya procesadas. Las originales no cambian y queda registrado en el historial.</p>`, okText: 'Descartar', okClass: 'danger' }))) return;
        try { const res = await NALA.api('POST', `batches/${b.id}/discard-duplicates`); NALA.toast(`${res.discarded} copia(s) descartadas`, 'ok'); NALA.route(); } catch (e) { NALA.fail(e); }
      });
    }).catch(() => {});
    NALA.api('GET', `events?batch_id=${b.id}&limit=200`).then(r => {
      const el = root.querySelector('#tl'); if (!el) return;
      // Agrupa tandas consecutivas de la misma acción en una sola línea con su
      // conteo y el rango de hora, para que el historial no repita la misma
      // acción decenas de veces (p. ej. "Aprobado · 82" en vez de 82 líneas).
      // Los eventos vienen del más nuevo al más viejo.
      const groups = [];
      for (const e of r.events) {
        const last = groups[groups.length - 1];
        if (last && last.action === e.action) { last.count++; last.from = e.created_at; if (e.reason) last.reasons.push(e.reason); }
        else groups.push({ action: e.action, count: 1, to: e.created_at, from: e.created_at, reasons: e.reason ? [e.reason] : [] });
      }
      const noteOf = reasons => {
        if (!reasons.length) return '';
        const head = reasons[0].length > 70 ? `${reasons[0].slice(0, 70)}…` : reasons[0];
        return ` · ${esc(head)}${reasons.length > 1 ? ` (y ${reasons.length - 1} más)` : ''}`;
      };
      el.innerHTML = groups.map(g => {
        const label = esc(NALA.actionLabel(g.action));
        if (g.count === 1) return `<div><b>${label}</b> · ${NALA.dateTime(g.to)}${g.reasons[0] ? ` · ${esc(g.reasons[0])}` : ''}</div>`;
        const when = g.from === g.to ? NALA.dateTime(g.to) : `${NALA.dateTime(g.from)} – ${NALA.dateTime(g.to)}`;
        return `<div title="${g.count} eventos agrupados"><b>${label}</b> <span class="badge">${g.count}</span> · ${when}${noteOf(g.reasons)}</div>`;
      }).join('') || '<span class="muted">Sin eventos.</span>';
    }).catch(() => {});
    if (active) {
      NALA.pump();
      const timer = setInterval(() => { if (isCurrent()) NALA.route(); }, 3000);
      onCleanup(() => clearInterval(timer));
    }
  }

  NALA.views.lotes = {
    title: 'Carga masiva y lotes',
    render(root, { id, params, isCurrent, onCleanup }) { return id ? detailView(root, id, params, isCurrent, onCleanup) : listView(root, params, onCleanup); },
  };
})();
