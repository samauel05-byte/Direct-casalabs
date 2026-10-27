/* CAMI · Análisis de ITBIS guardados.
   · Borrador automático: cada cambio (archivos 606/607, tarjetas, balance IR-2, datos digitados) se guarda
     solo en el servidor; al volver a abrir CAMI se recupera donde se quedó.
   · Copias guardadas: «Guardar» deja una copia con nombre que todo el equipo puede abrir, modificar,
     duplicar, renombrar o borrar desde «Mis análisis».
   Los datos viajan comprimidos (gzip + base64) a /api/ir2/resumen?tipo=cami-analisis, aislado por empresa
   contable (tenant). Usa la misma sesión de Direct que la pestaña que abrió CAMI. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const AN = { id: null, nombre: '', draftId: null, ready: false, restoring: false, timer: null, saving: false, pending: false, last: null, state: 'idle', defaults: {}, cardHtml: {} };

  /* ── Sesión (igual que NALA: token de la pestaña de Direct que abrió CAMI) ── */
  function host() { try { const o = window.opener; if (o && !o.closed && o.location.origin === location.origin) return o; } catch (_) { /* aislado */ } return null; }
  function authHeaders() {
    const h = {}; let token = '', sid = '';
    try { token = window.__serpToken || sessionStorage.getItem('dtoken') || (host() || window).sessionStorage.getItem('dtoken') || ''; } catch (_) { /* sin storage */ }
    try { sid = localStorage.getItem('direct_session_id') || ''; } catch (_) { /* sin storage */ }
    if (token) h.Authorization = 'Bearer ' + token;
    if (sid) h['X-Direct-Session'] = sid;
    return h;
  }
  async function api(method, query, body, retried) {
    const qs = new URLSearchParams({ tipo: 'cami-analisis', ...query });
    const res = await fetch('/api/ir2/resumen?' + qs, { method, headers: { ...authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && !retried) { // token vencido mientras se trabajaba: pedirle a Direct que lo renueve y reintentar una vez
        let r = null; try { const h = host(); r = h && h.directRefresh ? await h.directRefresh() : null; } catch (_) { /* aislado */ }
        if (r) return api(method, query, body, true);
        // Sin la pestaña que abrió CAMI (cerrada o con otra sesión): se le pide el token a cualquier pestaña de Direct abierta.
        try { const tok = window.serpRequestToken ? await window.serpRequestToken() : null; if (tok) return api(method, query, body, true); } catch (_) { /* sin respuesta */ }
      }
      const e = new Error(j.error || ('Error ' + res.status)); e.status = res.status; throw e;
    }
    return j;
  }

  /* ── Compresión ── */
  async function pack(obj) {
    const json = JSON.stringify(obj);
    if (typeof CompressionStream === 'undefined') return { v: 1, raw: json };
    const buf = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { v: 1, gz: btoa(bin) };
  }
  async function unpack(d) {
    if (d && d.gz) {
      const bin = atob(d.gz); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return JSON.parse(await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
    }
    if (d && d.raw) return JSON.parse(d.raw);
    return null;
  }

  /* ── Captura / restauración del estado de la pantalla ── */
  const skipInput = el => el.type === 'file' || el.id === 'currency-select' || el.id.indexOf('an-') === 0;
  function readInputs() {
    const o = {};
    document.querySelectorAll('input[id],select[id],textarea[id]').forEach(el => { if (skipInput(el)) return; o[el.id] = (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value; });
    return o;
  }
  const isEmpty = () => !STATE['606'] && !STATE['607'] && !CARD_STATE.cardnet && !CARD_STATE.azul && !IR2_STATE;
  function capture() {
    return {
      v: 1, STATE: { '606': STATE['606'], '607': STATE['607'] }, CARD_STATE: { cardnet: CARD_STATE.cardnet, azul: CARD_STATE.azul }, IR2_STATE,
      names: { '606': $('tf-606').textContent, '607': $('tf-607').textContent, cardnet: $('cardnet-file').textContent, azul: $('azul-file').textContent, ir2: $('tf-ir2').textContent },
      inputs: readInputs(), currency: DISPLAY_CURRENCY, copyId: AN.id, copyName: AN.nombre, at: Date.now(),
    };
  }
  function metaOf(snap) {
    const i = snap.inputs || {}; const rnc = (i['in-rnc'] || i['ir2-rnc'] || '').trim(); const periodo = (i['in-periodo'] || '').trim();
    const razon = (i['in-razon'] || i['ir2-razon'] || '').trim();
    const s6 = snap.STATE['606'] && snap.STATE['606'].summary, s7 = snap.STATE['607'] && snap.STATE['607'].summary;
    const resumen = {};
    if (s6) resumen.r606 = { n: s6.registros, itbis: s6.totItbis, ret: s6.totRet };
    if (s7) resumen.r607 = { n: s7.registros, total: s7.totTotal, itbis: s7.totItbis };
    const cards = []; if (snap.CARD_STATE.cardnet) cards.push('CardNET'); if (snap.CARD_STATE.azul) cards.push('Azul'); if (cards.length) resumen.tarjetas = cards;
    if (snap.IR2_STATE) resumen.ir2 = true;
    const sugerido = [razon, periodo].filter(Boolean).join(' · ') || (snap.names['606'] && snap.names['606'] !== 'Archivo 606' ? snap.names['606'] : '') || 'Análisis de ITBIS';
    return { rnc, periodo, razon, resumen, sugerido };
  }
  function clearAll() {
    if (STATE['606']) resetMod('606'); if (STATE['607']) resetMod('607');
    if (IR2_STATE) resetIR2();
    ['cardnet', 'azul'].forEach(id => { CARD_STATE[id] = null; $(id + '-file').textContent = 'Pendiente'; $(id + '-file').title = ''; if (AN.cardHtml[id]) $('kpis-' + id).innerHTML = AN.cardHtml[id]; });
    renderCardTotal();
    for (const [id, v] of Object.entries(AN.defaults)) { const el = $(id); if (!el) continue; if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!v; else el.value = v; }
  }
  function restore(snap) {
    AN.restoring = true;
    try {
      clearAll();
      for (const [id, v] of Object.entries(snap.inputs || {})) { const el = $(id); if (!el || skipInput(el)) continue; if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!v; else el.value = v; }
      if (snap.currency && CURRENCIES[snap.currency] && snap.currency !== DISPLAY_CURRENCY) { DISPLAY_CURRENCY = snap.currency; $('currency-select').value = snap.currency; }
      const n = snap.names || {}, S = snap.STATE || {}, C = snap.CARD_STATE || {};
      if (S['606']) { STATE['606'] = S['606']; render606(STATE['606'], n['606'] || 'Archivo 606'); }
      if (S['607']) { STATE['607'] = S['607']; render607(STATE['607'], n['607'] || 'Archivo 607'); }
      if (C.cardnet) { CARD_STATE.cardnet = C.cardnet; renderCardReport('CardNET', CARD_STATE.cardnet, n.cardnet || 'Reporte CardNET'); }
      if (C.azul) { CARD_STATE.azul = C.azul; renderCardReport('Azul', CARD_STATE.azul, n.azul || 'Reporte Azul'); }
      if (snap.IR2_STATE) {
        IR2_STATE = snap.IR2_STATE; $('up-ir2').hidden = true; $('tf-ir2').hidden = false; $('tf-ir2').textContent = n.ir2 || 'Balance IR-2';
        $('btn-xls-ir2').hidden = false; $('btn-rst-ir2').hidden = false; updateIR2();
      }
      renderCardTotal(); renderSalesConsolidated(); updateIT1();
      AN.id = snap.copyId || null; AN.nombre = snap.copyName || '';
    } finally { AN.restoring = false; }
    refreshUI();
  }

  /* ── Borrador automático ── */
  function schedule() {
    if (!AN.ready || AN.restoring) return;
    clearTimeout(AN.timer); AN.timer = setTimeout(saveDraft, 1800); setState('dirty');
  }
  async function saveDraft() {
    clearTimeout(AN.timer); AN.timer = null;
    if (!AN.ready || AN.restoring || isEmpty()) return;
    if (AN.saving) { AN.pending = true; return; }
    AN.saving = true; setState('saving');
    try {
      const snap = capture(), m = metaOf(snap);
      const r = await api('POST', {}, { borrador: true, nombre: 'Borrador automático', rnc: m.rnc, periodo: m.periodo, resumen: m.resumen, data: await pack(snap) });
      AN.draftId = r.id || AN.draftId; AN.last = new Date(); setState('ok');
    } catch (e) { setState('err', e); }
    finally { AN.saving = false; if (AN.pending) { AN.pending = false; schedule(); } }
  }

  /* ── Interfaz ── */
  function setState(s, e) { AN.state = s; AN.err = e || null; refreshUI(); }
  const hora = d => d ? d.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' }) : '';
  function refreshUI() {
    const n = $('an-name'), st = $('an-status'); if (!n || !st) return;
    n.textContent = AN.id ? AN.nombre : 'Análisis sin guardar'; n.title = AN.id ? 'Copia guardada abierta' : 'Pulsa «Guardar» para dejar una copia con nombre';
    const msg = {
      idle: isEmpty() ? 'Carga tus archivos: se guarda solo.' : '',
      dirty: 'Guardando en unos segundos…', saving: 'Guardando…',
      ok: '✓ Borrador guardado ' + hora(AN.last),
      err: AN.err && (AN.err.status === 401 || AN.err.status === 403)
        ? '⚠ Sesión de Direct vencida o cerrada. Toca aquí para reintentar; si sigue igual, abre CAMI desde Direct.' : '⚠ No se pudo guardar' + (AN.err && AN.err.message ? ' (' + AN.err.message + ')' : '') + '. Se reintenta con el próximo cambio.',
    }[AN.state] || '';
    st.textContent = msg; st.className = 'an-status' + (AN.state === 'err' ? ' err' : AN.state === 'ok' ? ' ok' : '');
    // Con error de sesión se puede reintentar con un clic (pide el token a Direct y vuelve a guardar).
    st.style.cursor = AN.state === 'err' ? 'pointer' : '';
    st.onclick = AN.state === 'err' ? async () => { st.textContent = 'Reconectando con Direct…'; try { if (window.serpRequestToken) await window.serpRequestToken(); } catch (_) { /* sin respuesta */ } saveDraft(); } : null;
  }
  function css() {
    const s = document.createElement('style');
    s.textContent = `.an-box{margin:10px 12px;padding:11px 12px;border-radius:10px;background:rgba(255,255,255,.07);color:var(--sid-text-bright,#C9D8EF);font-size:12px}
.an-ttl{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;opacity:.7}
.an-name{font-weight:600;margin:3px 0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.an-status{font-size:11px;opacity:.8;min-height:14px;line-height:1.35}.an-status.ok{color:#6EE7B7}.an-status.err{color:#FCA5A5;opacity:1}
.an-btns{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}.an-btns button{flex:1;min-width:64px;border:0;border-radius:7px;padding:6px 8px;font:600 11px Inter,sans-serif;cursor:pointer;background:rgba(255,255,255,.14);color:inherit}
.an-btns button.pri{background:var(--blue,#3B5BDB);color:#fff}.an-btns button:hover{filter:brightness(1.12)}
.an-bg{position:fixed;inset:0;background:rgba(14,27,54,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px}
.an-modal{background:var(--surface,#fff);color:var(--text,#1E1810);border-radius:14px;width:min(860px,100%);max-height:88vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.35)}
.an-modal h3{margin:0;padding:16px 18px 10px;font-size:16px}.an-body{padding:0 18px 12px;overflow:auto;font-size:13px}.an-ftr{padding:12px 18px 16px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.an-modal input[type=text]{width:100%;padding:9px 11px;border:1.5px solid var(--border,#E7DED0);border-radius:8px;font:inherit;background:var(--bg,#fff);color:inherit;box-sizing:border-box}
.an-g .an-row{display:grid;grid-template-columns:minmax(140px,1.5fr) minmax(110px,1fr) minmax(110px,1.2fr) 104px 178px;gap:0 10px;align-items:start;border-bottom:1px solid var(--border,#E7DED0)}
.an-gh{font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--muted,#6A5C4B);padding:6px 4px}
.an-gc{padding:9px 4px;overflow-wrap:anywhere}.an-acc{display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap}
@media(max-width:760px){.an-g .an-row{grid-template-columns:1fr}.an-gh{display:none}.an-acc{justify-content:flex-start}}
.an-sm{border:1.5px solid var(--border,#E7DED0);background:transparent;color:inherit;border-radius:7px;padding:4px 9px;font:600 11px Inter,sans-serif;cursor:pointer}.an-sm.pri{background:var(--blue,#3B5BDB);color:#fff;border-color:var(--blue,#3B5BDB)}.an-sm.del{color:var(--red,#DC2626)}
.an-muted{color:var(--muted,#6A5C4B);font-size:12px}`;
    document.head.appendChild(s);
  }
  function modal(title, bodyHtml, buttons) {
    const bg = document.createElement('div'); bg.className = 'an-bg';
    bg.innerHTML = `<div class="an-modal" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><div class="an-body">${bodyHtml}</div><div class="an-ftr"></div></div>`;
    const ftr = bg.querySelector('.an-ftr');
    const close = () => bg.remove();
    for (const b of buttons) { const el = document.createElement('button'); el.className = 'an-sm' + (b.pri ? ' pri' : ''); el.textContent = b.label; el.onclick = () => b.run ? b.run(bg, close) : close(); ftr.appendChild(el); }
    bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
    document.body.appendChild(bg); return { bg, close };
  }
  const toast = (m, t) => { try { showToast(m, t); } catch (_) { alert(m); } };

  async function guardar() {
    if (isEmpty()) { toast('Primero carga al menos un archivo para guardar el análisis.', 'err'); return; }
    const snap = capture(), m = metaOf(snap);
    const nombre = AN.id ? AN.nombre : m.sugerido;
    const m1 = modal('Guardar análisis', `<p class="an-muted" style="margin-top:0">La copia queda guardada para todo el equipo: se puede abrir y modificar después desde «Mis análisis».</p><label class="an-muted">Nombre</label><input type="text" id="an-in-nombre" maxlength="160" value="${esc(nombre)}">${AN.id ? '<p class="an-muted">Estás editando una copia ya guardada: puedes actualizarla o guardar una nueva.</p>' : ''}`, [
      { label: 'Cancelar' },
      ...(AN.id ? [{ label: 'Guardar como copia nueva', run: (bg, close) => persist(bg, close, false) }] : []),
      { label: AN.id ? 'Actualizar esta copia' : 'Guardar', pri: true, run: (bg, close) => persist(bg, close, !!AN.id) },
    ]);
    setTimeout(() => { const i = $('an-in-nombre'); if (i) { i.focus(); i.select(); } }, 30);
    async function persist(bg, close, update) {
      const name = ($('an-in-nombre').value || '').trim(); if (!name) { $('an-in-nombre').focus(); return; }
      try {
        const s2 = capture(), m2 = metaOf(s2);
        const body = { nombre: name, rnc: m2.rnc, periodo: m2.periodo, resumen: m2.resumen };
        let r;
        if (update) { s2.copyId = AN.id; s2.copyName = name; r = await api('POST', {}, { ...body, id: AN.id, data: await pack(s2) }); }
        else { r = await api('POST', {}, { ...body, data: await pack(s2) }); AN.id = r.id; }
        AN.nombre = name; close(); toast('Análisis guardado: ' + name, 'ok'); saveDraft(); refreshUI();
      } catch (e) { toast('No se pudo guardar: ' + e.message, 'err'); }
    }
  }

  const fmtFecha = iso => { try { return new Date(iso).toLocaleString('es-DO', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } };
  const fmtRes = r => { r = r || {}; const p = []; if (r.r606) p.push('606: ' + r.r606.n + ' reg.'); if (r.r607) p.push('607: ' + r.r607.n + ' reg.'); if (r.tarjetas) p.push(r.tarjetas.join(' + ')); if (r.ir2) p.push('IR-2'); return p.join(' · ') || '—'; };

  async function lista() {
    const m = modal('Mis análisis', '<p class="an-muted">Cargando…</p>', [{ label: 'Cerrar' }]);
    async function pinta() {
      let r; try { r = await api('GET', {}); } catch (e) { m.bg.querySelector('.an-body').innerHTML = `<p class="an-muted">No se pudo cargar la lista: ${esc(e.message)}</p>`; return; }
      const rows = r.items || [];
      m.bg.querySelector('.an-body').innerHTML = rows.length ? `<div class="an-g"><div class="an-row"><div class="an-gh">Nombre</div><div class="an-gh">RNC / período</div><div class="an-gh">Contenido</div><div class="an-gh">Actualizado</div><div class="an-gh"></div></div>${rows.map(x => `<div class="an-row"><div class="an-gc"><b>${esc(x.nombre)}</b>${x.id === AN.id ? ' <span class="an-muted">(abierto)</span>' : ''}${x.mio ? '' : ' <span class="an-muted">· de otro usuario</span>'}</div><div class="an-gc">${esc([x.rnc, x.periodo].filter(Boolean).join(' · ') || '—')}</div><div class="an-gc an-muted">${esc(fmtRes(x.resumen))}</div><div class="an-gc an-muted">${esc(fmtFecha(x.updated_at))}</div><div class="an-gc"><div class="an-acc" data-id="${esc(x.id)}"><button class="an-sm pri" data-a="open">Abrir</button><button class="an-sm" data-a="dup">Duplicar</button><button class="an-sm" data-a="ren">Renombrar</button><button class="an-sm del" data-a="del">Borrar</button></div></div></div>`).join('')}</div>` : '<p class="an-muted">Todavía no hay análisis guardados. Carga tus archivos y pulsa «Guardar».</p>';
      m.bg.querySelectorAll('button[data-a]').forEach(b => b.onclick = () => { const id = b.closest('.an-acc').dataset.id; accion(b.dataset.a, id, rows.find(z => z.id === id), m, pinta); });
    }
    pinta();
  }
  async function accion(a, id, item, m, repinta) {
    try {
      if (a === 'open') {
        if (!isEmpty() && !confirm('Se reemplaza el trabajo que tienes en pantalla por «' + item.nombre + '». Si lo quieres conservar, guárdalo antes. ¿Abrir?')) return;
        const r = await api('GET', { id }); const snap = await unpack(r.record.data);
        if (!snap) throw new Error('El análisis está vacío o dañado.');
        snap.copyId = r.record.id; snap.copyName = r.record.nombre; restore(snap); m.close(); toast('Abierto: ' + r.record.nombre, 'ok'); saveDraft();
      } else if (a === 'dup') {
        const r = await api('GET', { id });
        await api('POST', {}, { nombre: ('Copia de ' + r.record.nombre).slice(0, 160), rnc: r.record.rnc, periodo: r.record.periodo, resumen: r.record.resumen, data: r.record.data });
        toast('Copia creada', 'ok'); repinta();
      } else if (a === 'ren') {
        const nombre = prompt('Nuevo nombre del análisis:', item.nombre); if (!nombre || !nombre.trim()) return;
        await api('POST', {}, { id, nombre: nombre.trim() }); if (id === AN.id) { AN.nombre = nombre.trim(); refreshUI(); } repinta();
      } else if (a === 'del') {
        if (!confirm('¿Borrar «' + item.nombre + '»? No se puede deshacer.')) return;
        await api('DELETE', { id }); if (id === AN.id) { AN.id = null; AN.nombre = ''; refreshUI(); } repinta();
      }
    } catch (e) { toast(e.message, 'err'); }
  }
  async function nuevo() {
    if (!isEmpty() && !confirm('Se limpia la pantalla para empezar un análisis nuevo. Si quieres conservar el actual, guárdalo antes. ¿Empezar de cero?')) return;
    AN.restoring = true; try { clearAll(); AN.id = null; AN.nombre = ''; } finally { AN.restoring = false; }
    clearTimeout(AN.timer); AN.timer = null;
    if (AN.draftId) { try { await api('DELETE', { id: AN.draftId }); AN.draftId = null; } catch (_) { /* se sobrescribe después */ } }
    AN.last = null; setState('idle');
  }

  function buildUI() {
    css();
    const box = document.createElement('div'); box.className = 'an-box'; box.id = 'an-box';
    box.innerHTML = '<div class="an-ttl">Análisis</div><div class="an-name" id="an-name"></div><div class="an-status" id="an-status"></div><div class="an-btns"><button class="pri" id="an-save" title="Guardar una copia con nombre">Guardar</button><button id="an-list" title="Abrir, duplicar o borrar análisis guardados">Mis análisis</button><button id="an-new" title="Limpiar la pantalla">Nuevo</button></div>';
    const anchor = document.querySelector('.currency-box'); if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor); else document.body.appendChild(box);
    $('an-save').onclick = guardar; $('an-list').onclick = lista; $('an-new').onclick = nuevo; refreshUI();
  }

  async function init() {
    AN.defaults = readInputs();
    ['cardnet', 'azul'].forEach(id => { const el = $('kpis-' + id); if (el) AN.cardHtml[id] = el.innerHTML; });
    buildUI();
    // engancha los puntos donde cambia el trabajo (sin tocar la lógica existente)
    ['handleFile', 'handleCardFile', 'handleIR2File', 'resetMod', 'resetIR2'].forEach(name => {
      const f = window[name]; if (typeof f !== 'function') return;
      window[name] = function () { const was = AN.restoring; const r = f.apply(this, arguments); if (!was) Promise.resolve(r).then(schedule, schedule); return r; };
    });
    const onEdit = e => { const el = e.target; if (el && el.id && !skipInput(el)) schedule(); };
    document.addEventListener('input', onEdit, true); document.addEventListener('change', onEdit, true);
    document.addEventListener('visibilitychange', () => { if (document.hidden && AN.timer) saveDraft(); });
    window.addEventListener('beforeunload', e => { if (AN.timer || AN.saving) { e.preventDefault(); e.returnValue = ''; } });
    try {
      const r = await api('GET', { borrador: '1' });
      if (r.record) {
        AN.draftId = r.record.id;
        const snap = await unpack(r.record.data);
        if (snap) { restore(snap); AN.last = new Date(r.record.updated_at); setState('ok'); toast('Se recuperó tu análisis anterior. Usa «Nuevo» para empezar de cero.', 'ok'); }
      }
    } catch (e) { setState('err', e); }
    AN.ready = true; refreshUI();
  }
  window.CAMI_ANALISIS = { capture, restore, pack, unpack, metaOf, _AN: AN };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
