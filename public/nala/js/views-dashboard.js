/* Panel de control y Dashboard por empresa. Todos los números salen de
   /api/nala/stats (función SQL nala_stats), la misma fuente que usan lotes,
   auditoría y exportación. */
(function () {
  const { esc, money, int, period } = NALA;

  const shiftPeriod = (p, months) => { const d = new Date(Number(p.slice(0, 4)), Number(p.slice(4)) - 1 + months, 1); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const q = obj => Object.entries(obj).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  function kpi(label, value, sub = '', href = '', tone = '') {
    return `<div class="card kpi ${tone ? 'kpi--' + tone : ''} ${href ? 'clickable' : ''}" ${href ? `data-href="${href}"` : ''}><div class="label">${esc(label)}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  }

  // Banner de estado del período: avance de aprobación + acciones sugeridas.
  function heroResumen(st, auditBase) {
    const inv = Number(st.invoices) || 0, ap = Number(st.approved) || 0, pend = Number(st.pending) || 0;
    const err = Number(st.with_errors) || 0, warn = Number(st.with_warnings) || 0;
    const pct = inv ? Math.round((ap / inv) * 100) : 0;
    const acts = [];
    if (pend) acts.push(`<button class="btn" data-href="${auditBase}&status=pending_review,reviewed">Revisar ${int(pend)} pendiente${pend === 1 ? '' : 's'}</button>`);
    if (err) acts.push(`<button class="btn" data-href="${auditBase}&has=errors">Corregir ${int(err)} con error${err === 1 ? '' : 'es'}</button>`);
    if (ap) acts.push(`<button class="btn primary" data-href="#/exportar">Exportar 606/607</button>`);
    return `<div class="card hero-sum">
      <div class="hs-pct"><div class="label">Avance de aprobación</div><div class="hs-num">${pct}<span>%</span></div></div>
      <div class="hs-bar">
        <div class="progress" style="height:10px"><div style="width:${pct}%;background:var(--ok)"></div></div>
        <div class="muted hs-line">${inv ? `<b>${int(ap)}</b> de ${int(inv)} aprobadas · ${int(pend)} pendientes · <span style="color:var(--crit)">${int(err)}</span> con errores · ${int(warn)} con advertencias` : 'Sin comprobantes en este período.'}</div>
      </div>
      ${acts.length ? `<div class="hs-acts">${acts.join('')}</div>` : ''}
    </div>`;
  }

  // Grouped bars (2 series), legend + per-bar tooltip + table toggle.
  function trendChart(rows, periods) {
    const data = periods.map(p => {
      const r = rows.filter(x => x.period === p);
      return { p, approved: r.reduce((s, x) => s + x.approved, 0), pending: r.reduce((s, x) => s + x.pending, 0), total: r.reduce((s, x) => s + Number(x.approved_total_dop || 0), 0) };
    });
    const max = Math.max(1, ...data.map(d => Math.max(d.approved, d.pending)));
    const W = 720; const H = 220; const left = 34; const bottom = 24; const top = 8; const plotH = H - bottom - top;
    const step = (W - left) / data.length; const bw = Math.max(4, Math.min(18, step / 3));
    const y = v => top + plotH - (v / max) * plotH;
    const ticks = [0, Math.round(max / 2), max];
    const bars = data.map((d, i) => {
      const x = left + i * step + step / 2;
      const hA = top + plotH - y(d.approved); const hP = top + plotH - y(d.pending);
      const bar = (bx, h, color) => (h > 0 ? `<path d="M${bx},${top + plotH} v${-(h - 4)} q0,-4 4,-4 h${bw - 8} q4,0 4,4 v${h - 4} z" fill="${color}"/>` : '');
      return `<g data-i="${i}">${bar(x - bw - 1, hA, 'var(--series-1)')}${bar(x + 1, hP, 'var(--series-2)')}
        <rect x="${x - step / 2}" y="${top}" width="${step}" height="${plotH}" fill="transparent"/>
        <text class="axis" x="${x}" y="${H - 6}" text-anchor="middle">${d.p.slice(4)}/${d.p.slice(2, 4)}</text></g>`;
    }).join('');
    const grid = ticks.map(t => `<line class="grid-line" x1="${left}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${left - 6}" y="${y(t) + 3}" text-anchor="end">${t}</text>`).join('');
    const table = `<div class="table-wrap" style="display:none;margin-top:8px"><table><tr><th>Período</th><th class="num">Aprobadas</th><th class="num">Pendientes</th><th class="num">Total aprobado (DOP)</th></tr>
      ${data.map(d => `<tr><td>${period(d.p)}</td><td class="num">${int(d.approved)}</td><td class="num">${int(d.pending)}</td><td class="num">${money(d.total)}</td></tr>`).join('')}</table></div>`;
    return { html: `<div class="legend"><span><i style="background:var(--series-1)"></i>Aprobadas</span><span><i style="background:var(--series-2)"></i>Pendientes de aprobar</span>
      <span style="margin-left:auto"><button class="btn sm" data-toggle-table>Ver tabla</button></span></div>
      <div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Comprobantes aprobados y pendientes por período">${grid}${bars}</svg><div class="tip"></div></div>${table}`, data };
  }

  function wireChart(root, data) {
    const chart = root.querySelector('.chart'); if (!chart) return;
    const tip = chart.querySelector('.tip');
    chart.querySelectorAll('g[data-i]').forEach(g => {
      g.addEventListener('mousemove', e => {
        const d = data[Number(g.dataset.i)];
        tip.innerHTML = `<b>${period(d.p)}</b><br>Aprobadas: ${int(d.approved)}<br>Pendientes: ${int(d.pending)}<br>Total aprobado: RD$ ${money(d.total)}`;
        const r = chart.getBoundingClientRect();
        tip.style.display = 'block'; tip.style.left = `${Math.min(e.clientX - r.left + 12, r.width - 170)}px`; tip.style.top = `${e.clientY - r.top - 10}px`;
      });
      g.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    });
    root.querySelector('[data-toggle-table]')?.addEventListener('click', e => {
      const t = root.querySelector('.table-wrap'); const show = t.style.display === 'none';
      t.style.display = show ? 'block' : 'none'; e.target.textContent = show ? 'Ocultar tabla' : 'Ver tabla';
    });
  }

  function wireLinks(root) {
    root.querySelectorAll('[data-href]').forEach(el => el.addEventListener('click', () => NALA.go(el.dataset.href)));
  }

  NALA.views.panel = {
    title: 'Panel de control',
    async render(root) {
      const s = NALA.state;
      const from = shiftPeriod(s.period, -11);
      const [cur, trend] = await Promise.all([
        NALA.api('GET', `stats?${q({ client_id: s.client, period_from: s.period, period_to: s.period, format: s.format })}`),
        NALA.api('GET', `stats?${q({ client_id: s.client, period_from: from, period_to: s.period, format: s.format })}`),
      ]);
      const st = cur.stats;
      const periods = Array.from({ length: 12 }, (_, i) => shiftPeriod(from, i));
      const chart = trendChart(trend.stats.by_period, periods);
      const scopeLabel = s.client ? esc(NALA.clientName(s.client)) : 'todas las empresas (consolidado)';
      const auditBase = `#/auditoria?${q({ client: s.client, period: s.period, format: s.format })}`;
      const byClient = [...(cur.stats.by_client || [])].sort((a, b) => b.pending - a.pending);
      root.innerHTML = `<div class="stack">
        <div class="muted">Período ${period(s.period)} · ${scopeLabel}${s.format ? ` · formato ${s.format}` : ''}</div>
        ${heroResumen(st, auditBase)}
        <div class="grid kpis">
          ${kpi('Comprobantes', int(st.invoices), `${int(st.excluded)} excluidos`, auditBase)}
          ${kpi('Pendientes de aprobar', int(st.pending), `${int(st.reviewed)} revisados`, `${auditBase}&status=pending_review,reviewed`, 'warn')}
          ${kpi('Con errores críticos', `<span style="color:var(--crit)">${int(st.with_errors)}</span>`, `${int(st.duplicates)} duplicados`, `${auditBase}&has=errors`, 'crit')}
          ${kpi('Con advertencias', int(st.with_warnings), `${int(st.foreign_currency)} en moneda extranjera`, `${auditBase}&has=warnings`, 'warn')}
          ${kpi('Aprobados', `<span style="color:var(--ok)">${int(st.approved)}</span>`, 'listos para exportar', `${auditBase}&status=approved`, 'ok')}
          ${kpi('Total aprobado (DOP)', money(st.approved_total_dop), `ITBIS ${money(st.approved_itbis_dop)}`, '', 'accent')}
          ${kpi('Lotes', int(st.batches), `${int(st.batches_active)} en proceso · ${int(st.batches_failed)} fallidos`, '#/lotes')}
          ${kpi('Exportaciones', int(st.exports), `${int(st.exports_submitted)} enviadas · ${int(st.exports_accepted)} aceptadas`, '#/exportar')}
        </div>
        <div class="card"><h2>Comprobantes por período (últimos 12 meses)</h2>${chart.html}</div>
        ${!s.client ? `<div class="card"><h2>Empresas del período</h2>${byClient.length ? `<div class="table-wrap"><table><tr><th>Empresa</th><th class="num">Comprobantes</th><th class="num">Pendientes</th><th class="num">Con errores</th><th class="num">Aprobados</th><th class="num">Total aprobado</th></tr>
          ${byClient.map(c => `<tr class="clickable" data-client="${c.client_id}"><td>${esc(NALA.clientName(c.client_id))}</td><td class="num">${int(c.invoices)}</td><td class="num">${int(c.pending)}</td><td class="num">${c.with_errors ? `<span class="badge crit">${int(c.with_errors)}</span>` : '0'}</td><td class="num">${int(c.approved)}</td><td class="num">${money(c.approved_total_dop)}</td></tr>`).join('')}</table></div>` : '<div class="empty">Sin comprobantes en este período.</div>'}</div>` : ''}
      </div>`;
      wireChart(root, chart.data); wireLinks(root);
      root.querySelectorAll('[data-client]').forEach(tr => tr.addEventListener('click', () => { NALA.setScope({ client: tr.dataset.client }); NALA.go('#/empresa'); }));
    },
  };

  NALA.views.empresa = {
    title: 'Dashboard por empresa',
    async render(root) {
      const s = NALA.state;
      if (!s.client) {
        root.innerHTML = `<div class="card"><h2>Seleccione una empresa</h2><p class="muted" style="margin-bottom:10px">El dashboard por empresa muestra lotes, pendientes, aprobadas, observaciones y exportaciones de una sola empresa cliente.</p>
          <select id="pick" style="min-width:320px">${NALA.clientOptions('', { includeAll: true, allLabel: '— Elegir empresa —' })}</select></div>`;
        root.querySelector('#pick').addEventListener('change', e => e.target.value && NALA.setScope({ client: e.target.value }));
        return;
      }
      const [stats, batches, exports, clientInfo] = await Promise.all([
        NALA.api('GET', `stats?${q({ client_id: s.client, period_from: s.period, period_to: s.period, format: s.format })}`),
        NALA.api('GET', `batches?${q({ client_id: s.client, period: s.period, format: s.format })}`),
        NALA.api('GET', `exports?${q({ client_id: s.client, period: s.period, format: s.format })}`),
        NALA.api('GET', `clients/${s.client}`),
      ]);
      const st = stats.stats; const c = clientInfo.client;
      const auditBase = `#/auditoria?${q({ client: s.client, period: s.period, format: s.format })}`;
      root.innerHTML = `<div class="stack">
        <div class="card"><h2>${esc(c.legal_name)} <span class="badge">${esc(c.rnc || c.cedula || 'sin RNC')}</span>${c.status === 'inactive' ? '<span class="badge crit">Inactiva</span>' : ''}<span class="spacer"></span>
          ${NALA.can('upload') ? '<button class="btn primary" data-href="#/lotes?nuevo=1">+ Nuevo lote</button>' : ''}
          <button class="btn" data-href="${auditBase}">Auditoría unificada</button><button class="btn" data-href="#/exportar">Exportar 606/607</button></h2>
          <div class="muted">Período ${period(s.period)}${s.format ? ` · formato ${s.format}` : ' · 606 y 607'} · Configuración contable: ${c.settings?.default_tipo_bienes_servicios ? `606 tipo ${c.settings.default_tipo_bienes_servicios}` : '606 sin tipo por defecto'}, ${c.settings?.default_tipo_ingreso ? `607 ingreso ${c.settings.default_tipo_ingreso}` : '607 sin tipo por defecto'}</div></div>
        <div class="grid kpis">
          ${kpi('Lotes', int(st.batches), `${int(st.batches_active)} activos · ${int(st.batches_review)} en revisión`)}
          ${kpi('Pendientes', int(st.pending), '', `${auditBase}&status=pending_review,reviewed`)}
          ${kpi('Aprobadas', int(st.approved), `RD$ ${money(st.approved_total_dop)}`, `${auditBase}&status=approved`)}
          ${kpi('Observaciones', `${int(st.with_errors)} / ${int(st.with_warnings)}`, 'errores / advertencias', `${auditBase}&has=errors`)}
          ${kpi('Exportaciones', int(st.exports), `${int(st.exports_generated)} generadas · ${int(st.exports_submitted)} enviadas · ${int(st.exports_accepted)} aceptadas`)}
        </div>
        <div class="grid cols-2">
          <div class="card"><h2>Lotes del período</h2>${batches.batches.length ? `<div class="table-wrap"><table><tr><th>Lote</th><th>Formato</th><th>Estado</th><th class="num">Comprob.</th><th class="num">Aprob.</th><th class="num">Errores</th></tr>
            ${batches.batches.map(b => `<tr class="clickable" data-href="#/lotes/${b.id}"><td>${esc(b.name)}</td><td>${b.format}</td><td>${NALA.badge(b.status)}</td><td class="num">${int(b.summary?.invoices)}</td><td class="num">${int(b.summary?.approved)}</td><td class="num">${int(b.summary?.with_errors)}</td></tr>`).join('')}</table></div>` : '<div class="empty">Sin lotes en este período.</div>'}</div>
          <div class="card"><h2>Exportaciones del período</h2>${exports.exports.length ? `<div class="table-wrap"><table><tr><th>Archivo</th><th>Estado</th><th class="num">Líneas</th><th>Fecha</th></tr>
            ${exports.exports.map(e => `<tr class="clickable" data-href="#/exportar/${e.id}"><td class="mono">${esc(e.file_name)}</td><td>${NALA.badge(e.status)}</td><td class="num">${int(e.line_count)}</td><td>${NALA.dateTime(e.created_at)}</td></tr>`).join('')}</table></div>` : '<div class="empty">Sin exportaciones.</div>'}</div>
        </div></div>`;
      wireLinks(root);
    },
  };
})();
