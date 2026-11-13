/* Direct — tutoriales guiados: uno para el inicio y uno por cada módulo (NALA, CAMI, Nómina, Estados Financieros,
   IR-2, Estimación Fiscal, Conciliación, Monitor DGII y Clientes). Cada uno se muestra UNA vez por persona (en ese
   equipo) la primera vez que abre esa pantalla y se repite con el botón «?» de su cabecera.
   Los pasos se arman con lo que la persona realmente ve (módulos, permisos, menú o botón ☰ en celular). */
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const visible = el => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]'); };
  // Quién es: en Direct viene de currentUser; en las pestañas de módulos, de la sesión copiada o de la pestaña que las abrió.
  const who = () => {
    try { if (typeof currentUser !== 'undefined' && currentUser) return currentUser; } catch (_) { /* sin sesión */ }
    try { const s = JSON.parse(sessionStorage.getItem('dsession') || 'null'); if (s) return s; } catch (_) { /* sin sesión */ }
    try { if (window.opener && window.opener.currentUser) return window.opener.currentUser; } catch (_) { /* aislado */ }
    return {};
  };
  const KEY = (id, u) => `direct_tour_v1:${String(u || 'anon').toLowerCase()}${id === 'home' ? '' : ':' + id}`;
  const first = sel => (Array.isArray(sel) ? sel : [sel]).map(s => (typeof s === 'function' ? s() : document.querySelector(s))).find(visible) || null;
  let state = null;

  // ── Definiciones ─────────────────────────────────────────────────────────
  const TOURS = {};
  const MODULE_HELP = {
    NALA: 'sube tus facturas (fotos o PDF) y Direct las lee para armar los reportes 606 y 607', CAMI: 'analiza los reportes 606/607 y prepara el IT-1 y el IR-2',
    'Nómina': 'nómina por empresa: empleados, columnas y períodos', 'Estados Financieros': 'estados proyectados, interinos y del año para Contabilidad',
    'IR-2': 'declaración jurada de renta', 'Estimación Fiscal': 'anexos de la DGII: gastos NCF, inmuebles, retenciones, vehículos',
    'Conciliación bancaria': 'compara el extracto del banco con tu libro auxiliar', Clientes: 'las empresas que atiendes y sus datos',
    'Monitor DGII': 'te dice si los servicios de facturación electrónica de la DGII están disponibles',
  };
  const end = txt => ({ title: '¡Listo!', html: `<p>${txt}</p><p>Puedes repetir este recorrido cuando quieras con el botón <b>?</b> de la cabecera.</p>` });

  TOURS.home = () => {
    const u = who();
    const groups = [...document.querySelectorAll('#home-groups .sect-label')].reduce((acc, label) => { const g = label.nextElementSibling; acc[label.textContent.trim()] = g ? [...g.querySelectorAll('.p-name')].map(n => n.textContent.trim()) : []; return acc; }, {});
    const tools = groups['Herramientas contables'] || [];
    const gov = [...document.querySelectorAll('#home-groups .sect-label')].find(l => /gubernamentales/i.test(l.textContent));
    const toolsLabel = [...document.querySelectorAll('#home-groups .sect-label')].find(l => /herramientas/i.test(l.textContent));
    const steps = [
      { title: `¡Bienvenido${u.username ? `, ${esc(u.username)}` : ''}!`, html: '<p><b>Direct</b> es tu punto de entrada a los portales del gobierno y a las herramientas contables de la firma.</p><p>Te muestro lo básico en menos de un minuto. Puedes salir cuando quieras con <b>Omitir</b> y volver a verlo con el botón <b>?</b> de arriba.</p>' },
      { target: '#home-search', title: 'Busca una empresa', html: '<p>Escribe el nombre de una empresa y verás <b>todos los portales donde tiene acceso</b>. Un clic y entras directo, sin copiar usuario ni contraseña.</p>' },
    ];
    if (gov && gov.nextElementSibling) steps.push({ target: () => gov.nextElementSibling.querySelector('.p-card') || gov.nextElementSibling, title: 'Portales', html: '<p>Cada tarjeta es un portal (DGII, TSS, Ministerio de Trabajo…). Al tocarla, <b>Direct inicia sesión por ti</b> con las claves guardadas de esa empresa. No necesitas instalar nada en el navegador.</p><p class="dt-note">Tus claves viajan cifradas y solo se abren con tu contraseña de Direct.</p>' });
    if (tools.length) steps.push({ target: () => toolsLabel?.nextElementSibling, title: 'Herramientas contables', html: `<p>Aquí están los módulos que tienes activados. <b>Cada uno tiene su propio tutorial</b>: se muestra la primera vez que lo abres y lo repites con el botón <b>?</b>.</p><ul class="dt-list">${tools.map(t => `<li><b>${esc(t)}</b>${MODULE_HELP[t] ? ` — ${esc(MODULE_HELP[t])}` : ''}</li>`).join('')}</ul><p class="dt-note">Si te falta alguno, pídele al administrador que lo active en tu usuario.</p>` });
    steps.push(
      { target: '#view-portals .theme-btn', title: 'Fondo claro u oscuro', html: '<p>Cambia la apariencia a tu gusto, o déjala en automático para que siga la de tu teléfono o computadora.</p>' },
      { target: '#aia-fab', title: 'Asistente', html: '<p>El botón <b>✨</b> abre el asistente: pregúntale qué portal usar, cómo declarar algo o cómo funciona un módulo.</p>' },
      { target: '#view-portals .sync-pill', title: 'Estado de la conexión', html: '<p>Si el punto está verde, todo está sincronizado. Si pierdes internet te lo avisa aquí.</p>' });
    if (u.role === 'admin') steps.push({ target: '#btn-users', title: 'Usuarios (administrador)', html: '<p>Desde aquí creas personas, eliges a qué <b>portales, módulos y empresas</b> tiene acceso cada una y restableces contraseñas.</p>' });
    steps.push({ target: '#view-portals button[title="Cerrar sesión"]', title: 'Cerrar sesión', html: '<p>Cuando termines, cierra sesión con el candado. <b>No compartas tu usuario</b>: Direct permite una sola sesión activa por persona y deja registro de cada entrada.</p>' },
      end('Ya conoces lo básico. Entra siempre desde Direct para que tus accesos queden registrados y cifrados.'));
    return steps;
  };

  TOURS.nala = () => {
    const navBtn = key => () => document.querySelector(`#nav [data-nav="${key}"]`);
    const menu = '#menu-btn'; // en celular el menú está detrás de ☰
    const mob = ' <span class="dt-note">(En el celular está en el menú ☰.)</span>';
    return [
      { title: 'NALA: de la factura al 606 y 607', html: '<p>NALA lee tus facturas con inteligencia artificial y arma los reportes para la DGII.</p><ol class="dt-list"><li><b>Cargar</b> las facturas (fotos, PDF o ZIP).</li><li><b>Auditar</b>: revisar y corregir lo que el bot leyó.</li><li><b>Aprobar</b> lo que está bien.</li><li><b>Exportar</b> el archivo 606 o 607.</li></ol>' },
      { target: ['#scope-client', '#filters-btn'], title: 'Empresa y período', html: '<p>Arriba eliges la <b>empresa activa</b>, el <b>período</b> (mes) y el formato (606 compras o 607 ventas). Todo lo que ves se filtra con eso.</p><p class="dt-note">En el celular están detrás del botón «⚙ Filtros».</p>' },
      { target: [navBtn('panel'), menu], title: 'Panel de control', html: `<p>Resumen de cómo va el mes: cuántos comprobantes hay, cuáles faltan por aprobar y qué exportaciones se han hecho.${mob}</p>` },
      { target: [navBtn('lotes'), menu], title: 'Carga masiva y lotes', html: `<p>Aquí subes las facturas: arrastra fotos, PDF o un ZIP y NALA las procesa en segundo plano (puedes seguir trabajando). Cada carga es un <b>lote</b>.</p><p>También puedes subir un <b>Excel</b>: el IR-17 / compras B11 al 606, o las ventas al 607 (botones «+ B11» y «+ Ventas (Excel)» dentro del lote).${mob}</p>` },
      { target: [navBtn('auditoria'), menu], title: 'Auditoría fiscal', html: `<p>Aquí revisas lo que el bot leyó. Un <b>✓ verde</b> significa sin observaciones; ❗ o ⚠ son errores o avisos. Con <b>✎ Corregir</b> arreglas sin salir de la lista; con el <b>NCF</b> abres la factura original.</p><p>Toca una fila para <b>sombrearla</b> y ver la suma de las sombreadas. Cuando todo esté bien, <b>aprueba</b>.${mob}</p>` },
      { target: [navBtn('exportar'), menu], title: 'Exportar 606/607', html: `<p>Genera el archivo que se sube a la DGII con las facturas <b>aprobadas</b>. Si la DGII devuelve errores, pégalos en «Errores de la DGII» y NALA te lleva a las facturas que hay que corregir.${mob}</p>` },
      { target: [navBtn('clientes'), menu], title: 'Empresas clientes', html: `<p>Las empresas con las que trabajas. Puedes registrarlas a mano o desde la Consulta RNC.${mob}</p>` },
      { target: [navBtn('rnc'), menu], title: 'Consulta RNC', html: `<p>Escribe un RNC o cédula y NALA lo valida con la DGII. Si la empresa ya está en NALA te dice <b>quién la trabaja</b>; si no está, puedes registrarla ahí mismo.${mob}</p>` },
      { target: [navBtn('equipo'), navBtn('config')], title: 'Administración', html: '<p>Si tienes permiso: <b>Equipo y oficiales</b> (quién trabaja qué empresa y qué puede hacer cada quien) y <b>Configuración</b> (valores por omisión y retención de archivos).</p>' },
      end('Tip: empieza siempre eligiendo la empresa y el período arriba; luego Cargar → Auditar → Aprobar → Exportar.'),
    ];
  };

  TOURS.cami = () => [
    { title: 'CAMI: análisis de 606, 607 e IT-1', html: '<p>CAMI toma tus reportes de compras y ventas del período y te muestra el análisis fiscal: ITBIS, retenciones, crédito fiscal, y prepara el <b>IT-1</b> y el <b>IR-2</b>.</p>' },
    { target: '.nav-item[data-nav="606"]', title: '606 — Compras', html: '<p>Carga el archivo de <b>compras</b> del mes (PDF, CSV o Excel; plantilla de la DGII o tu propio Excel). Verás el resumen por tipo de gasto, ITBIS y retenciones.</p>' },
    { target: '.nav-item[data-nav="607"]', title: '607 — Ventas', html: '<p>Lo mismo con las <b>ventas</b>. Si el contador ya aprobó las facturas en NALA, puedes traerlas directo desde ahí.</p>' },
    { target: ['#dz-606', '.dropzone'], title: 'Subir el archivo', html: '<p>Arrastra el archivo aquí o toca <b>Seleccionar archivo</b>. Al terminar aparece <b>Exportar Excel</b> para bajar el análisis.</p>' },
    { target: '.nav-item[data-nav="it1"]', title: 'IT-1 y IR-2', html: '<p>Con el 606 y el 607 cargados, CAMI calcula la <b>declaración del IT-1</b> (ITBIS) y alimenta el <b>IR-2</b>. Revisa los montos antes de usarlos.</p>' },
    { target: '#currency-select', title: 'Moneda del reporte', html: '<p>Cambia el símbolo de la moneda en pantalla. <b>No convierte los montos.</b></p>' },
    end('Si algo no cuadra con la DGII, revisa primero el período y el archivo cargado.'),
  ];

  TOURS.nomina = () => [
    { title: 'Nómina por empresa', html: '<p>Cada empresa tiene sus propios <b>empleados, conceptos (columnas), ajustes de ley y períodos de nómina</b>. El orden recomendado es el de los pasos que siguen.</p>' },
    { target: '#curco', title: 'Empresa activa', html: '<p>Elige aquí con qué empresa trabajas o crea una nueva. Todo lo que ves depende de esta empresa.</p>' },
    { target: '#tabs [data-tab="empresas"]', title: '1 · Empresas', html: '<p>Crea la empresa y elige con cuál trabajar.</p>' },
    { target: '#tabs [data-tab="ajustes"]', title: '2 · Ajustes', html: '<p>Define el <b>tipo de período</b> (quincenal, mensual…) y los porcentajes de <b>TSS e ISR</b> que usa la empresa.</p>' },
    { target: '#tabs [data-tab="columnas"]', title: '3 · Columnas', html: '<p>Los conceptos de la planilla: sueldo, descuentos, horas extra, bonos… Puedes agregar los que necesites y definir fórmulas.</p>' },
    { target: '#tabs [data-tab="empleados"]', title: '4 · Empleados', html: '<p>Fichas de empleados (cédula, puesto, sueldo, TSS) y su expediente. Aquí también registras salidas y prestaciones.</p>' },
    { target: '#tabs [data-tab="nomina"]', title: '5 · Nómina', html: '<p>Captura y calcula la nómina del período: sueldo, descuentos, TSS, ISR y neto por empleado. Luego la exportas.</p>' },
    { target: '#tabs [data-tab="panel"]', title: 'Panel', html: '<p>Resumen de todas tus empresas y el <b>calendario de la quincena</b> para que no se te pase ninguna.</p>' },
    end('Si es tu primera vez: crea la empresa, revisa Ajustes, define Columnas y carga Empleados antes de capturar la nómina.'),
  ];

  TOURS.estados = () => [
    { title: 'Estados Financieros', html: '<p>Módulo de Contabilidad con tres modalidades: <b>Proyectados</b> (a futuro, con supuestos), <b>Interinos</b> (real, hasta una fecha de corte) y <b>Del año</b> (año fiscal terminado).</p><p>Direct <b>no inventa cifras</b>: si falta información, el informe queda <b>incompleto</b> y no se puede aprobar.</p>' },
    { target: ['#nav [data-nav="m/proyectado"]', '#menu-btn'], title: 'Proyectados', html: '<p>Prepara escenarios futuros con supuestos y valores estimados. Direct muestra lo que cargas con la etiqueta PROYECTADO; <b>no calcula proyecciones</b> hasta que Contabilidad defina las fórmulas.</p>' },
    { target: ['#nav [data-nav="m/interino"]', '#menu-btn'], title: 'Interinos', html: '<p>Informe con información real hasta una fecha de corte. Carga el libro o auxiliar desde Excel/CSV y verás hasta qué fecha llega.</p>' },
    { target: ['#nav [data-nav="m/anual"]', '#menu-btn'], title: 'Del año', html: '<p>Informe de un año fiscal terminado: registros, ajustes y asientos de cierre.</p>' },
    { target: ['#nav [data-nav="plantillas"]', '#menu-btn'], title: 'Plantillas y pendientes', html: '<p>Descarga la plantilla de carga de cada modalidad y mira <b>qué falta que Contabilidad entregue</b>. Al cargar un archivo puedes asociar tus columnas a las de Direct.</p>' },
    { target: ['#scope-client', '#filters-btn'], title: 'Filtro por empresa', html: '<p>Filtra las listas por empresa. En el celular está detrás de «⚙ Filtros».</p>' },
    { target: ['#nav [data-nav="config"]', '#nav [data-nav="equipo"]'], title: 'Administración', html: '<p>Contabilidad ajusta aquí los estados del flujo, la regla de cuadre y los documentos de cada modalidad; el administrador asigna roles y empresas en «Equipo y permisos».</p>' },
    end('Flujo de cada informe: crear → cargar datos → revisar pendientes → en revisión → aprobado → cerrado. Todo queda en el historial.'),
  ];

  TOURS.ir2 = () => [
    { title: 'IR-2: declaración jurada de renta', html: '<p>Arma la declaración de <b>personas jurídicas</b> paso a paso. Avanza por las pestañas de izquierda a derecha; <b>todo se guarda solo</b>.</p>' },
    { target: '#tabs .tab:nth-child(1)', title: '1 · Empresa', html: '<p>Datos del contribuyente (razón social, RNC, año fiscal, tipo de declaración) y del representante legal.</p>' },
    { target: '#tabs .tab:nth-child(2)', title: '2 · Balance de comprobación', html: '<p>Carga o pega el balance de comprobación ajustado del período.</p>' },
    { target: '#tabs .tab:nth-child(3)', title: '3 · Estado de resultados', html: '<p>Ingresos y gastos del año, tomados del balance.</p>' },
    { target: '#tabs .tab:nth-child(4)', title: '4 · Conciliación fiscal', html: '<p>Ajustes entre lo contable y lo fiscal (gastos no admitidos, diferencias, etc.).</p>' },
    { target: '#tabs .tab:nth-child(5)', title: '5 · Cálculo del IR-2', html: '<p>Renta neta imponible, impuesto, anticipos y saldos.</p>' },
    { target: '#tabs .tab:nth-child(7)', title: 'Formulario IR-2', html: '<p>El formulario con los casilleros listos para revisar. En «Reporte final» tienes el resumen para imprimir.</p>' },
    { target: '#save-badge', title: 'Guardado automático', html: '<p>Verás «✓ Guardado» cada vez que se guarda. No necesitas un botón de guardar.</p>' },
    { target: 'a[href="/ir2/resumen.html"]', title: 'Datos DGII', html: '<p>Trae el resumen de datos fiscales de la empresa para no digitar dos veces.</p>' },
    end('Revisa siempre el formulario final antes de presentarlo; imprime con el botón <b>Imprimir</b>.'),
  ];

  TOURS.dgii = () => [
    { title: 'Estimación Fiscal (anexos de la DGII)', html: '<p>Prepara los anexos de la DGII por empresa y año: gastos con NCF, inmuebles, retenciones, vehículos, envíos del 606 y pagos de importación.</p>' },
    { target: '#co-select', title: 'Empresa', html: '<p>Elige la empresa. Si la tiene NALA, puedes traer su 606/607 <b>aprobado</b> para llenar los gastos.</p>' },
    { target: '#anio-sel', title: 'Año', html: '<p>El año fiscal que estás preparando.</p>' },
    { target: '.tabs .tab:nth-child(1)', title: 'Gastos NCF', html: '<p>Resumen de gastos por tipo. Puedes importar el Excel del IR-2 o agregar tipos a mano.</p>' },
    { target: '.tabs .tab:nth-child(2)', title: 'Inmuebles, retenciones y vehículos', html: '<p>Las demás pestañas (Inmuebles, Retenciones Adquirencia, Vehículos) son los anexos que se llenan según el caso de la empresa.</p>' },
    { target: '.tabs .tab:nth-child(5)', title: 'Consulta de envíos 606 y DGA', html: '<p>Para consultar lo que se ha enviado del 606 y los pagos de importación (DGA).</p>' },
    { target: '.btn-save', title: 'Guardar y exportar', html: '<p><b>Guardar</b> conserva el trabajo de esa empresa y año. <b>Exportar Excel</b> baja todas las pestañas (una hoja por pestaña).</p>' },
    end('Guarda antes de cambiar de empresa o de año.'),
  ];

  TOURS.conciliacion = () => [
    { title: 'Conciliación bancaria', html: '<p>Compara el <b>extracto del banco</b> con tu <b>libro auxiliar</b> y te dice qué cuadra, qué es dudoso y qué tiene diferencia.</p>' },
    { target: '#drop-bank', title: '1 · Extracto del banco', html: '<p>Haz clic o arrastra el archivo del banco (Excel, CSV o PDF según el banco).</p>' },
    { target: '#drop-book', title: '2 · Libro auxiliar', html: '<p>El Excel contable del mismo período. Verás una vista previa y podrás ajustar qué columna es fecha, monto, etc.</p>' },
    { target: '#tol', title: 'Tolerancia de fecha', html: '<p>Cuántos días de diferencia se aceptan entre el banco y el libro para dar un movimiento por conciliado.</p>' },
    end('El resultado separa conciliados, dudosos y diferencias; puedes confirmar los dudosos y descargar todo en Excel.'),
  ];

  TOURS.monitor = () => [
    { title: 'Monitor DGII', html: '<p>Te dice si los servicios de <b>facturación electrónica (e-CF)</b> de la DGII están disponibles, antes de que pierdas tiempo intentando enviar.</p>' },
    { target: '#mon-state', title: 'Estado general', html: '<p>Verde: todo operativo. Ámbar o rojo: hay degradación o caída.</p>' },
    { target: '#tabs .tab:nth-child(1)', title: 'Resumen', html: '<p>Disponibilidad actual por servicio y ambiente (producción, certificación…).</p>' },
    { target: '#tabs .tab:nth-child(2)', title: 'Incidentes', html: '<p>Historial de caídas: cuándo empezaron, cuánto duraron y cuándo se recuperaron.</p>' },
    { target: '#tabs .tab:nth-child(3)', title: 'Verificaciones', html: '<p>Cada comprobación que se hizo, con su resultado.</p>' },
    end('El monitor es independiente de Direct: refleja las comprobaciones indicadas y no garantiza el funcionamiento de todos los servicios de la DGII.'),
  ];

  TOURS.clients = () => [
    { title: 'Clientes', html: '<p>Aquí viven las <b>empresas que atiende tu firma</b>. Son las mismas que usan NALA, Estados Financieros y los demás módulos.</p>' },
    { target: '#clients-count', title: 'Cuántos tienes', html: '<p>El total de clientes de tu empresa contable.</p>' },
    { target: '#view-clients .client-toolbar button', title: 'Agregar clientes', html: '<p>Crea un cliente nuevo o impórtalos desde Excel. Cada empleado ve solo las empresas que el administrador le asignó.</p>' },
    { target: '#view-clients .client-list', title: 'Tus clientes', html: '<p>Toca uno para ver y editar sus datos.</p>' },
    end('Mantén los RNC correctos: los módulos usan esos datos para validar y exportar.'),
  ];

  // ── Motor ────────────────────────────────────────────────────────────────
  function close(markDone) {
    if (!state) return;
    document.removeEventListener('keydown', state.onKey);
    window.removeEventListener('resize', state.onResize);
    state.root.remove();
    if (markDone) { try { localStorage.setItem(KEY(state.id, who().username), String(Date.now())); } catch (_) { /* sin storage */ } }
    state = null;
  }

  function place() {
    const s = state; const step = s.steps[s.i];
    const spot = s.root.querySelector('.dt-spot'); const card = s.root.querySelector('.dt-card');
    const target = step.target ? first(step.target) : null;
    const mobile = window.innerWidth < 640;
    card.removeAttribute('style');
    card.classList.toggle('dt-sheet', mobile);
    if (target) target.scrollIntoView({ block: mobile ? 'start' : 'center', behavior: 'auto' });
    // En celular la hoja va abajo, salvo que el elemento resaltado quede en la mitad de abajo (por ejemplo el botón ✨).
    card.classList.remove('dt-top');
    if (mobile && target && target.getBoundingClientRect().top > window.innerHeight * 0.45) card.classList.add('dt-top');
    if (target) {
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

  function go(d) { if (!state) return; const n = state.i + d; if (n < 0) return; if (n >= state.steps.length) { close(true); return; } state.i = n; render(); }

  // Luminosidad del fondo de la página: decide si la tarjeta del tutorial es clara u oscura (cada módulo tiene su propio tema).
  function pageIsDark() {
    const parse = c => (c.match(/[\d.]+/g) || []).slice(0, 4).map(Number);
    for (const el of [document.body, document.documentElement]) { const [r, g, b, a = 1] = parse(getComputedStyle(el).backgroundColor); if (a > 0.1 && r !== undefined) return (0.299 * r + 0.587 * g + 0.114 * b) < 140; }
    return document.documentElement.getAttribute('data-theme') !== 'light';
  }

  function start(id, { force = false } = {}) {
    if (state || !TOURS[id]) return false;
    if (!force) { try { if (localStorage.getItem(KEY(id, who().username))) return false; } catch (_) { /* sin storage */ } }
    const steps = TOURS[id]().filter(s => !s.target || first(s.target));
    if (steps.length < 3) return false;
    const root = document.createElement('div'); root.className = 'dt-root'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Tutorial');
    root.setAttribute('data-dt', pageIsDark() ? 'dark' : 'light');
    root.innerHTML = '<div class="dt-shade"></div><div class="dt-spot"></div><div class="dt-card"></div>';
    document.body.appendChild(root);
    state = { id, steps, i: 0, root, onResize: () => place(), onKey: e => { if (e.key === 'Escape') close(true); else if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1); } };
    root.addEventListener('click', e => { const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'next') go(1); else if (a === 'prev') go(-1); else if (a === 'skip') close(true); });
    document.addEventListener('keydown', state.onKey); window.addEventListener('resize', state.onResize);
    try { window.trackUsage?.('feature', `tour:${id}`); } catch (_) { /* sin seguimiento */ }
    render();
    return true;
  }

  // Primera vez: espera a que la pantalla termine de cargar (hasta ~10 s) y arranca solo si esta persona aún no lo vio.
  function auto(id, { delay = 900, ready } = {}) {
    let tries = 0;
    const tick = () => {
      try {
        const ok = ready ? !!first(ready) : true;
        if (ok || tries > 33) { if (ok) start(id); return; }
      } catch (_) { return; }
      tries++; setTimeout(tick, 300);
    };
    setTimeout(tick, delay);
  }
  const seen = id => { try { return !!localStorage.getItem(KEY(id, who().username)); } catch (_) { return false; } };

  // Botón «?» estándar para las cabeceras de los módulos.
  function button(id, { className = 'dt-help', title = 'Ver el tutorial de este módulo' } = {}) {
    const b = document.createElement('button'); b.type = 'button'; b.className = className; b.id = `btn-tour-${id}`; b.title = title; b.setAttribute('aria-label', title); b.textContent = '?';
    b.addEventListener('click', () => start(id, { force: true }));
    return b;
  }

  window.DirectTour = { start: id => start(id || 'home', { force: true }), maybeStart: () => auto('home', { ready: '#home-search' }), auto, button, seen, tours: Object.keys(TOURS), _TOURS: TOURS };
})();
