/* Estados Financieros — asistente de carga: archivo → vista previa → asociación de columnas → validación → confirmación. */
(function () {
  const { esc, money } = EF;

  // Devuelve true si se guardó algo. d = detalle del informe (para saber modalidad y permisos).
  EF.openImport = d => {
    const r = d.report; const m = EF.mod(r.modality);
    const st = { file: null, b64: null, name: '', mapping: null, header_row: null, sheet: null, allow_duplicates: false, save_mapping: false, preview: null };
    let done = false;
    return EF.modal({ title: `Cargar archivo · ${m.singular}`, okText: 'Confirmar y guardar', wide: true,
      body: `<div id="imp-root"><p class="muted">Suba un Excel (.xlsx) o CSV. Después de la vista previa podrá asociar las columnas de su archivo con los campos de Direct y verá cada error con su fila. No se guarda nada hasta que confirme.</p>
        <div class="btn-row"><label class="btn sm">📎 Elegir archivo<input id="imp-file" type="file" accept=".xlsx,.csv,.txt" hidden></label><span class="muted" id="imp-name">Ningún archivo</span>
        <button class="btn sm" id="imp-tpl" type="button">⬇ Descargar plantilla</button></div><div id="imp-out" style="margin-top:10px"></div></div>`,
      onOpen: (modal, { okBtn }) => {
        okBtn.disabled = true;
        modal.querySelector('#imp-tpl').addEventListener('click', () => EF.downloadTemplate(r.modality));
        const out = modal.querySelector('#imp-out');
        const run = async () => {
          out.innerHTML = '<div class="empty">Leyendo el archivo…</div>'; okBtn.disabled = true;
          try {
            const p = await EF.api('POST', `reports/${r.id}/import/preview`, { file_base64: st.b64, file_name: st.name, mapping: st.mapping || undefined, header_row: st.header_row || undefined, sheet: st.sheet || undefined, allow_duplicates: st.allow_duplicates });
            st.preview = p; st.mapping = p.mapping; st.header_row = p.header_row; st.sheet = p.sheet;
            draw(p);
          } catch (e) { out.innerHTML = `<div class="issue critical"><span class="ico">✕</span><span>${esc(e.message)}</span></div>`; }
        };
        const draw = p => {
          const opt = sel => `<option value="">— sin columna —</option>${p.headers.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${i + 1} · ${esc(h || '(vacía)')}</option>`).join('')}`;
          out.innerHTML = `<div class="card"><h2>1 · Archivo</h2><div class="muted">${esc(p.file.name)} · ${(p.file.size / 1024).toFixed(0)} KB · SHA-256 ${esc(p.file.sha256.slice(0, 16))}… ${p.sheet ? `· hoja «${esc(p.sheet)}»` : ''}</div>
            <div class="row" style="margin-top:6px"><label class="f"><span>Fila del encabezado</span><input id="imp-hdr" type="number" min="1" value="${p.header_row}" style="width:90px"></label>
              ${p.sheets.length > 1 ? `<label class="f"><span>Hoja</span><select id="imp-sheet">${p.sheets.map(s => `<option ${s === p.sheet ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>` : ''}</div></div>
            <div class="card" style="margin-top:8px"><h2>2 · Asociar columnas ${p.saved_mapping_used ? '<span class="badge info">asociación guardada aplicada</span>' : ''}</h2>
              <div class="map-grid">${p.fields.map(f => `<label class="f"><span>${esc(f.label)}${f.required ? ' *' : ''}</span><select data-map="${f.key}">${opt(p.mapping[f.key])}</select><small class="muted">${esc(f.hint)}</small></label>`).join('')}</div></div>
            <div class="card" style="margin-top:8px"><h2>3 · Vista previa (primeras filas)</h2><div class="table-wrap"><table><tr>${p.headers.map((h, i) => `<th>${i + 1} · ${esc(h)}</th>`).join('')}</tr>${p.preview.map(row => `<tr>${p.headers.map((_, i) => `<td>${esc(row[i] ?? '')}</td>`).join('')}</tr>`).join('')}</table></div></div>
            <div class="card" style="margin-top:8px"><h2>4 · Validación</h2>
              <div>${p.total_rows} fila(s) de datos · <b style="color:var(--ok)">${p.valid_rows} válida(s)</b> · <b style="color:${p.error_count ? 'var(--crit)' : 'var(--muted)'}">${p.error_count} error(es)</b></div>
              ${p.totals ? `<div class="muted">Débitos ${money(p.totals.debit)} · Créditos ${money(p.totals.credit)}${p.balance ? (p.balance.applied ? (p.balance.ok ? ' · <span style="color:var(--ok)">cuadra</span>' : ` · <span style="color:var(--crit)">${p.balance.issues.length} descuadre(s)</span>`) : ' · cuadre sin validar (regla no definida)') : ''}</div>` : ''}
              ${p.error_count ? `<div class="err-list" style="margin-top:6px">${p.errors.map(e => `<div><b>${e.row ? `Fila ${e.row}` : 'Archivo'}${e.field ? ` · ${esc(e.field)}` : ''}:</b> ${esc(e.message)}</div>`).join('')}${p.error_count > p.errors.length ? `<div>… y ${p.error_count - p.errors.length} más</div>` : ''}</div>` : ''}
              ${r.modality !== 'proyectado' ? `<label style="display:block;margin-top:8px"><input type="checkbox" id="imp-dup" ${st.allow_duplicates ? 'checked' : ''}> Permitir filas repetidas (las revisé y son correctas)</label>` : ''}
              <label style="display:block;margin-top:4px"><input type="checkbox" id="imp-save" ${st.save_mapping ? 'checked' : ''}> Recordar esta asociación de columnas para archivos con los mismos encabezados</label>
              ${p.can_confirm ? '' : '<p class="muted" style="margin-top:6px">Corrija el archivo o la asociación para poder confirmar. Nada se guardó.</p>'}</div>`;
          okBtn.disabled = !p.can_confirm;
          out.querySelectorAll('[data-map]').forEach(s => s.addEventListener('change', () => { st.mapping = Object.fromEntries([...out.querySelectorAll('[data-map]')].map(x => [x.dataset.map, x.value === '' ? null : Number(x.value)])); run(); }));
          out.querySelector('#imp-hdr').addEventListener('change', e => { st.header_row = Number(e.target.value) || 1; st.mapping = null; run(); });
          out.querySelector('#imp-sheet')?.addEventListener('change', e => { st.sheet = e.target.value; st.mapping = null; st.header_row = null; run(); });
          out.querySelector('#imp-dup')?.addEventListener('change', e => { st.allow_duplicates = e.target.checked; run(); });
          out.querySelector('#imp-save').addEventListener('change', e => { st.save_mapping = e.target.checked; });
        };
        modal.querySelector('#imp-file').addEventListener('change', async e => {
          const f = e.target.files[0]; if (!f) return;
          try { st.b64 = await EF.fileToBase64(f); } catch (err) { EF.fail(err); return; }
          st.name = f.name; st.mapping = null; st.header_row = null; st.sheet = null; modal.querySelector('#imp-name').textContent = `📎 ${f.name}`; run();
        });
      },
      onOk: async () => {
        const p = st.preview;
        if (!p || !p.can_confirm) throw new Error('Todavía hay errores en el archivo.');
        const out = await EF.api('POST', `reports/${r.id}/import/confirm`, { file_base64: st.b64, file_name: st.name, mapping: st.mapping, header_row: st.header_row, sheet: st.sheet, allow_duplicates: st.allow_duplicates, save_mapping: st.save_mapping });
        EF.toast(`${out.rows} fila(s) guardadas${out.source_file_stored ? '' : ' (el archivo original no se pudo guardar; consta su huella SHA-256)'}`, 'ok');
        done = true; return true;
      } }).then(ok => !!ok && done);
  };
})();
