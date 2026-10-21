/* Exportar DGII 606/607: vista previa → aceptar advertencias → generar
   (instantánea única para pantalla, TXT y Excel) → descargar → registrar
   envío y resultado de la DGII. Generado, enviado y aceptado son estados
   distintos: NALA nunca marca una exportación como aceptada por sí sola. */
(function () {
  const { esc, money, int, period } = NALA;

  // Respuesta del shell de Direct al intentar abrir la OFV para enviar el 606/607.
  // Si falló (no hay acceso DGII con ese RNC o la bóveda está cerrada), lo avisamos
  // y marcamos la guía en rojo. Se registra una sola vez por carga del módulo.
  if (!window.__nalaEnvioListener) {
    window.__nalaEnvioListener = true;
    window.addEventListener('message', e => {
      if (!e.data || e.data.action !== 'nala-dgii-envio-result' || e.data.ok) return;
      NALA.toast('No pude abrir la DGII de esa empresa. Verifica su acceso DGII (RNC y tarjeta) en Accesos y que la bóveda esté abierta.', 'err');
      const hint = document.getElementById('dgii-envio-hint');
      if (hint) hint.innerHTML = '<div class="issue critical"><span class="ico">✕</span>No se pudo abrir la Oficina Virtual de la empresa. Revisa que exista su <b>acceso DGII</b> (con RNC y tarjeta de códigos) en Accesos y que la <b>bóveda esté abierta</b>. El TXT ya se descargó: también puedes subirlo manualmente en la OFV.</div>';
    });
  }

  const EXTRA_COLUMNS =[['x_line', 'Línea'], ['x_counterpart', 'Proveedor / Cliente'], ['x_currency', 'Moneda original'], ['x_invoice', 'ID factura NALA'], ['x_batch', 'Lote'], ['x_warnings', 'Advertencias aceptadas']];

  function linesTable(snapshot, { limit = 1000 } = {}) {
    const cols = snapshot.columns;
    const amountIdx = cols.map((c, i) => (c.type === 'amount' ? i : -1)).filter(i => i >= 0);
    return `<div class="table-wrap" style="max-height:60vh"><table><tr><th>#</th>${cols.map(c => `<th class="${c.type === 'amount' ? 'num' : ''}">${esc(c.label)}</th>`).join('')}<th></th></tr>
      ${snapshot.lines.slice(0, limit).map(l => `<tr><td class="muted">${l.line_no}</td>${l.values.map((v, i) => `<td class="${cols[i].type === 'amount' ? 'num' : 'mono'}">${cols[i].type === 'amount' && v ? money(v) : esc(v)}</td>`).join('')}
        <td><a class="btn sm" href="#/auditoria/${l.invoice_id}">Abrir</a></td></tr>`).join('')}
      <tr><th>Total</th>${cols.map((c, i) => `<th class="num">${amountIdx.includes(i) ? money(snapshot.totals[c.key]) : ''}</th>`).join('')}<th></th></tr></table></div>
      ${snapshot.lines.length > limit ? `<p class="muted">Mostrando ${limit} de ${snapshot.lines.length} líneas; el TXT y el Excel incluyen todas.</p>` : ''}`;
  }

  // Rows in the exact layout of the DGII "Herramienta de Envío Formato 606":
  // fill its header, press "Inicio", click B12 and paste.
  function toolCard(tool) {
    if (!tool || !tool.rows.length) return '';
    const fmt = tool.format || '606';
    const lastCol = String.fromCharCode('B'.charCodeAt(0) + tool.columns.length - 1); // 606 → Z, 607 → X
    const copyBtn = (id, label) => `<button class="btn sm" data-copy="${id}">${label}</button>`;
    return `<div class="card" data-tool><h2>Copiar y pegar en la Herramienta DGII ${fmt}<span class="spacer"></span><button class="btn primary" data-copy="rows">Copiar ${tool.rows.length} fila(s)</button></h2>
      <ol style="margin:0 0 10px 18px;line-height:1.7">
        <li>Abra la herramienta oficial de la DGII (Formato de Envío ${fmt}) y habilite los macros.</li>
        <li>En el encabezado escriba: RNC o Cédula <b class="mono">${esc(tool.header.rnc)}</b> ${copyBtn('rnc', 'Copiar')} · Período <b class="mono">${esc(tool.header.period)}</b> ${copyBtn('period', 'Copiar')} · Cantidad Registros <b class="mono">${tool.header.count}</b> ${copyBtn('count', 'Copiar')}</li>
        <li>Pulse <b>Inicio</b> para que habilite las ${tool.header.count} filas.</li>
        <li>Pulse <b>Copiar ${tool.rows.length} fila(s)</b>, haga clic en la celda <b>${esc(tool.start_cell)}</b> y pegue (Ctrl+V o Cmd+V).</li>
        <li>Pulse <b>Validar</b> y luego <b>Generar Archivo</b> para obtener el TXT que se sube a la Oficina Virtual.</li></ol>
      <details><summary class="muted">Ver las filas tal como se pegan (columnas B a ${lastCol})</summary><div class="table-wrap" style="max-height:40vh;margin-top:8px"><table>
        <tr>${tool.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr>${tool.rows.slice(0, 300).map(r => `<tr>${r.map(v => `<td class="mono">${esc(v)}</td>`).join('')}</tr>`).join('')}</table></div></details></div>`;
  }
  function bindToolCard(scope, tool) {
    if (!tool) return;
    const values = { rows: tool.tsv, rnc: tool.header.rnc, period: tool.header.period, count: String(tool.header.count) };
    scope.querySelectorAll('[data-tool] [data-copy]').forEach(btn => btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(values[btn.dataset.copy]); NALA.toast(btn.dataset.copy === 'rows' ? 'Filas copiadas: haga clic en B12 de la herramienta y pegue.' : 'Copiado', 'ok'); }
      catch { NALA.toast('No se pudo copiar. Permita el acceso al portapapeles.', 'err'); }
    }));
  }



  async function download(exp, type, columns) {
    const qs = new URLSearchParams({ type, ...(columns ? { columns: columns.join(',') } : {}) });
    const r = await NALA.api('GET', `exports/${exp.id}/download?${qs}`);
    if (r.base64) {
      const bin = Uint8Array.from(atob(r.base64), c => c.charCodeAt(0));
      NALA.downloadBlob(new Blob([bin], { type: r.mime || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), r.file_name);
    } else {
      const blob = await (await fetch(r.url)).blob();
      NALA.downloadBlob(blob, r.file_name);
    }
  }

  async function customExcel(exp) {
    const settings = (await NALA.api('GET', 'settings')).settings;
    const templates = (settings.excel_templates || []).filter(t => t.format === exp.format);
    const all = [...EXTRA_COLUMNS, ...exp.snapshot.columns.map(c => [c.key, c.label])];
    const cols = await NALA.modal({ title: 'Excel personalizado', okText: 'Descargar', wide: true,
      body: `${templates.length ? `<label class="f" style="margin-bottom:8px"><span>Plantilla guardada</span><select id="tpl"><option value="">—</option>${templates.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('')}</select></label>` : ''}
        <p class="muted" style="margin-bottom:8px">La plantilla oficial queda protegida; aquí elige columnas para su propio análisis. Los datos provienen de la misma instantánea.</p>
        <div class="grid cols-2">${all.map(([k, l]) => `<label><input type="checkbox" class="col" value="${k}" checked> ${esc(l)}</label>`).join('')}</div>`,
      onOk: m => { const v = [...m.querySelectorAll('.col:checked')].map(x => x.value); if (!v.length) throw new Error('Elija al menos una columna.'); return v; } });
    if (cols) await download(exp, 'custom', cols);
  }
  document.addEventListener('change', e => {
    if (e.target.id !== 'tpl') return;
    const i = e.target.value; if (i === '') return;
    NALA.api('GET', 'settings').then(({ settings }) => {
      const fmtTemplates = (settings.excel_templates || []).filter(t => t.format === document.querySelector('[data-export-format]')?.dataset.exportFormat);
      const t = fmtTemplates[Number(i)]; if (!t) return;
      document.querySelectorAll('.modal .col').forEach(c => { c.checked = t.columns.includes(c.value); });
    });
  });

  // Alertas del «Detalle Validación» de la DGII y la acción a tomar
  // (Instructivo «Llenado y Remisión del Formato de Envío 606», Impuestos Internos, feb. 2026).
  const DGII_ALERTS = [
    ['RNC/Cédula inactivo', 'Excluye ese NCF del formato: el RNC del suplidor no es válido (inactivo o fallecido).'],
    ['NCF no habilitado', 'Contacta al suplidor: su RNC está en estatus «Bloqueo» y debe regularizar su situación.'],
    ['NCF no existe o fue eliminado', 'El NCF fue anulado: pide al suplidor que lo sustituya.'],
    ['NCF no autorizado por la DGII', 'La secuencia no fue solicitada: el suplidor debe sustituir el NCF por otra secuencia o solicitarla.'],
    ['NCF ya se encuentra reportado', 'Revisa que no hayas digitado el mismo NCF dos veces (elimina el duplicado). Si es error del emisor, exclúyelo y pide otra numeración.'],
    ['NCF afectado por la Nota de Crédito no ha sido remitido', 'Incluye (en el mismo mes o en el período que corresponda) el NCF que afecta la nota de crédito.'],
    ['Cédula registrada como contribuyente', 'El proveedor debe emitir un NCF válido para crédito fiscal.'],
    ['RNC/Cédula no registrada como contribuyente', 'El proveedor debe emitir un comprobante de compras.'],
    ['Emisor o receptor del e-CF no coinciden / no aceptado', 'Valida el RNC del emisor, el RNC del receptor y que el e-CF figure «recibido» en «Consulta de NCF / e-NCF»; luego avisa al suplidor.'],
    ['RNC/Cédula no es Facturador Electrónico', 'Pide al suplidor una factura con NCF válido.'],
    ['Emisor debe emitir una secuencia electrónica válida', 'Es un NCF tipo B de un emisor obligado a e-CF: pide que emita un comprobante electrónico (tipo E).'],
  ];
  const DGII_ALERTS_HTML = `<details style="margin-bottom:10px"><summary><b>Alertas frecuentes de la DGII y qué hacer</b></summary><ul style="margin:6px 0 0 18px;line-height:1.5">${DGII_ALERTS.map(([t, a]) => `<li><b>${esc(t)}:</b> ${esc(a)}</li>`).join('')}</ul></details>`;

  async function detail(root, id) {
    const { export: exp, dgii_tool: tool } = await NALA.api('GET', `exports/${id}`);
    const steps = [['generated', 'Archivo generado', exp.created_at], ['submitted', 'Enviado a la DGII (Oficina Virtual)', exp.submitted_at], [exp.status === 'rejected' ? 'rejected' : 'accepted', exp.status === 'rejected' ? 'Rechazado por la DGII' : 'Aceptado por la DGII', exp.result_at]];
    const canSubmit = NALA.can('submit');
    root.innerHTML = `<div class="stack" data-export-format="${exp.format}">
      <div class="card"><h2>${esc(exp.file_name)} ${NALA.badge(exp.status)}<span class="spacer"></span><button class="btn" data-href="#/exportar">← Exportaciones</button></h2>
        <div class="muted">${esc(NALA.clientName(exp.client_id))} · ${exp.format} · ${period(exp.period)} · ${exp.scope === 'period' ? 'consolidado del mes' : `${exp.batch_ids.length} lote(s)`} · ${int(exp.line_count)} líneas · SHA-256 TXT <span class="mono">${esc(exp.txt_sha256.slice(0, 16))}…</span></div>
        <div class="row" style="margin-top:12px;gap:18px">${steps.map(([k, label, at]) => `<div><span class="badge ${at ? (k === 'rejected' ? 'crit' : 'ok') : ''}">${at ? '✓' : '○'} ${esc(label)}</span><div class="muted">${at ? NALA.dateTime(at) : 'pendiente'}</div></div>`).join('<span class="muted">→</span>')}</div>
        ${exp.status === 'submitted' && exp.format === '606' ? `<div class="card" style="margin-top:10px"><b>Cuadre con «Ver Resumen» de la DGII</b>
          <div class="muted">Cuando la validación diga <i>Completado</i>, compara estos totales de NALA con el «Resumen del Envío» de la OFV:</div>
          <div class="table-wrap"><table><tr><th>Concepto</th><th class="num">NALA</th></tr>${[['Total Monto Facturado', 'total_monto_facturado'], ['ITBIS Facturado', 'itbis'], ['ITBIS Retenido', 'itbis_retenido'], ['ITBIS por Adelantar', 'itbis_adelantar']].map(([l, k]) => `<tr><td>${l}</td><td class="num">${(exp.totals || {})[k] != null ? money((exp.totals || {})[k]) : '—'}</td></tr>`).join('')}</table></div></div>` : ''}
        ${exp.submission_reference ? `<p style="margin-top:8px">Referencia OFV: <b class="mono">${esc(exp.submission_reference)}</b></p>` : ''}${exp.result_notes ? `<p>Resultado: ${esc(exp.result_notes)}</p>` : ''}
        ${exp.status === 'superseded' ? `<div class="issue warning" style="margin-top:8px"><span class="ico">!</span>Reemplazada: ${esc(exp.superseded_reason || '')}</div>` : ''}
        ${exp.accepted_warnings?.length ? `<p class="muted" style="margin-top:8px">Advertencias aceptadas: ${exp.accepted_warnings.map(esc).join(', ')} · motivo: ${esc(exp.acceptance_reason || '')}</p>` : ''}
        <div class="row" style="margin-top:12px"><button class="btn primary" id="d-txt">Descargar TXT</button><button class="btn" id="d-xlsx">Excel (plantilla oficial)</button><button class="btn" id="d-custom">Excel personalizado</button><button class="btn" id="d-tool">Mi herramienta DGII (con macro)</button>
          ${canSubmit && ['generated', 'rejected'].includes(exp.status) ? '<button class="btn ok" id="s-dgii">⬆ Enviar a la DGII de la empresa</button>' : ''}
          ${canSubmit && exp.status === 'generated' ? '<button class="btn" id="s-sub">Registrar envío a DGII</button>' : ''}
          ${canSubmit && exp.status === 'submitted' ? '<button class="btn ok" id="s-acc">Registrar aceptación</button><button class="btn danger" id="s-rej">Registrar rechazo</button>' : ''}
          ${canSubmit && ['generated', 'rejected'].includes(exp.status) ? '<button class="btn" id="s-sup">Marcar como reemplazada</button>' : ''}</div>
        <p class="muted" style="margin-top:8px">NALA genera el archivo; el envío se hace en la Oficina Virtual de la DGII y su resultado se consulta en "Consulta Envíos". Registre aquí cada paso.</p></div>
      ${exp.snapshot.consumer_summary ? `<div class="card"><h2>Resumen de Facturas de Consumo</h2>${int(exp.snapshot.consumer_summary.count)} NCF · RD$ ${money(exp.snapshot.consumer_summary.monto_facturado)} · ITBIS RD$ ${money(exp.snapshot.consumer_summary.itbis)}</div>` : ''}
      ${toolCard(tool)}
      <div class="card"><h2>Líneas exportadas</h2>${linesTable(exp.snapshot)}</div></div>`;
    bindToolCard(root, tool);
    root.querySelectorAll('[data-href]').forEach(el => el.addEventListener('click', () => NALA.go(el.dataset.href)));
    const guard = fn => async () => { try { await fn(); } catch (e) { NALA.fail(e); } };
    root.querySelector('#d-txt').addEventListener('click', guard(() => download(exp, 'txt')));
    root.querySelector('#d-xlsx').addEventListener('click', guard(() => download(exp, 'xlsx')));
    root.querySelector('#d-custom').addEventListener('click', guard(() => customExcel(exp)));
    root.querySelector('#d-tool')?.addEventListener('click', guard(() => download(exp, 'template')));
    root.querySelector('#s-dgii')?.addEventListener('click', guard(async () => {
      const rnc = exp.snapshot?.header?.rnc || '';
      // 1) Descargar el TXT para adjuntarlo en la Oficina Virtual.
      await download(exp, 'txt');
      // 2) Pedir al shell de Direct que abra la OFV de esa empresa (auto-login
      //    con su credencial DGII cifrada). El archivo se adjunta a mano: la DGII
      //    no permite adjuntarlo por código.
      try { NALA.host().postMessage({ action: 'nala-open-dgii-envio', rnc, format: exp.format, period: exp.period, fileName: exp.file_name }, location.origin); } catch (_) { /* fuera del shell */ }
      NALA.toast('Descargué el TXT y estoy abriendo la Oficina Virtual…', 'ok');
      // 3) Guía fija (no un toast efímero) con los pasos en la OFV.
      const stack = root.querySelector('.stack');
      let hint = root.querySelector('#dgii-envio-hint');
      if (!hint && stack) { hint = document.createElement('div'); hint.id = 'dgii-envio-hint'; hint.className = 'card'; stack.insertBefore(hint, stack.children[1] || null); }
      if (hint) hint.innerHTML = `<h2>Enviar a la DGII · ${esc(NALA.clientName(exp.client_id))}</h2>
        <ol style="margin:0 0 6px 18px;line-height:1.8">
          <li>Descargué <b>${esc(exp.file_name)}</b> — búscalo en tu carpeta de descargas.</li>
          <li>Abrí la <b>Oficina Virtual</b> de la empresa en otra pestaña (ya con sesión iniciada).</li>
          <li>En el menú de la OFV pulsa <b>Enviar Archivos</b>. En <b>Tipo Información</b> elige <b>${esc(exp.format === '606' ? '606 - COMPRAS DE BIENES Y SERVICIOS' : exp.format)}</b>, escribe el <b>Período</b> <b class="mono">${esc(exp.period)}</b> (AAAAMM) y pulsa <b>Continuar</b>.</li>
          <li>Pulsa <b>Examinar…</b>, <b>adjunta el TXT</b> descargado y pulsa <b>Enviar Datos</b>.</li>
          <li>Saldrá «El archivo ha sido recibido para validación» con el <b>Número Referencia</b>: imprime o guarda ese resumen, vuelve aquí y pulsa «Registrar envío a DGII» para pegarlo.</li>
          <li>La DGII valida el archivo en unos <b>30 minutos</b>. En la OFV abre <b>Consultas → Consulta Envíos ${esc(exp.format)}</b> y mira el <b>Estatus Validación</b>: <i>Recibido</i> / <i>En proceso</i> / <i>Completado</i> (aceptado) / <i>Error</i> (pulsa «Ver Resumen» para ver las líneas).</li>
        </ol>
        <p class="muted">El archivo se adjunta manualmente por seguridad (la DGII no permite adjuntarlo por código). Si no se abrió la pestaña, revisa que la bóveda esté abierta y que exista el acceso DGII de la empresa (con RNC y tarjeta) en Accesos.</p>`;
    }));
    const setStatus = async (status, body) => { await NALA.api('POST', `exports/${exp.id}/status`, { status, ...body }); NALA.toast('Estado actualizado', 'ok'); NALA.route(); };
    root.querySelector('#s-sub')?.addEventListener('click', guard(async () => {
      const r = await NALA.modal({ title: 'Registrar envío a la DGII', okText: 'Registrar',
        body: '<div class="fields"><label class="f"><span>Fecha de envío</span><input type="date" id="sd"></label><label class="f"><span>Número Referencia (pantalla «El archivo ha sido recibido para validación»)</span><input id="sr"></label></div>',
        onOk: m => ({ submitted_at: m.querySelector('#sd').value || null, reference: m.querySelector('#sr').value }) });
      if (r) await setStatus('submitted', r);
    }));
    root.querySelector('#s-acc')?.addEventListener('click', guard(async () => { const notes = await NALA.askReason('Registrar aceptación de la DGII', { label: 'Detalle (ej. «Completado» en Consulta Envíos; Adelanto ITBIS calculado)', min: 0, okText: 'Registrar' }); if (notes !== null) await setStatus('accepted', { notes }); }));
    root.querySelector('#s-rej')?.addEventListener('click', guard(async () => { const notes = await NALA.askReason('Registrar rechazo de la DGII', { label: 'Errores informados por la DGII (línea, descripción y dato validado)', okText: 'Registrar', extra: DGII_ALERTS_HTML }); if (notes) await setStatus('rejected', { notes }); }));
    root.querySelector('#s-sup')?.addEventListener('click', guard(async () => { const notes = await NALA.askReason('Marcar como reemplazada', { okText: 'Marcar' }); if (notes) await setStatus('superseded', { notes }); }));
  }

  // Informativo en cero: la empresa no tuvo operaciones en el período, así que la
  // DGII pide remitir el 606/607/608 «de manera informativa» (OFV → Declaraciones
  // en Cero). No hay archivo; NALA guía el trámite y guarda el código de referencia.
  async function zeroFiling() {
    const s = NALA.state;
    if (!s.client) { NALA.toast('Elige una empresa arriba para declarar su informativo en cero.', 'warn'); return; }
    const client = (s.clients || []).find(c => c.id === s.client) || {};
    const rnc = client.rnc || client.cedula || '';
    const per = s.period || NALA.prevMonth();
    const names = { 606: '606 - COMPRAS DE BIENES Y SERVICIOS', 607: '607 - VENTAS DE BIENES Y SERVICIOS', 608: '608 - ANULACIONES' };
    const p = NALA.modal({ title: `Informativo en cero · ${NALA.clientName(s.client)}`, okText: 'Registrar informativo', wide: true,
      body: `<p class="muted" style="margin-bottom:8px">Úsalo cuando la empresa <b>no tuvo operaciones</b> en el período. Si tuvo compras o ventas, se envía el archivo (606/607), no esto.</p>
        <div class="fields"><label class="f"><span>Formato</span><select id="z-fmt"><option value="606">606 · Compras</option><option value="607">607 · Ventas</option><option value="608">608 · Anulaciones</option></select></label>
          <label class="f"><span>Período</span><input type="month" id="z-per" value="${per.slice(0, 4)}-${per.slice(4)}"></label></div>
        <div id="z-note" style="margin:8px 0"></div>
        <ol style="margin:0 0 8px 18px;line-height:1.7">
          <li><button type="button" class="btn sm ok" id="z-open">⬆ Abrir la Oficina Virtual de la empresa</button> (queda con sesión iniciada).</li>
          <li>En el menú pulsa <b>Declaraciones Juradas → Declaraciones en Cero</b>.</li>
          <li>En <b>Formato o Impuesto</b> elige <b id="z-name">${esc(names[606])}</b>, escribe el <b>Período</b> <b class="mono" id="z-pcode">${esc(per)}</b> (AAAAMM) y pulsa <b>Presentar Declaración y/o Formato</b>.</li>
          <li>Saldrá «El formato ha sido presentado satisfactoriamente con el código de referencia: …». Pega ese código aquí y registra.</li>
        </ol>
        <label class="f"><span>Código de referencia</span><input id="z-ref" placeholder="Ej. 60634619206" autocomplete="off"></label>`,
      onOk: async m => {
        const fmt = m.querySelector('#z-fmt').value; const per2 = m.querySelector('#z-per').value.replace('-', '');
        const reference = m.querySelector('#z-ref').value.trim();
        if (reference.length < 4) throw new Error('Pega el código de referencia que muestra la DGII.');
        await NALA.api('POST', 'zero-filings', { client_id: s.client, format: fmt, period: per2, reference });
        NALA.toast('Informativo en cero registrado ✓', 'ok');
        return true;
      } });
    const m = [...document.querySelectorAll('.modal-bg')].pop()?.querySelector('.modal'); if (!m) return p;
    const note = m.querySelector('#z-note'); const fmtEl = m.querySelector('#z-fmt'); const perEl = m.querySelector('#z-per');
    const refresh = async () => {
      const fmt = fmtEl.value; const per2 = perEl.value.replace('-', '');
      m.querySelector('#z-name').textContent = names[fmt]; m.querySelector('#z-pcode').textContent = per2;
      if (!/^\d{6}$/.test(per2)) { note.innerHTML = ''; return; }
      let r; try { r = await NALA.api('GET', `zero-filings?client_id=${s.client}&period=${per2}`); } catch (e) { note.innerHTML = `<div class="issue warning"><span class="ico">!</span>${esc(e.message)}</div>`; return; }
      const c = r.counts?.[fmt]; const done = (r.filings || []).filter(f => f.format === fmt);
      const out = [];
      if (fmt === '608') out.push('<div class="issue info"><span class="ico">i</span>NALA no maneja el 608 (anulaciones): declara el período en cero solo si no hubo comprobantes anulados.</div>');
      else if (c?.approved) out.push(`<div class="issue critical"><span class="ico">✕</span>Este período tiene ${int(c.approved)} comprobante(s) aprobado(s) en el ${fmt}: se envía el archivo con las operaciones, no el informativo.</div>`);
      else if (c?.open) out.push(`<div class="issue warning"><span class="ico">!</span>Hay ${int(c.open)} comprobante(s) sin aprobar en el ${fmt}. Apruébalos o exclúyelos antes de declarar el período en cero.</div>`);
      else out.push(`<div class="issue info"><span class="ico">✓</span>Sin comprobantes en el ${fmt} de ese período: puede declararse en cero.</div>`);
      for (const f of done) out.push(`<div class="issue info"><span class="ico">✓</span>Ya registrado: código <b class="mono">${esc(f.reference)}</b> (${NALA.dateTime(f.submitted_at)}).</div>`);
      note.innerHTML = out.join('');
    };
    fmtEl.addEventListener('change', refresh); perEl.addEventListener('change', refresh); refresh();
    m.querySelector('#z-open').addEventListener('click', () => {
      if (!rnc) { NALA.toast('La empresa no tiene RNC o cédula registrado.', 'warn'); return; }
      try { NALA.host().postMessage({ action: 'nala-open-dgii-envio', rnc, format: fmtEl.value, period: perEl.value.replace('-', ''), fileName: '' }, location.origin); } catch (_) { /* fuera del shell */ }
      NALA.toast('Abriendo la Oficina Virtual de la empresa…', 'ok');
    });
    if (await p) NALA.route();
  }


  // Listos para exportar: por empresa, formato y período, lo aprobado y lo que falta
  // por auditar. Con auditoría completa se saca el TXT o el Excel con un clic: NALA
  // genera el archivo (o reutiliza el último si nada cambió) y lo descarga.
  const auditLink = g => `#/auditoria?${new URLSearchParams({ client: g.client_id, period: g.period, format: g.format, status: 'pending_review,reviewed' })}`;

  function askWarnings(snap) {
    return NALA.modal({ title: 'Advertencias del archivo', okText: 'Aceptar y generar', wide: true,
      body: `<p class="muted" style="margin-bottom:8px">Acepta cada advertencia para generar el archivo. Quedan registradas.</p>
        <div class="stack" style="gap:6px">${snap.warnings.map(w => `<label class="issue warning"><input type="checkbox" class="acc" value="${esc(w.code)}"> <span>${esc(w.message)}${w.lines?.length ? ` <span class="muted">· líneas ${w.lines.slice(0, 12).join(', ')}${w.lines.length > 12 ? '…' : ''}</span>` : ''}</span></label>`).join('')}</div>
        <label class="f" style="margin-top:8px"><span>Motivo para exportar con advertencias</span><textarea id="acc-reason" rows="2"></textarea></label>`,
      onOk: m => {
        const accepted = [...m.querySelectorAll('.acc:checked')].map(x => x.value);
        if (accepted.length !== snap.warnings.length) throw new Error('Acepta cada advertencia antes de exportar.');
        const reason = m.querySelector('#acc-reason').value.trim();
        if (reason.length < 5) throw new Error('Indica el motivo (mín. 5 caracteres).');
        return { accepted, reason };
      } });
  }

  async function exportNow(g, type, btn) {
    const body = { client_id: g.client_id, format: g.format, period: g.period };
    const label = btn.textContent; btn.disabled = true; btn.textContent = '…';
    try {
      const preview = await NALA.api('POST', 'exports/preview', body);
      const snap = preview.snapshot;
      if (snap.errors.length) {
        const go = await NALA.modal({ title: 'No se puede exportar todavía', okText: 'Ir a auditar', okClass: 'primary',
          body: `<p class="muted" style="margin-bottom:8px">Hay errores que bloquean el archivo. Corrígelos en Auditoría fiscal:</p><div class="stack" style="gap:6px">${snap.errors.slice(0, 15).map(e => `<div class="issue critical"><span class="ico">✕</span>${esc(e.message)}</div>`).join('')}${snap.errors.length > 15 ? `<div class="muted">… y ${snap.errors.length - 15} más.</div>` : ''}</div>` });
        if (go) NALA.go(auditLink(g));
        return;
      }
      // Si el último archivo del mes sigue vigente y nada cambió (misma huella), se reutiliza.
      let exp = g.last_export && ['generated', 'submitted', 'accepted'].includes(g.last_export.status) && g.last_export.fingerprint === preview.fingerprint ? g.last_export : null;
      if (!exp) {
        if (!NALA.can('export')) { NALA.toast('Su rol no permite generar exportaciones.', 'err'); return; }
        let accepted = []; let reason = '';
        if (snap.warnings.length) { const r = await askWarnings(snap); if (!r) return; ({ accepted, reason } = r); }
        exp = (await NALA.api('POST', 'exports', { ...body, accepted_warnings: accepted, reason, preview_fingerprint: preview.fingerprint })).export;
      }
      await download(exp, type);
      NALA.toast(`${type === 'txt' ? 'TXT' : 'Excel'} listo: ${exp.file_name}`, 'ok');
      NALA.route();
    } catch (e) {
      if (e.status === 409) { NALA.toast(e.message, 'err'); NALA.route(); } else NALA.fail(e);
    } finally { btn.disabled = false; btn.textContent = label; }
  }

  async function list(root) {
    const s = NALA.state;
    const qs = new URLSearchParams(Object.entries({ client_id: s.client, period: s.period, format: s.format }).filter(([, v]) => v));
    const [{ exports }, { items }, zero] = await Promise.all([
      NALA.api('GET', `exports?${qs}`),
      NALA.api('GET', `export-ready?${qs}`),
      s.client ? NALA.api('GET', `zero-filings?client_id=${s.client}`).catch(() => ({ filings: [] })) : Promise.resolve({ filings: [] }),
    ]);
    const zeroCard = zero.filings.length ? `<div class="card"><h2>Informativos en cero presentados</h2><div class="table-wrap"><table><tr><th>Formato</th><th>Período</th><th>Código de referencia</th><th>Presentado</th></tr>
      ${zero.filings.map(f => `<tr><td>${esc(f.format)}</td><td>${period(f.period)}</td><td class="mono">${esc(f.reference)}</td><td>${NALA.dateTime(f.submitted_at)}</td></tr>`).join('')}</table></div></div>` : '';
    const readyRow = (g, i) => `<tr data-ready="${i}"><td>${esc(NALA.clientName(g.client_id))}</td><td>${esc(g.format)}</td><td>${period(g.period)}</td><td class="num">${int(g.approved)}</td>
      <td>${g.ready ? '<span class="badge ok">✓ Auditoría completa</span>' : `<span class="badge warn">Faltan ${int(g.open)} por auditar</span>`}</td>
      <td>${g.last_export ? `${NALA.badge(g.last_export.status)} <span class="muted">${NALA.dateTime(g.last_export.created_at)}</span>` : '<span class="muted">—</span>'}</td>
      <td style="white-space:nowrap">${g.ready
        ? `<button class="btn sm primary" data-exp="${i}" data-type="txt" title="Descargar el TXT para la DGII">TXT</button> <button class="btn sm" data-exp="${i}" data-type="xlsx" title="Descargar el Excel">Excel</button>${g.last_export ? ` <a class="btn sm" href="#/exportar/${g.last_export.id}" title="Ver el archivo y registrar el envío a la DGII">Envío →</a>` : ''}`
        : `<a class="btn sm" href="${auditLink(g)}">Ir a auditar</a>`}</td></tr>`;
    root.innerHTML = `<div class="stack"><div class="row">${NALA.can('submit') ? '<button class="btn" id="zero" title="Para períodos sin compras ni ventas">Informativo en cero</button>' : ''}<span class="muted">${s.client ? esc(NALA.clientName(s.client)) : 'Todas las empresas'} · ${s.period ? period(s.period) : 'Todos los períodos'}</span></div>
      <div class="card"><h2>Listos para exportar</h2>
        ${items.length ? `<div class="table-wrap"><table><tr><th>Empresa</th><th>Formato</th><th>Período</th><th class="num">Aprobados</th><th>Auditoría</th><th>Último archivo</th><th></th></tr>${items.map(readyRow).join('')}</table></div>
        <p class="muted" style="margin-top:8px">Con la auditoría completa, pulsa <b>TXT</b> o <b>Excel</b>: NALA genera el archivo del mes (o reutiliza el último si nada cambió) y lo descarga para enviarlo a la DGII.</p>`
        : '<div class="empty">No hay comprobantes aprobados en este alcance. Aprueba comprobantes en <a href="#/auditoria">Auditoría fiscal</a>.</div>'}</div>
      ${zeroCard}
      ${exports.length ? `<div class="card"><h2>Archivos generados</h2><div class="table-wrap"><table><tr><th>Archivo</th><th>Empresa</th><th>Alcance</th><th>Estado</th><th class="num">Líneas</th><th>Generado</th><th>Enviado</th></tr>
        ${exports.map(e => `<tr class="clickable" data-id="${e.id}"><td class="mono">${esc(e.file_name)}</td><td>${esc(NALA.clientName(e.client_id))}</td><td>${e.scope === 'period' ? 'Mes' : `${e.batch_ids.length} lote(s)`}</td><td>${NALA.badge(e.status)}</td><td class="num">${int(e.line_count)}</td><td>${NALA.dateTime(e.created_at)}</td><td>${NALA.dateTime(e.submitted_at)}</td></tr>`).join('')}</table></div></div>` : ''}</div>`;
    root.querySelector('#zero')?.addEventListener('click', () => zeroFiling());
    root.querySelectorAll('button[data-exp]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); exportNow(items[Number(b.dataset.exp)], b.dataset.type, b); }));
    root.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => NALA.go(`#/exportar/${tr.dataset.id}`)));
  }

  NALA.views.exportar = {
    title: 'Exportar DGII 606/607',
    render(root, { id }) { if (id) return detail(root, id); return list(root); },
  };
})();
