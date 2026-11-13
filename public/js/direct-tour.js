/* Direct — tutorial guiado para quien entra por primera vez.
   Se muestra solo una vez por persona (en ese equipo) y se puede repetir con el botón «?» de la cabecera.
   Los pasos se arman según lo que la persona realmente ve (módulos, botones de administrador). */
(function () {
  const KEY = u => `direct_tour_v1:${String(u || 'anon').toLowerCase()}`;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const visible = el => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]'); };
  const me = () => (typeof currentUser !== 'undefined' && currentUser) || {};
  let state = null;

  function toolNames() {
    return [...document.querySelectorAll('#home-groups .sect-label')].reduce((acc, label) => {
      const grid = label.nextElementSibling;
      acc[label.textContent.trim()] = grid ? [...grid.querySelectorAll('.p-name')].map(n => n.textContent.trim()) : [];
      return acc;
    }, {});
  }

  const MODULE_HELP = {
    NALA: 'sube tus facturas (fotos o PDF) y Direct las lee para armar los reportes 606 y 607',
    CAMI: 'analiza los reportes 606/607 y prepara el IT-1 y el IR-2',
    'Nómina': 'nómina por empresa: empleados, columnas y períodos',
    'Estados Financieros': 'estados proyectados, interinos y del año para Contabilidad',
    'IR-2': 'declaración jurada de renta',
    'Estimación Fiscal': 'anexos de la DGII: gastos NCF, inmuebles, retenciones, vehículos',
    'Conciliación bancaria': 'compara el extracto del banco con tu libro auxiliar',
    Clientes: 'las empresas que atiendes y sus datos',
    'Monitor DGII': 'te dice si los servicios de facturación electrónica de la DGII están disponibles',
  };

  function buildSteps() {
    const u = me(); const groups = toolNames();
    const tools = groups['Herramientas contables'] || [];
    const steps = [];
    steps.push({ title: `¡Bienvenido${u.username ? `, ${esc(u.username)}` : ''}!`, html: '<p><b>Direct</b> es tu punto de entrada a los portales del gobierno y a las herramientas contables de la firma.</p><p>Te muestro lo básico en menos de un minuto. Puedes salir cuando quieras con <b>Omitir</b> y volver a verlo con el botón <b>?</b> de arriba.</p>' });
    steps.push({ target: '#home-search', title: 'Busca una empresa', html: '<p>Escribe el nombre de una empresa y verás <b>todos los portales donde tiene acceso</b>. Un clic y entras directo, sin copiar usuario ni contraseña.</p>' });
    const gov = [...document.querySelectorAll('#home-groups .sect-label')].find(l => /gubernamentales/i.test(l.textContent));
    if (gov && gov.nextElementSibling) steps.push({ target: () => gov.nextElementSibling.querySelector('.p-card') || gov.nextElementSibling, title: 'Portales', html: '<p>Cada tarjeta es un portal (DGII, TSS, Ministerio de Trabajo…). Al tocarla, <b>Direct inicia sesión por ti</b> con las claves guardadas de esa empresa. No necesitas instalar nada en el navegador.</p><p class="dt-note">Tus claves viajan cifradas y solo se abren con tu contraseña de Direct.</p>' });
    if (tools.length) {
      const toolsLabel = [...document.querySelectorAll('#home-groups .sect-label')].find(l => /herramientas/i.test(l.textContent));
      steps.push({ target: () => toolsLabel?.nextElementSibling, title: 'Herramientas contables', html: `<p>Aquí están los módulos que tienes activados:</p><ul class="dt-list">${tools.map(t => `<li><b>${esc(t)}</b>${MODULE_HELP[t] ? ` — ${esc(MODULE_HELP[t])}` : ''}</li>`).join('')}</ul><p class="dt-note">Si te falta alguno, pídele al administrador que lo active en tu usuario.</p>` });
    }
    steps.push({ target: '#view-portals .theme-btn', title: 'Fondo claro u oscuro', html: '<p>Cambia la apariencia a tu gusto, o déjala en automático para que siga la de tu teléfono o computadora.</p>' });
    steps.push({ target: '#aia-fab', title: 'Asistente', html: '<p>El botón <b>✨</b> abre el asistente: pregúntale qué portal usar, cómo declarar algo o cómo funciona un módulo.</p>' });
    steps.push({ target: '#view-portals .sync-pill', title: 'Estado de la conexión', html: '<p>Si dice <b>En línea</b>, todo está sincronizado. Si pierdes internet te lo avisa aquí.</p>' });
    if (u.role === 'admin') steps.push({ target: '#btn-users', title: 'Usuarios (administrador)', html: '<p>Desde aquí creas personas, eliges a qué <b>portales, módulos y empresas</b> tiene acceso cada una y restableces contraseñas.</p>' });
    steps.push({ target: '#view-portals button[title="Cerrar sesión"]', title: 'Cerrar sesión', html: '<p>Cuando termines, cierra sesión con el candado. <b>No compartas tu usuario</b>: Direct permite una sola sesión activa por persona y deja registro de cada entrada.</p>' });
    steps.push({ title: '¡Listo!', html: '<p>Ya conoces lo básico. Un último consejo: entra siempre desde Direct para que tus accesos queden registrados y cifrados.</p><p>¿Dudas? Usa el asistente ✨ o el botón <b>?</b> de la cabecera para repetir este recorrido.</p>' });
    return steps.filter(s => !s.target || visible(typeof s.target === 'function' ? s.target() : document.querySelector(s.target)));
  }

  function close(markDone) {
    if (!state) return;
    document.removeEventListener('keydown', state.onKey);
    window.removeEventListener('resize', state.onResize);
    state.root.remove();
    if (markDone) { try { localStorage.setItem(KEY(me().username), String(Date.now())); } catch (_) { /* sin storage */ } }
    state = null;
  }

  function place() {
    const s = state; const step = s.steps[s.i];
    const spot = s.root.querySelector('.dt-spot'); const card = s.root.querySelector('.dt-card');
    const target = step.target ? (typeof step.target === 'function' ? step.target() : document.querySelector(step.target)) : null;
    const mobile = window.innerWidth < 640;
    card.removeAttribute('style');
    card.classList.toggle('dt-sheet', mobile);
    const showTarget = target && visible(target);
    if (showTarget) target.scrollIntoView({ block: mobile ? 'start' : 'center', behavior: 'auto' });
    // En celular la hoja va abajo, salvo que el elemento resaltado quede en la mitad de abajo (por ejemplo el botón ✨): entonces va arriba.
    card.classList.remove('dt-top');
    if (mobile && showTarget && target.getBoundingClientRect().top > window.innerHeight * 0.45) card.classList.add('dt-top');
    if (showTarget) {
      const r = target.getBoundingClientRect(); const pad = 6;
      Object.assign(spot.style, { display: 'block', top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
      if (!mobile) {
        const cw = Math.min(360, window.innerWidth - 24); card.style.width = `${cw}px`;
        const below = window.innerHeight - r.bottom; const ch = card.offsetHeight;
        card.style.top = `${below > ch + 24 ? r.bottom + 14 : Math.max(12, r.top - ch - 14)}px`;
        card.style.left = `${Math.max(12, Math.min(window.innerWidth - cw - 12, r.left + r.width / 2 - cw / 2))}px`;
      }
    } else {
      spot.style.display = 'none';
      if (!mobile) { card.style.width = `${Math.min(420, window.innerWidth - 24)}px`; card.style.top = '50%'; card.style.left = '50%'; card.style.transform = 'translate(-50%,-50%)'; }
    }
  }

  function render() {
    const s = state; const step = s.steps[s.i]; const last = s.i === s.steps.length - 1;
    const card = s.root.querySelector('.dt-card');
    card.innerHTML = `<div class="dt-step">${s.i + 1} de ${s.steps.length}</div><h3>${step.title}</h3><div class="dt-body">${step.html}</div>
      <div class="dt-dots">${s.steps.map((_, k) => `<i class="${k === s.i ? 'on' : ''}"></i>`).join('')}</div>
      <div class="dt-actions"><button type="button" class="dt-skip" data-a="skip">${last ? '' : 'Omitir'}</button><span style="flex:1"></span>
        ${s.i > 0 ? '<button type="button" class="dt-btn" data-a="prev">Anterior</button>' : ''}<button type="button" class="dt-btn dt-primary" data-a="next">${last ? 'Entendido' : 'Siguiente'}</button></div>`;
    place();
    card.querySelector('[data-a="next"]').focus({ preventScroll: true });
  }

  function start({ force = false } = {}) {
    if (state) return;
    if (!force) { try { if (localStorage.getItem(KEY(me().username))) return; } catch (_) { /* sin storage */ } }
    const steps = buildSteps();
    if (steps.length < 3) return;
    const root = document.createElement('div'); root.className = 'dt-root'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Tutorial de Direct');
    root.innerHTML = '<div class="dt-shade"></div><div class="dt-spot"></div><div class="dt-card"></div>';
    document.body.appendChild(root);
    state = { steps, i: 0, root, onResize: () => place(), onKey: e => { if (e.key === 'Escape') close(true); else if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1); } };
    root.addEventListener('click', e => { const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'next') go(1); else if (a === 'prev') go(-1); else if (a === 'skip') close(true); });
    document.addEventListener('keydown', state.onKey); window.addEventListener('resize', state.onResize);
    try { window.trackUsage?.('feature', 'tour'); } catch (_) { /* sin seguimiento */ }
    render();
  }
  function go(d) { if (!state) return; const n = state.i + d; if (n < 0) return; if (n >= state.steps.length) { close(true); return; } state.i = n; render(); }

  // Llamado al mostrar los accesos: espera a que el tablero termine de pintarse.
  function maybeStart() { setTimeout(() => { try { if (document.getElementById('view-portals')?.hidden === false) start(); } catch (_) { /* nunca debe romper Direct */ } }, 900); }

  window.DirectTour = { start: () => start({ force: true }), maybeStart, _buildSteps: buildSteps };
})();
