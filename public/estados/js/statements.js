/* Estados Financieros — cifras de los estados (Situación Financiera, Resultados, Flujo de Efectivo) y paquete para imprimir.
   Contabilidad entrega las cifras de cada línea; Direct solo calcula los totales (EFStatements) y valida que cuadren. */
(function () {
  const { esc, dateOnly } = EF;
  const S = window.EFStatements;
  const num = v => (v === null || v === undefined ? '-' : (Number(v) < 0 ? `(${Math.abs(Number(v)).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : Number(v).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
  const SEV = { blocking: 'Bloqueante', warning: 'Advertencia', info: 'Nota' };
  const parseNum = raw => {
    let s = String(raw ?? '').trim(); if (s === '') return { value: null };
    let neg = false; if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); } if (s.startsWith('-')) { neg = true; s = s.slice(1); }
    s = s.replace(/RD\$|\$|\s/gi, '').replace(/,/g, '');
    if (!/^\d+(\.\d+)?$/.test(s)) return { error: true };
    return { value: Math.round((Number(s) * (neg ? -1 : 1) + Number.EPSILON) * 100) / 100 };
  };
  const fmtRnc = r => { const d = String(r || '').replace(/\D/g, ''); return d.length === 9 ? `${d.slice(0, 3)}-${d.slice(3, 8)}-${d.slice(8)}` : d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 10)}-${d.slice(10)}` : (r || ''); };

  // ── Pestaña «Estados financieros» del informe ──
  EF.statementsTab = async (body, d, reload) => {
    const id = d.report.id;
    body.innerHTML = '<div class="empty">Cargando los estados…</div>';
    const data = await EF.api('GET', `reports/${id}/statements`);
    if (!data.months.length) { body.innerHTML = '<div class="card empty">Defina las fechas de inicio y fin del informe para armar las columnas de los meses.</div>'; return; }
    const n = data.months.length; let cur = EF.stmtTab || 'esf';
    const vals = JSON.parse(JSON.stringify(data.values)); let customs = JSON.parse(JSON.stringify(data.custom_lines)); const dirty = {};
    let computed = data.computed; let checks = data.checks;
    const canEdit = data.can_edit;
    const tplOf = st => S.template(st, customs);
    const recompute = () => { computed = S.compute(vals, n, customs); checks = S.checks(computed, vals, n, data.months); };
    const cellId = (st, k, m) => `c-${st}-${k}-${m}`;

    const gridHtml = st => {
      const tpl = tplOf(st);
      const head = `<tr><th>${esc(tpl.title)}</th><th class="num">ANUAL</th>${data.months.map(m => `<th class="num">${m.label.slice(0, 3)}<br><small>${m.year}</small></th>`).join('')}</tr>`;
      const rows = tpl.lines.map(l => {
        if (l.t === 'head' || l.t === 'subhead') return `<tr class="ef-${l.t}"><td colspan="${n + 2}">${esc(l.label)}</td></tr>`;
        const editable = canEdit && (l.t === 'input' || (l.t === 'roll'));
        const cells = [0, ...data.months.map(m => m.idx)].map(m => {
          if (m === 0) {
            if (l.monthlyOnly) return '<td class="num"></td>';
            if (l.t === 'input' && tpl.annual === 'manual') return editable ? `<td class="num"><input class="ef-in" data-st="${st}" data-k="${l.k}" data-m="0" value="${vals[st][l.k] && vals[st][l.k][0] != null ? vals[st][l.k][0] : ''}" inputmode="decimal"></td>` : `<td class="num" id="${cellId(st, l.k, 0)}">${num(computed[st][l.k][0])}</td>`;
            return `<td class="num" id="${cellId(st, l.k, 0)}">${num(computed[st][l.k] ? computed[st][l.k][0] : null)}</td>`;
          }
          if (editable && (l.t === 'input' || (l.t === 'roll' && m === 1))) return `<td class="num"><input class="ef-in" data-st="${st}" data-k="${l.k}" data-m="${m}" value="${vals[st][l.k] && vals[st][l.k][m] != null ? vals[st][l.k][m] : ''}" inputmode="decimal"></td>`;
          return `<td class="num" id="${cellId(st, l.k, m)}">${num(computed[st][l.k] ? computed[st][l.k][m] : null)}</td>`;
        }).join('');
        return `<tr class="ef-${l.t}${l.strong ? ' strong' : ''}${l.grand ? ' grand' : ''}"><td>${esc(l.label)}${l.custom ? ' <span class="badge info" title="Línea propia de este informe">propia</span>' : ''}</td>${cells}</tr>`;
      }).join('');
      return `<div class="table-wrap ef-grid"><table>${head}${rows}</table></div>`;
    };
    const checksHtml = () => (checks.length ? `<ul class="pend">${checks.map(c => `<li class="${c.severity}"><b>${SEV[c.severity]}:</b> ${esc(c.message)}</li>`).join('')}</ul>` : '<p class="muted">Sin observaciones: lo cargado cuadra.</p>');

    const draw = () => {
      body.innerHTML = `<div class="card"><h2>Estados financieros <span class="${d.report.modality === 'proyectado' ? 'proj-tag' : 'real-tag'}">${d.report.modality === 'proyectado' ? 'PROYECTADO · cifras estimadas' : 'REAL'}</span><span class="spacer"></span>
        <span class="btn-row no-print">${canEdit ? '<button class="btn sm primary" id="st-save" disabled>Guardar cifras</button><button class="btn sm" id="st-import">⬆ Cargar Excel de estados</button><button class="btn sm" id="st-add">+ Agregar línea</button><button class="btn sm" id="st-pkg-edit">✎ Datos del informe del contador</button>' : ''}<button class="btn sm" id="st-pkg">📄 Ver paquete / PDF</button></span></h2>
        <p class="muted">Contabilidad entrega las <b>cifras de cada línea</b> (a mano o desde su Excel). Direct solo calcula los <b>totales</b> (sumas y restas del modelo) y valida que el balance cuadre. No proyecta ni inventa cifras.${data.months_warning ? ` <b>${esc(data.months_warning)}</b>` : ''}</p>
        <div class="tabs no-print">${S.ORDER.map(k => `<button data-st="${k}" class="${k === cur ? 'active' : ''}">${esc(S.STATEMENTS[k].short)}</button>`).join('')}</div>
        <div id="st-grid">${gridHtml(cur)}</div>
        <div style="margin-top:10px"><b>Comprobaciones</b><div id="st-checks">${checksHtml()}</div></div></div>`;
      body.querySelectorAll('.tabs [data-st]').forEach(b => b.addEventListener('click', () => { if (Object.keys(dirty).length && !confirm('Hay cifras sin guardar en esta pantalla. ¿Cambiar de estado igual? (se conservan hasta que recargues)')) return; cur = b.dataset.st; EF.stmtTab = cur; draw(); }));
      body.querySelectorAll('.ef-in').forEach(inp => inp.addEventListener('input', () => onInput(inp)));
      body.querySelector('#st-save')?.addEventListener('click', save);
      body.querySelector('#st-import')?.addEventListener('click', importFile);
      body.querySelector('#st-add')?.addEventListener('click', addLine);
      body.querySelector('#st-pkg-edit')?.addEventListener('click', () => EF.editPackage(d, reload));
      body.querySelector('#st-pkg').addEventListener('click', () => EF.go(`#/p/${id}`));
      markSave();
    };
    const markSave = () => { const b = body.querySelector('#st-save'); if (b) { const n2 = Object.values(dirty).reduce((a, st) => a + Object.values(st).reduce((b2, o) => b2 + Object.keys(o).length, 0), 0); b.disabled = !n2; b.textContent = n2 ? `Guardar cifras (${n2})` : 'Guardar cifras'; } };
    const refreshCells = () => {
      for (const l of tplOf(cur).lines) { if (l.t === 'head' || l.t === 'subhead' || l.t === 'input') continue; for (const m of [0, ...data.months.map(x => x.idx)]) { const el = body.querySelector(`#${cellId(cur, l.k, m)}`); if (el) el.textContent = num(computed[cur][l.k] ? computed[cur][l.k][m] : null); } }
      body.querySelector('#st-checks').innerHTML = checksHtml();
    };
    const onInput = inp => {
      const st = inp.dataset.st; const k = inp.dataset.k; const m = Number(inp.dataset.m); const p = parseNum(inp.value);
      inp.classList.toggle('bad', !!p.error); if (p.error) return;
      vals[st][k] = vals[st][k] || {}; if (p.value === null) delete vals[st][k][m]; else vals[st][k][m] = p.value;
      (dirty[st] = dirty[st] || {})[k] = dirty[st][k] || {}; dirty[st][k][m] = p.value === null ? null : String(p.value);
      recompute(); refreshCells(); markSave();
    };
    const save = async () => { try { const out = await EF.api('PUT', `reports/${id}/statements`, { values: dirty }); EF.toast(`${out.saved} cifra(s) guardadas`, 'ok'); reload(); } catch (e) { EF.fail(e); } };
    const addLine = async () => {
      const r = await EF.modal({ title: 'Agregar una línea propia', okText: 'Agregar', body: `<p class="muted">Para una cuenta que no está en la plantilla (por ejemplo «Inventario»). Se suma al total de la sección que elijas.</p><div class="map-grid">
        <label class="f"><span>Estado</span><select id="l-st">${S.ORDER.map(k => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(S.STATEMENTS[k].short)}</option>`).join('')}</select></label>
        <label class="f"><span>Sección (total al que se suma)</span><select id="l-par"></select></label>
        <label class="f" style="grid-column:1/-1"><span>Nombre de la línea *</span><input id="l-name" maxlength="120"></label></div>`,
        onOpen: m => { const fill = () => { m.querySelector('#l-par').innerHTML = S.STATEMENTS[m.querySelector('#l-st').value].lines.filter(l => l.t === 'sum' && !l.grand).map(l => `<option value="${l.k}">${esc(l.label)}</option>`).join(''); }; m.querySelector('#l-st').addEventListener('change', fill); fill(); },
        onOk: async m => { const label = m.querySelector('#l-name').value.trim(); if (!label) throw new Error('Escriba el nombre de la línea.'); const key = `c_${Math.random().toString(36).slice(2, 8)}`;
          await EF.api('PUT', `reports/${id}/statements`, { custom_lines: [...customs, { statement: m.querySelector('#l-st').value, key, label, parent: m.querySelector('#l-par').value }], values: {} }); return true; } });
      if (r) reload();
    };
    const importFile = async () => {
      let st = null; let b64 = null; let fname = '';
      await EF.modal({ title: 'Cargar el Excel de los estados', okText: 'Confirmar y guardar', wide: true,
        body: `<p class="muted">Suba el Excel del modelo: <b>una hoja por estado</b> (Situación Financiera, Resultados, Flujo de Efectivo) con los meses en columnas (ENERO … DICIEMBRE). Direct reconoce cada línea por su nombre, guarda las <b>cifras</b> y compara los totales del archivo con los que calcula.</p>
          <div class="btn-row"><label class="btn sm">📎 Elegir archivo<input id="si-file" type="file" accept=".xlsx,.csv" hidden></label><span class="muted" id="si-name">Ningún archivo</span><label class="f" id="si-stwrap" hidden><span>Estado del archivo</span><select id="si-st"><option value="">—</option>${S.ORDER.map(k => `<option value="${k}">${esc(S.STATEMENTS[k].short)}</option>`).join('')}</select></label></div><div id="si-out" style="margin-top:10px"></div>`,
        onOpen: (m, { okBtn }) => {
          okBtn.disabled = true; const out = m.querySelector('#si-out');
          const run = async () => {
            out.innerHTML = '<div class="empty">Leyendo el archivo…</div>'; okBtn.disabled = true;
            try {
              const p = await EF.api('POST', `reports/${id}/statements/import`, { file_base64: b64, file_name: fname, statement: st || undefined });
              st = st || null;
              out.innerHTML = `<div>${p.sheets.map(x => `<span class="badge info">${esc(x.sheet || fname)} → ${esc(S.STATEMENTS[x.statement].short)} (${x.columns} columnas)</span>`).join(' ')}</div>
                <p><b style="color:var(--ok)">${p.values} cifra(s)</b> reconocidas${p.errors.length ? ` · <b style="color:var(--crit)">${p.errors.length} error(es)</b>` : ''}${p.unmatched.length ? ` · <b style="color:var(--warn)">${p.unmatched.length} fila(s) sin reconocer</b>` : ''}.</p>
                ${p.errors.length ? `<div class="err-list">${p.errors.map(e => `<div><b>${esc(e.sheet || '')} fila ${e.row || ''} · ${esc(e.field || '')}:</b> ${esc(e.message)}</div>`).join('')}</div>` : ''}
                ${p.unmatched.length ? `<div class="err-list" style="border-color:var(--warn);background:var(--warn-bg)">${p.unmatched.map(u => `<div>Fila ${u.row} «${esc(u.label)}» no coincide con ninguna línea (puede agregarla con «+ Agregar línea» y volver a cargar).</div>`).join('')}</div><label style="display:block;margin-top:6px"><input type="checkbox" id="si-skip"> Omitir las filas sin reconocer (sus cifras NO se guardan)</label>` : ''}
                ${p.total_diffs.length ? `<p style="margin-top:8px"><b>Totales del archivo que no coinciden con los calculados:</b></p><div class="err-list" style="border-color:var(--warn);background:var(--warn-bg)">${p.total_diffs.slice(0, 40).map(x => `<div>${esc(S.STATEMENTS[x.statement].short)} · ${esc(x.line)} · mes ${x.month}: archivo ${num(x.file)} vs calculado ${num(x.calculated)} (${x.rounding ? 'redondeo' : 'diferencia'} ${num(x.diff)})</div>`).join('')}</div>` : '<p class="muted">Los totales del archivo coinciden con los calculados.</p>'}
                ${p.checks.length ? `<ul class="pend">${p.checks.map(c => `<li class="${c.severity}"><b>${SEV[c.severity]}:</b> ${esc(c.message)}</li>`).join('')}</ul>` : ''}`;
              const ready = () => okBtn.disabled = !(p.errors.length === 0 && p.values > 0 && (p.unmatched.length === 0 || out.querySelector('#si-skip')?.checked));
              ready(); out.querySelector('#si-skip')?.addEventListener('change', ready);
              m._allowUnmatched = () => !!out.querySelector('#si-skip')?.checked;
            } catch (e) { out.innerHTML = `<div class="issue critical"><span class="ico">✕</span><span>${esc(e.message)}</span></div>`; if (/qué estado/.test(e.message)) m.querySelector('#si-stwrap').hidden = false; }
          };
          m.querySelector('#si-st').addEventListener('change', e => { st = e.target.value || null; if (b64) run(); });
          m.querySelector('#si-file').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; try { b64 = await EF.fileToBase64(f); } catch (err) { EF.fail(err); return; } fname = f.name; m.querySelector('#si-name').textContent = `📎 ${f.name}`; run(); });
        },
        onOk: async m => { const o = await EF.api('POST', `reports/${id}/statements/import`, { file_base64: b64, file_name: fname, statement: st || undefined, confirm: true, allow_unmatched: m._allowUnmatched ? m._allowUnmatched() : false }); EF.toast(`${o.saved} cifra(s) guardadas${o.source_file_stored ? '' : ' (archivo original no guardado; consta su huella)'}`, 'ok'); reload(); return true; } });
    };
    draw();
  };

  // ── Datos del informe del contador (fecha, firmante, texto) ──
  EF.editPackage = async (d, reload) => {
    const p = d.report.package || {};
    const ok = await EF.modal({ title: 'Datos del informe del contador', okText: 'Guardar', wide: true, body: `<p class="muted">Lo que aquí se deje vacío se toma de los datos de la firma (Configuración). Puede usar {EMPRESA} {RNC} {DESDE} {HASTA} {ANIO} {TIPO} {TIPOS} en el texto.</p><div class="map-grid">
      <label class="f"><span>Título de la portada (vacío = automático)</span><input id="p-title" maxlength="200" value="${esc(p.titulo_portada || '')}"></label>
      <label class="f"><span>Fecha del informe</span><input id="p-fecha" type="date" value="${esc(p.fecha_informe || '')}"></label>
      <label class="f"><span>Firmante</span><input id="p-nom" maxlength="120" value="${esc(p.firmante_nombre || '')}"></label>
      <label class="f"><span>Título (Licda., Lic., CPA…)</span><input id="p-tit" maxlength="120" value="${esc(p.firmante_titulo || '')}"></label>
      <label class="f"><span>Exequátur</span><input id="p-exe" maxlength="60" value="${esc(p.exequatur || '')}"></label><label class="f"><span>ICPARD</span><input id="p-icp" maxlength="60" value="${esc(p.icpard || '')}"></label>
      <label class="f"><span>Ciudad</span><input id="p-ciu" maxlength="120" value="${esc(p.ciudad || '')}"></label>
      <label class="f" style="grid-column:1/-1"><span>Texto del informe (vacío = el de la firma)</span><textarea id="p-txt" rows="8" maxlength="4000">${esc(p.informe_text || '')}</textarea></label></div>`,
      onOk: async m => { const v = s => m.querySelector(s).value.trim(); await EF.api('PUT', `reports/${d.report.id}/package`, { titulo_portada: v('#p-title'), fecha_informe: v('#p-fecha'), firmante_nombre: v('#p-nom'), firmante_titulo: v('#p-tit'), exequatur: v('#p-exe'), icpard: v('#p-icp'), ciudad: v('#p-ciu'), informe_text: v('#p-txt') }); return true; } });
    if (ok) reload();
  };

  // ── Paquete para imprimir / PDF: portada, informe del contador y cada estado (anual y mensual) ──
  EF.views.p = {
    title: 'Paquete de estados financieros',
    async render(root, { arg }) {
      const k = await EF.api('GET', `reports/${arg}/package`);
      const r = k.report; const n = k.months.length;
      const approved = ['aprobado', 'cerrado', 'pendiente_legalizacion'].includes(r.status);
      const prelim = !approved || !k.completeness.complete;
      const foot = `<div class="pkg-foot">${esc(k.firm.name)}</div>`;
      const logo = k.firm.logo ? `<img class="pkg-logo" src="${k.firm.logo}" alt="${esc(k.firm.name)}">` : (k.firm.name ? `<div class="pkg-logo-txt">${esc(k.firm.name)}</div>` : '');
      const head = (title) => `<div class="pkg-h"><b>ESTADOS FINANCIEROS ${r.modality === 'proyectado' ? 'PROYECTADOS' : r.modality === 'interino' ? 'INTERINOS' : ''}</b><br><b>${esc(r.client_name)}</b><br><b>${esc(fmtR(r.client_rnc))}</b><br><b>${esc(title)}</b><br><b>${esc(k.range_text)}</b><br><b>VALORES EN ${esc(k.currency_label)}</b></div>`;
      const fmtR = x => fmtRnc(x);
      const table = (st, monthly) => {
        const tpl = k.templates[st]; const comp = k.computed[st]; const cols = monthly ? k.months.map(m => m.idx) : [0];
        const hdr = monthly ? `<tr><th></th>${k.months.map(m => `<th class="num">${m.label}</th>`).join('')}</tr>` : '';
        const rows = tpl.lines.filter(l => !(l.monthlyOnly && !monthly)).map(l => {
          if (l.t === 'head' || l.t === 'subhead') return `<tr class="pk-${l.t}"><td colspan="${cols.length + 1}">${esc(l.label)}</td></tr>`;
          const label = monthly && l.labelMonthly ? l.labelMonthly : l.label;
          return `<tr class="${l.strong ? 'strong' : ''}${l.grand ? ' grand' : ''}"><td>${esc(label)}</td>${cols.map(m => `<td class="num">${num(comp[l.k] ? comp[l.k][m] : null)}</td>`).join('')}</tr>`;
        }).join('');
        return `<table class="pkg-t ${monthly ? 'monthly' : ''}">${hdr}${rows}</table>`;
      };
      const paragraphs = k.informe.split(/\n\n+/).map(t => `<p>${esc(t)}</p>`).join('');
      const pages = [];
      pages.push(`<section class="pkg-page pkg-cover">${logo}<div class="pkg-cover-co"><i><b>${esc(r.client_name)}</b></i><br><i><b>RNC ${esc(fmtR(r.client_rnc))}</b></i></div><div class="pkg-cover-title">${esc(k.title)}</div></section>`);
      pages.push(`<section class="pkg-page pkg-informe">${logo}<h2>${esc(k.informe_title)}</h2><div class="pkg-informe-txt">${paragraphs}</div><div class="pkg-sign"><p>Atentemente,</p><p><b>${esc(`${k.signer.titulo ? k.signer.titulo + ' ' : ''}${k.signer.nombre || ''}`.trim())}</b></p>${k.signer.exequatur ? `<p>EXEQUÁTUR ${esc(k.signer.exequatur)}</p>` : ''}${k.signer.icpard ? `<p>ICPARD ${esc(k.signer.icpard)}</p>` : ''}<p>${esc(k.signer.fecha || '')}</p><p>${esc(k.signer.ciudad || '')}</p></div>
        <div class="pkg-addr">${esc(k.firm.address || '')}<br>${esc(k.firm.phones || '')}</div></section>`);
      for (const st of S.ORDER) {
        if (!k.has_statements) break;
        pages.push(`<section class="pkg-page">${head(k.templates[st].title)}${table(st, false)}${foot}</section>`);
        if (n > 1) pages.push(`<section class="pkg-page pkg-land">${head(k.templates[st].title)}${table(st, true)}${foot}</section>`);
      }
      root.innerHTML = `<div class="stack"><div class="card no-print"><div class="row"><b>Paquete de estados financieros</b> ${EF.statusBadge(r.status)} <span class="spacer"></span>
        <span class="btn-row"><button class="btn" id="back">← Volver al informe</button><button class="btn primary" id="print">🖨 Imprimir / Guardar como PDF</button></span></div>
        ${prelim ? `<div class="banner prelim" style="margin-top:10px">DOCUMENTO PRELIMINAR — ${!approved ? `NO APROBADO (${esc(k.status_label)})` : 'INCOMPLETO'}${!k.completeness.complete ? ' · tiene información pendiente' : ''}. Se imprime con la marca de agua «PRELIMINAR».</div>` : ''}
        ${!k.has_statements ? '<div class="banner prelim" style="margin-top:10px">Todavía no hay cifras de los estados: solo se imprimen la portada y el informe. Cárguelas en la pestaña «Estados financieros».</div>' : ''}
        ${k.checks.filter(c => c.severity !== 'info').length ? `<ul class="pend" style="margin-top:8px">${k.checks.filter(c => c.severity !== 'info').map(c => `<li class="${c.severity}"><b>${SEV[c.severity]}:</b> ${esc(c.message)}</li>`).join('')}</ul>` : ''}
        <p class="muted" style="margin-top:8px">En el cuadro de impresión elija «Guardar como PDF». Las hojas con los meses salen en horizontal.</p></div>
        <div class="pkg ${prelim ? 'pkg-prelim' : ''}">${pages.join('')}</div></div>`;
      root.querySelector('#back').addEventListener('click', () => EF.go(`#/r/${arg}?tab=estados`));
      root.querySelector('#print').addEventListener('click', () => window.print());
    },
  };
})();
