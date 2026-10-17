/* Asistente de IA reutilizable para los módulos de Direct (no NALA).
   Uso:
     AIAssistant.mount({
       module: 'accesos' | 'nomina' | 'contable',
       title: 'Asistente',
       auth: () => ({ token, sid }),          // credenciales de la sesión Direct
       getContext: () => 'texto corto',       // opcional: datos del módulo
       suggestions: ['¿...?', '¿...?'],        // opcional: atajos
     });
   El servidor (/api/ai/chat) pone la personalidad y la llave; aquí solo va la UI. */
(function () {
  'use strict';
  if (window.AIAssistant) return;

  var CSS = '' +
'.aia-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:54px;height:54px;border-radius:50%;border:none;cursor:pointer;' +
'background:linear-gradient(135deg,#2563eb,#0ea5e9);color:#fff;box-shadow:0 8px 24px rgba(37,99,235,.42);font-size:22px;display:flex;align-items:center;justify-content:center;transition:transform .15s}' +
'.aia-fab:hover{transform:translateY(-2px) scale(1.04)}' +
'.aia-panel{position:fixed;right:18px;bottom:82px;z-index:2147483000;width:min(380px,calc(100vw - 28px));height:min(560px,calc(100vh - 120px));' +
'background:#fff;color:#14203a;border:1px solid #e3e8f0;border-radius:16px;box-shadow:0 18px 50px rgba(15,30,60,.28);display:none;flex-direction:column;overflow:hidden;font-family:inherit}' +
'.aia-panel.open{display:flex}' +
'@media (prefers-color-scheme:dark){.aia-panel{background:#141a27;color:#eef1f7;border-color:#2a3242}}' +
'.aia-head{display:flex;align-items:center;gap:8px;padding:12px 14px;background:linear-gradient(135deg,#2563eb,#0ea5e9);color:#fff;font-weight:700}' +
'.aia-head .aia-x{margin-left:auto;background:rgba(255,255,255,.18);border:none;color:#fff;width:26px;height:26px;border-radius:8px;cursor:pointer;font-size:15px}' +
'.aia-body{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;font-size:13.5px;line-height:1.5}' +
'.aia-msg{max-width:88%;padding:9px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}' +
'.aia-user{align-self:flex-end;background:#2563eb;color:#fff;border-bottom-right-radius:4px}' +
'.aia-bot{align-self:flex-start;background:#eef2f8;color:#14203a;border-bottom-left-radius:4px}' +
'@media (prefers-color-scheme:dark){.aia-bot{background:#222a3a;color:#eef1f7}}' +
'.aia-bot b{font-weight:700}' +
'.aia-note{align-self:center;color:#8a97ab;font-size:11.5px;text-align:center;padding:4px 10px}' +
'.aia-sug{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 6px}' +
'.aia-sug button{font:inherit;font-size:11.5px;border:1px solid #d6deea;background:transparent;color:inherit;border-radius:999px;padding:5px 10px;cursor:pointer}' +
'.aia-sug button:hover{background:rgba(37,99,235,.1);border-color:#2563eb}' +
'.aia-foot{display:flex;gap:8px;padding:10px;border-top:1px solid #e3e8f0}' +
'@media (prefers-color-scheme:dark){.aia-foot{border-color:#2a3242}}' +
'.aia-foot textarea{flex:1;resize:none;height:40px;max-height:120px;border:1px solid #d6deea;border-radius:10px;padding:9px 11px;font:inherit;font-size:13.5px;background:transparent;color:inherit;outline:none}' +
'.aia-foot textarea:focus{border-color:#2563eb}' +
'.aia-send{border:none;background:#2563eb;color:#fff;border-radius:10px;width:42px;cursor:pointer;font-size:16px}' +
'.aia-send:disabled{opacity:.5;cursor:default}' +
'.aia-typing{display:inline-flex;gap:4px}.aia-typing i{width:6px;height:6px;border-radius:50%;background:#9aa6bb;animation:aiaBlink 1s infinite}' +
'.aia-typing i:nth-child(2){animation-delay:.2s}.aia-typing i:nth-child(3){animation-delay:.4s}' +
'@keyframes aiaBlink{0%,60%,100%{opacity:.3}30%{opacity:1}}';

  // Auth por defecto: el token y el id de sesión que la app Direct guarda en el
  // mismo origen (los iframes de los módulos los comparten). Cada módulo puede
  // pasar su propia función auth; si no, se usa esta.
  function defaultAuth() {
    var token = '', sid = '';
    try { token = (window.parent && window.parent.sessionStorage.getItem('dtoken')) || sessionStorage.getItem('dtoken') || ''; } catch (e) { try { token = sessionStorage.getItem('dtoken') || ''; } catch (e2) { token = ''; } }
    try { sid = localStorage.getItem('direct_session_id') || ''; } catch (e) { sid = ''; }
    return { token: token, sid: sid };
  }

  // Contexto por defecto: el texto visible del módulo donde está el usuario
  // (empresa, período, cifras, tablas), para que el asistente responda sobre lo
  // que tiene en pantalla. Recorta y quita el propio panel del asistente.
  function defaultContext() {
    try {
      var el = document.querySelector('main') || document.querySelector('.content,.main,.shell,#content,#view') || document.body;
      var t = (el.innerText || '');
      var cut = t.indexOf('Hola, soy tu asistente'); if (cut >= 0) t = t.slice(0, cut);
      t = t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
      return t.slice(0, 3000);
    } catch (e) { return ''; }
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  // Formato mínimo seguro: escapa y luego permite **negrita** y saltos de línea.
  function fmt(s) { return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>'); }

  function mount(opts) {
    opts = opts || {};
    if (document.getElementById('aia-fab')) return; // una sola instancia por página
    var style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);

    var fab = document.createElement('button');
    fab.id = 'aia-fab'; fab.className = 'aia-fab'; fab.title = opts.title || 'Asistente'; fab.setAttribute('aria-label', opts.title || 'Asistente'); fab.textContent = '✨';
    var panel = document.createElement('div'); panel.className = 'aia-panel';
    var sug = (opts.suggestions || []).map(function (s) { return '<button type="button" data-q="' + esc(s) + '">' + esc(s) + '</button>'; }).join('');
    panel.innerHTML =
      '<div class="aia-head"><span>✨ ' + esc(opts.title || 'Asistente') + '</span><button class="aia-x" aria-label="Cerrar">✕</button></div>' +
      '<div class="aia-body"><div class="aia-note">Hola, soy tu asistente. Puedo orientarte; verifica siempre lo importante con la DGII o tu contador.</div></div>' +
      (sug ? '<div class="aia-sug">' + sug + '</div>' : '') +
      '<div class="aia-foot"><textarea placeholder="Escribe tu pregunta…" rows="1"></textarea><button class="aia-send" aria-label="Enviar">➤</button></div>';
    document.body.appendChild(fab); document.body.appendChild(panel);

    var body = panel.querySelector('.aia-body');
    var ta = panel.querySelector('textarea');
    var sendBtn = panel.querySelector('.aia-send');
    var history = [];
    var busy = false;

    function add(role, html) { var d = document.createElement('div'); d.className = 'aia-msg ' + (role === 'user' ? 'aia-user' : 'aia-bot'); d.innerHTML = html; body.appendChild(d); body.scrollTop = body.scrollHeight; return d; }
    function toggle(open) { panel.classList.toggle('open', open); if (open) setTimeout(function () { ta.focus(); }, 50); }

    fab.addEventListener('click', function () { toggle(!panel.classList.contains('open')); });
    panel.querySelector('.aia-x').addEventListener('click', function () { toggle(false); });
    panel.querySelectorAll('.aia-sug button').forEach(function (b) { b.addEventListener('click', function () { ta.value = b.getAttribute('data-q'); send(); }); });

    async function send() {
      if (busy) return;
      var q = (ta.value || '').trim(); if (!q) return;
      ta.value = ''; busy = true; sendBtn.disabled = true;
      add('user', fmt(q));
      history.push({ role: 'user', content: q });
      var typing = add('bot', '<span class="aia-typing"><i></i><i></i><i></i></span>');
      try {
        var auth = (opts.auth ? opts.auth() : defaultAuth()) || {};
        var headers = { 'Content-Type': 'application/json' };
        if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
        if (auth.sid) headers['X-Direct-Session'] = auth.sid;
        var ctx = ''; try { ctx = (opts.getContext ? opts.getContext() : defaultContext()) || ''; } catch (e) { try { ctx = defaultContext(); } catch (e2) { ctx = ''; } }
        var r = await fetch('/api/ai/chat', { method: 'POST', headers: headers, body: JSON.stringify({ module: opts.module || 'accesos', messages: history.slice(-10), context: ctx }) });
        var data = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(data.error || 'No se pudo responder.');
        typing.innerHTML = fmt(data.reply);
        history.push({ role: 'assistant', content: data.reply });
      } catch (e) {
        typing.innerHTML = esc(e.message || 'Ocurrió un error.');
      } finally {
        busy = false; sendBtn.disabled = false; body.scrollTop = body.scrollHeight;
      }
    }
    sendBtn.addEventListener('click', send);
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  }

  window.AIAssistant = { mount: mount };
})();
