// Puente con el shell de Direct para los módulos que corren en su propia pestaña
// (window.open desde Direct) o, como respaldo, dentro de un iframe.
window.serpHost = function () {
  try {
    if (window.parent !== window) return window.parent;
    if (window.opener && !window.opener.closed) { void window.opener.location.origin; return window.opener; }
  } catch (_) { /* aislado */ }
  return null;
};
// Volver a Accesos: en pestaña propia enfoca la de Direct y cierra esta.
window.serpBack = function () {
  const h = window.serpHost();
  if (window.parent !== window) { try { h.postMessage({ action: 'showPortals' }, location.origin); } catch (_) { /* sin shell */ } return; }
  try { if (h) h.focus(); } catch (_) { /* sin foco */ }
  window.close();
  setTimeout(() => { if (!window.closed) location.href = '/'; }, 300);
};

// Tema: en pestaña propia no hay shell que ponga data-theme, así que se toma de la
// misma preferencia de Direct (localStorage direct_theme) y se mantiene sincronizado.
(function () {
  if (window.parent !== window) return;
  function apply() {
    var p = 'light';
    try { p = localStorage.getItem('direct_theme') || 'light'; } catch (_) { /* sin storage */ }
    var t = p === 'light' || p === 'dark' ? p
      : ((window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark'
        : (function (h) { return (h >= 19 || h < 7) ? 'dark' : 'light'; })(new Date().getHours()));
    document.documentElement.setAttribute('data-theme', t);
  }
  apply();
  window.addEventListener('storage', function (e) { if (e.key === 'direct_theme') apply(); });
})();
