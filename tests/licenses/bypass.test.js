// Quién puede entrar aunque la licencia de su firma esté suspendida o vencida (sin base de datos: Supabase simulado).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');

function load(row, failColumn) {
  const stub = { from: () => ({ select: cols => ({ eq: () => ({ maybeSingle: async () => (failColumn && /keeps_access/.test(cols) ? { data: null, error: { message: 'column does not exist' } } : { data: row, error: null }) }) }) }) };
  require.cache[require.resolve('../../lib/supabase')] = { id: 's', filename: 's', loaded: true, exports: stub };
  delete require.cache[require.resolve('../../lib/licenses')];
  return require('../../lib/licenses');
}

test('bypassesLicense: root y quien tenga keeps_access_when_suspended entran; el resto no; sin la columna cae a is_platform_admin', async () => {
  assert.equal(await load({ is_platform_admin: true, keeps_access_when_suspended: false }).bypassesLicense('u'), true);       // root
  assert.equal(await load({ is_platform_admin: false, keeps_access_when_suspended: true }).bypassesLicense('u'), true);        // quien opera Cobros
  assert.equal(await load({ is_platform_admin: false, keeps_access_when_suspended: false }).bypassesLicense('u'), false);      // usuario normal: se bloquea
  assert.equal(await load(null).bypassesLicense('u'), false);
  assert.equal(await load({ is_platform_admin: true }, true).bypassesLicense('u'), true);                                      // BD sin migrar: root sigue entrando
  assert.equal(await load({ is_platform_admin: false }, true).bypassesLicense('u'), false);
  // una firma suspendida sigue bloqueando por estado de licencia (el bypass solo decide quién entra)
  const L = load({}); assert.equal(L.stateOf({ license_status: 'suspended' }).blocked, true);
});

test('el bloqueo de licencia en el login y en la autenticación usa bypassesLicense, y no cambia los privilegios de administración', () => {
  assert.match(read('lib/auth.js'), /blocked && !\(await bypassesLicense\(user\.id\)\)/);
  assert.match(read('api/auth/login.js'), /license\.blocked && !platformAdmin && !\(await L\.bypassesLicense\(user\.id\)\)/);
  assert.match(read('api/licenses.js'), /isPlatformAdmin\(session\.userId\)/);                  // el panel de licencias sigue exigiendo ser administrador de la plataforma
  assert.match(read('supabase/migrations/202611270001_mantener_acceso_si_suspendida.sql'), /keeps_access_when_suspended boolean not null default false/);
});
