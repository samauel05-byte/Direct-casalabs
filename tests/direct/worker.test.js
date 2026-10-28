// Portal relay (worker.js): DGII navigation must stay inside the proxy so the
// session cookies travel with it. Runs the worker with a fake portal.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PAGE = `<!doctype html><html><head><title>OFV</title></head><body>
<form name="aspnetForm" method="post" action="./Default.aspx?a=1&amp;b=2" id="aspnetForm"></form>
<li onclick='location.href="/OFV/CuestionarioDec/SimuladorImpuestos.aspx"'>Simuladores</li>
<a href="#" onclick="window.location.href = '/OFV/Consulta.aspx'; return false">Consulta</a>
<script>if (location.href == 'x') {} setTimeout(function(){ location.replace("/Ofv/login"); }, 1);</script>
</body></html>`;

let worker, seen;
test.before(async () => {
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url, init = {}) => {
    seen = { url: String(url), headers: init.headers || {} };
    if (/appconfig\.production\.json/.test(url)) return new Response('{"remoteServiceBaseUrl":"https://api.mt.gob.do","appBaseUrl":"https://ovi.mt.gob.do"}', { headers: { 'content-type': 'application/json' } });
    if (/GetPadronElectoral/.test(url)) return new Response('{"error":false}', { headers: { 'content-type': 'application/json', 'set-cookie': 'AspxAutoDetectCookieSupport=1; path=/' } });
    if (/reporte\.aspx/.test(url)) return new Response(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]), { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="r.pdf"' } });
    if (init.headers?.['X-MicrosoftAjax']) return new Response('1|#||4|12|updatePanel|x|', { headers: { 'content-type': 'text/plain; charset=utf-8', 'set-cookie': 'ASP.NET_SessionId=abc; path=/; HttpOnly' } });
    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'ASP.NET_SessionId=abc; domain=.dgii.gov.do; path=/ofv; HttpOnly' } });
  };
  const src = fs.readFileSync(path.join(__dirname, '../../worker.js'), 'utf8');
  worker = (await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))).default;
});

const proxied = (url, init) => worker.fetch(new Request('https://relay.test/proxy?url=' + encodeURIComponent(url) + '&flow=flow123456', init));

test('los menús de DGII (location.href en línea) pasan por el proxy', async () => {
  const html = await (await proxied('https://www.dgii.gov.do/ofv/login.aspx')).text();
  assert.match(html, /onclick='__serpLoc\.href="\/OFV\/CuestionarioDec\/SimuladorImpuestos\.aspx"'/);
  assert.match(html, /onclick="__serpLoc\.href= '\/OFV\/Consulta\.aspx'/);
  assert.match(html, /__serpLoc\.replace\("\/Ofv\/login"\)/);
  assert.match(html, /location\.href == 'x'/, 'las comparaciones no se tocan');
});

test('el script de navegación no se detiene en location.assign (propiedad no redefinible)', async () => {
  const html = await (await proxied('https://www.dgii.gov.do/ofv/login.aspx')).text();
  assert.match(html, /try\{Object\.defineProperty\(window\.location,'assign'/);
  assert.match(html, /HTMLFormElement\.prototype\.submit=function/);
  assert.match(html, /navigation\.addEventListener\('navigate'/);
  assert.ok(html.indexOf('window.__serpLoc=') < html.indexOf('__serpLoc.href="/OFV'), '__serpLoc existe antes de los menús');
});

test('la acción del formulario conserva todos sus parámetros', async () => {
  const html = await (await proxied('https://www.dgii.gov.do/ofv/login.aspx')).text();
  const action = /<form[^>]+action="([^"]+)"/.exec(html)[1];
  const target = new URL(action).searchParams.get('url');
  assert.strictEqual(target, 'https://www.dgii.gov.do/ofv/Default.aspx?a=1&b=2');
});

test('la cookie de sesión queda en el proxy, aislada por flujo', async () => {
  const res = await proxied('https://www.dgii.gov.do/ofv/login.aspx');
  const cookie = res.headers.getSetCookie().find(c => /ASP\.NET_SessionId/.test(c));
  assert.match(cookie, /^serp_flow123456_ASP\.NET_SessionId=abc/);
  assert.doesNotMatch(cookie, /domain=/i);
  assert.match(cookie, /Path=\/$/);
});

test('descargas (PDF) llegan intactas, sin inyectar scripts', async () => {
  const res = await proxied('https://www.dgii.gov.do/ofv/reporte.aspx');
  assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /r\.pdf/);
  assert.deepStrictEqual([...Buffer.from(await res.arrayBuffer())], [0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
});

test('postbacks parciales (UpdatePanel) reciben la respuesta delta de DGII', async () => {
  const res = await proxied('https://www.dgii.gov.do/ofv/Default.aspx', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-MicrosoftAjax': 'Delta=true' }, body: 'a=1' });
  assert.strictEqual(seen.headers['X-MicrosoftAjax'], 'Delta=true');
  assert.strictEqual(await res.text(), '1|#||4|12|updatePanel|x|');
  assert.ok(res.headers.getSetCookie().some(c => /^serp_flow123456_ASP\.NET_SessionId=abc/.test(c)));
});

test('una ventana abierta sin flujo usa la última sesión de ese portal', async () => {
  const first = await proxied('https://www.dgii.gov.do/ofv/login.aspx');
  const remembered = first.headers.getSetCookie().find(c => c.startsWith('serp_lastflow_dgii_gov_do='));
  assert.match(remembered, /^serp_lastflow_dgii_gov_do=flow123456;.*HttpOnly/);
  await worker.fetch(new Request('https://relay.test/proxy?url=' + encodeURIComponent('https://dgii.gov.do/ofv/aviso.aspx'), {
    headers: { Cookie: 'serp_lastflow_dgii_gov_do=flow123456; serp_flow123456_ASP.NET_SessionId=abc; serp_otro999999_ASP.NET_SessionId=zzz' },
  }));
  assert.strictEqual(seen.headers.Cookie, 'ASP.NET_SessionId=abc');
});

test('una pestaña que abre la ruta de datos del relay ve la DGII, no el texto JSON', async () => {
  const nav = await worker.fetch(new Request('https://relay.test/?url=' + encodeURIComponent('https://www.dgii.gov.do/ofv/login.aspx'), { headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'text/html' } }));
  assert.strictEqual(nav.status, 302);
  assert.match(nav.headers.get('location'), /\/proxy\?url=https%3A%2F%2Fwww\.dgii\.gov\.do%2Fofv%2Flogin\.aspx$/);
  // Direct's own background request still receives the form data as JSON.
  const data = await worker.fetch(new Request('https://relay.test/?url=' + encodeURIComponent('https://www.dgii.gov.do/ofv/login.aspx'), { headers: { 'Sec-Fetch-Mode': 'cors', Accept: '*/*' } }));
  assert.match(data.headers.get('content-type'), /json/);
  assert.ok(Array.isArray((await data.json()).hiddenFields));
});

test('los botones <a href="#"> de DGII no recargan la misma página', async () => {
  const html = await (await proxied('https://www.dgii.gov.do/ofv/msgNotificaciones.aspx')).text();
  assert.match(html, /if\(href&&href\.charAt\(0\)==='#'\)\{\s*e\.preventDefault\(\);/);
  assert.match(html, /if\(u\.hash&&u\.href\.split\('#'\)\[0\]===here\.href\.split\('#'\)\[0\]\)\{e\.preventDefault\(\);return;\}/);
});

test('Ministerio de Trabajo (OVI): la app carga por el relay y se queda en él', async () => {
  const html = await (await worker.fetch(new Request('https://relay.test/proxy?url=' + encodeURIComponent('https://ovi.mt.gob.do/account/login')))).text();
  assert.match(html, /<base href="https:\/\/portal-rd-relay\.samauel05\.workers\.dev\/r\/ovi\.mt\.gob\.do\/">/);
  assert.match(html, /Object\.setPrototypeOf\(XHRProxy,_X\)/, 'XMLHttpRequest.DONE sigue existiendo');
  assert.match(html, /a\[1\]=p\|\|u;\s*return _o\.apply\(null,a\);/, 'no convierte las peticiones en sincrónicas');
  const cfg = await (await worker.fetch(new Request('https://relay.test/r/ovi.mt.gob.do/assets/appconfig.production.json'))).json();
  assert.strictEqual(cfg.appBaseUrl, 'https://portal-rd-relay.samauel05.workers.dev/r/ovi.mt.gob.do');
  assert.strictEqual(cfg.remoteServiceBaseUrl, 'https://api.mt.gob.do');
  const nav = await worker.fetch(new Request('https://relay.test/r/ovi.mt.gob.do/app/main', { headers: { 'Sec-Fetch-Dest': 'document' } }));
  assert.strictEqual(nav.status, 302);
  assert.match(nav.headers.get('location'), /\/proxy\?url=https%3A%2F%2Fovi\.mt\.gob\.do%2Fapp%2Fmain$/);
});

test('las consultas en segundo plano de un portal (Cámara: Buscar cédula) usan la sesión del flujo', async () => {
  const html = await (await proxied('https://www.camarasantodomingo.do/solicitudes/FormularioWeb/')).text();
  assert.match(html, /function apiHref\(u\)/);
  assert.match(html, /XMLHttpRequest\.prototype\.open=function/);
  const res = await worker.fetch(new Request('https://relay.test/api-proxy?url=' + encodeURIComponent('https://www.camarasantodomingo.do/solicitudes/FormularioWeb/Solicitud/GetPadronElectoral?documento=1') + '&flow=flow123456', { headers: { Cookie: 'serp_flow123456_ASP.NET_SessionId=s1; serp_otroflujo_ASP.NET_SessionId=s2; otra=x' } }));
  assert.strictEqual(seen.headers.Cookie, 'ASP.NET_SessionId=s1', 'solo las cookies de este flujo, sin el prefijo');
  assert.deepStrictEqual(await res.json(), { error: false });
  assert.match(res.headers.getSetCookie()[0], /^serp_flow123456_AspxAutoDetectCookieSupport=1;/);
});

test('al enviar un formulario, el portal recibe como Referer la página real (Cardnet ReturnUrl)', async () => {
  const page = 'https://www.cardnet.com.do/capp2/Account/Login?ReturnUrl=%2Fcapp2%2FReport';
  await worker.fetch(new Request('https://relay.test/proxy?url=' + encodeURIComponent('https://www.cardnet.com.do/capp2/Account/Login') + '&flow=flow123456', {
    method: 'POST', body: 'Email=a&Password=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://relay.test/proxy?url=' + encodeURIComponent(page) + '&flow=flow123456' },
  }));
  assert.strictEqual(seen.headers.Referer, page);
});

test('en los demás portales el robot envía el inicio de sesión una sola vez', async () => {
  const html = await (await proxied('https://www.cardnet.com.do/capp2/Account/Login')).text();
  assert.match(html, /var onceKey = 'serp-login-submitted-' \+ \(p\.flow \|\| hash\);/);
  assert.match(html, /if \(sessionStorage\.getItem\(onceKey\) === '1'\) return;/);
});

test('las consultas de la página llevan X-Requested-With y la página real como Referer (Azul: Localidad)', async () => {
  const html = await (await proxied('https://portal.azul.com.do/Statements')).text();
  assert.match(html, /_xh\.call\(this,'X-Requested-With','XMLHttpRequest'\)/);
  const page = 'https://portal.azul.com.do/Statements';
  await worker.fetch(new Request('https://relay.test/api-proxy?url=' + encodeURIComponent('https://portal.azul.com.do/Ajax/LocationsAutoComplete?_=1') + '&flow=flow123456', { headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://relay.test/proxy?url=' + encodeURIComponent(page) + '&flow=flow123456' } }));
  assert.strictEqual(seen.headers.Referer, page);
  assert.strictEqual(seen.headers['x-requested-with'], 'XMLHttpRequest');
  assert.ok(!('Origin' in seen.headers), 'un GET del mismo sitio no lleva Origin');
});

test('Trabajo (OVI): cada empresa tiene su propia sesión (cookies por flujo), no reusa la primera', async () => {
  // La página SPA inyecta el flujo en las peticiones a /api-proxy, para que
  // una segunda empresa no herede la sesión de la primera.
  const html = await (await worker.fetch(new Request('https://relay.test/proxy?url=' + encodeURIComponent('https://ovi.mt.gob.do/account/login') + '&flow=flow123456'))).text();
  assert.match(html, /var F='flow123456';/);
  assert.match(html, /var FQ=F\?'&flow='\+encodeURIComponent\(F\):'';/);
  assert.match(html, /\/api-proxy\?url='\+encodeURIComponent\(O\+s\)\+FQ/, 'las peticiones de la SPA llevan el flujo');
  // La cookie de sesión de OVI se guarda con el prefijo del flujo.
  const res = await worker.fetch(new Request('https://relay.test/api-proxy?url=' + encodeURIComponent('https://api.mt.gob.do/auth/login') + '&flow=flow123456', {
    method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
  }));
  assert.ok(res.headers.getSetCookie().some(c => /^serp_flow123456_/.test(c)), 'la sesión de OVI queda separada por empresa');
});

test('Trabajo (OVI): el aviso "Portal no disponible" no tapa la app después de entrar', async () => {
  const html = await (await worker.fetch(new Request('https://relay.test/proxy?url=' + encodeURIComponent('https://ovi.mt.gob.do/account/login')))).text();
  assert.match(html, /!document\.querySelector\('input,button,a\[href\]'\)&&shown\.length<40/);
});

test('los formularios GET y los cambios de pantalla sin recarga siguen por el relay (Azul: Localidad)', async () => {
  const html = await (await proxied('https://portal.azul.com.do/Statements')).text();
  assert.match(html, /function formPortalUrl\(form,submitter\)/);
  assert.match(html, /window\.addEventListener\('submit',function\(e\)\{\s*var form=e\.target;\s*if\(e\.defaultPrevented/);
  assert.match(html, /\['pushState','replaceState'\]\.forEach/);
});

test('el relay avisa a Direct el resultado del inicio de sesión (postMessage)', async () => {
  const html = await (await proxied('https://www.dgii.gov.do/ofv/login.aspx')).text();
  assert.match(html, /serp-login-result/);
  assert.match(html, /window\.opener\.postMessage/);
  assert.match(html, /p\.origin/);
});

test('DGII con Token Digital: el robot calcula el código y no envía la pantalla sin él', async () => {
  const html = await (await proxied('https://www.dgii.gov.do/ofv/login.aspx')).text();
  assert.match(html, /function tokenInput\(\)/);
  assert.match(html, /serp-dgii-token-submit-/);
  assert.match(html, /hasSubmittedDgiiFirstPage\(\)\) \{\s*if \(hasSubmittedDgiiToken\(\)\) return;/);
  assert.match(html, /async function totpCode\(raw\)/);
  // sin clave del token se deja el cursor en la casilla y no se envía
  assert.match(html, /if\(!p\.totp\)\{ try \{ tokEl\.focus\(\); \}/);
  // la tarjeta de códigos no se escribe en la casilla del token
  assert.match(html, /if\(cfg && cfg\.tarjeta && !tokEl\)/);
});
