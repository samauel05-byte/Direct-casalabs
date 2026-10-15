// End-to-end API test of the NALA fiscal flow on the local stack (real routes,
// SQL, RPCs, storage emulation and job queue). Run: npm run test:nala
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { Client } = require('pg');
const { startStack } = require('./support/stack');
const { render, inv } = require('./support/fixtures');
const formats = require('../../lib/nala/formats');

process.env.NALA_RETRY_BASE_SECONDS = '1';
const CLIENT_UNO = '00000000-0000-0000-0000-0000000c0001';
const CLIENT_DOS = '00000000-0000-0000-0000-0000000c0002';
const OTHER_TENANT_CLIENT = '00000000-0000-0000-0000-0000000c00e1';
let stack; let db; let dir;
const sessions = {};

async function login(username, password) {
  const r = await fetch(`${stack.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const data = await r.json();
  assert.equal(r.status, 200, data.error);
  sessions[username] = { authorization: `Bearer ${data.access_token}`, 'x-direct-session': data.session_id };
}

async function api(user, method, route, body) {
  const r = await fetch(`${stack.base}/api/nala/${route}`, { method, headers: { ...sessions[user], ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: r.status, data };
}
const ok = async (...args) => { const r = await api(...args); assert.ok(r.status < 300, `${args[1]} ${args[2]} → ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const fixture = (key, responses) => fetch(`${stack.openaiUrl}/__fixtures`, { method: 'POST', body: JSON.stringify({ key, responses }) });
const okBody = facturas => ({ body: { facturas, paginas_sin_factura: [] } });

async function upload(user, batchId, names) {
  const files = names.map(name => { const buf = fs.readFileSync(path.join(dir, name)); return { name, size: buf.length, sha256: sha(buf), buf }; });
  const reg = await ok(user, 'POST', `batches/${batchId}/files`, { files: files.map(({ buf, ...f }) => f) });
  for (const r of reg.files) {
    if (!r.upload_url) continue;
    const f = files.find(x => x.name === r.name);
    const put = await fetch(r.upload_url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: f.buf });
    assert.equal(put.status, 200);
    await ok(user, 'POST', `batches/${batchId}/files/${r.document_id}/complete`);
  }
  return reg.files;
}

async function drain(user, batchId, { maxMs = 60000 } = {}) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    await ok(user, 'POST', 'jobs/tick');
    const d = await ok(user, 'GET', `batches/${batchId}`);
    if (!['queued', 'processing'].includes(d.batch.status)) return d;
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('el lote no terminó a tiempo');
}

const A = { emisor: { nombre: 'Suministros Alfa SRL', rnc_cedula: '131999999' }, receptor: { nombre: 'Cliente Uno SRL', rnc_cedula: '101010632' }, fecha_emision: '2026-08-05',
  moneda_codigo: 'DOP', moneda_simbolo: 'RD$', forma_pago_codigo: '02', tipo_bienes_servicios_sugerido: '02' };

test.before(async () => {
  dir = await render(path.join(require('os').tmpdir(), 'nala-fixtures'));
  stack = await startStack();
  db = new Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/nala_test' });
  await db.connect();
  for (const [u, p] of [['admin', 'Admin#2026'], ['oficial', 'Oficial#2026'], ['lector', 'Lector#2026'], ['sinnala', 'SinNala#2026'], ['otraadmin', 'Otra#2026']]) await login(u, p);
  await fixture('factura-alfa.jpg#1', [{ status: 500 }, { status: 503 }, okBody([inv({ ...A, ncf: 'B0100000101', monto_servicios: '10000.00', subtotal: '10000.00', itbis: '1800.00', total: '11800.00' })])]);
  await fixture('factura-beta.png#1', [okBody([inv({ ...A, emisor: { nombre: 'Servicios Beta EIRL', rnc_cedula: '131999999' }, ncf: 'B0100000202', monto_servicios: '2000.00', subtotal: '2000.00', itbis: '360.00', total: '2500.00' })])]);
  await fixture('lote-varias.pdf#1', [okBody([
    inv({ ...A, ncf: 'B0100000101', monto_servicios: '10000.00', subtotal: '10000.00', itbis: '1800.00', total: '11800.00' }),
    inv({ ...A, emisor: { nombre: 'Gamma Tech SRL', rnc_cedula: '131999999' }, ncf: 'E310000000401', monto_bienes: '500.00', subtotal: '500.00', itbis: '90.00', total: '590.00', tipo_bienes_servicios_sugerido: '09' }),
    inv({ ...A, pagina_desde: 2, pagina_hasta: 2, emisor: { nombre: 'Importadora Delta', rnc_cedula: '131999999' }, ncf: 'B0100000501', moneda_codigo: 'USD', moneda_simbolo: 'US$', monto_bienes: '100.00', subtotal: '100.00', itbis: '18.00', total: '118.00' }),
  ])]);
  await fixture('escaneada.pdf#1', [{ status: 500, message: 'fallo persistente' }]);
  await fixture('otra-empresa.jpg#1', [okBody([inv({ ...A, emisor: { nombre: 'Otra Empresa', rnc_cedula: '131999999' }, receptor: { nombre: 'Cliente Dos SA', rnc_cedula: '130000001' }, ncf: 'B0100000601', monto_servicios: '10000.00', subtotal: '10000.00', itbis: '1800.00', total: '11800.00' })])]);
  await fixture('simbolo-dolar.jpg#1', [okBody([inv({ ...A, emisor: { nombre: 'Tienda Sin Moneda', rnc_cedula: '131999999' }, ncf: 'B0100000701', moneda_codigo: null, moneda_simbolo: '$', monto_servicios: '10000.00', subtotal: '10000.00', itbis: '1800.00', total: '11800.00', campos_baja_confianza: ['moneda_simbolo'] })])]);
  await fixture('escaneada-2.pdf#1', [okBody([inv({ ...A, ncf: 'B0100000802', monto_servicios: '1000.00', subtotal: '1000.00', itbis: '180.00', total: '1180.00' })])]);
  await fixture('venta-credito.png#1', [okBody([inv({ emisor: { nombre: 'Cliente Uno SRL', rnc_cedula: '101010632' }, receptor: { nombre: 'Comprador Uno', rnc_cedula: '131999999' }, ncf: 'B0100000900', fecha_emision: '2026-08-10', moneda_codigo: 'DOP', moneda_simbolo: 'RD$', subtotal: '5000.00', itbis: '900.00', total: '5900.00', forma_pago_codigo: '03', tipo_ingreso_sugerido: '01' })])]);
  await fixture('venta-consumo.png#1', [okBody([inv({ emisor: { nombre: 'Cliente Uno SRL', rnc_cedula: '101010632' }, receptor: { nombre: 'Consumidor final', rnc_cedula: null }, ncf: 'B0200000901', fecha_emision: '2026-08-10', moneda_codigo: 'DOP', moneda_simbolo: 'RD$', subtotal: '1000.00', itbis: '180.00', total: '1180.00', forma_pago_codigo: '01', tipo_ingreso_sugerido: '01' })])]);
});

test.after(async () => { await db?.end(); await stack?.stop(); });

const state = {};

test('permisos: sin NALA, sólo lectura y otra empresa operadora', async () => {
  assert.equal((await api('sinnala', 'GET', 'me')).status, 403);
  const anon = await fetch(`${stack.base}/api/nala/me`);
  assert.equal(anon.status, 401);
  await ok('admin', 'PUT', 'team/00000000-0000-0000-0000-00000000a003', { nala_role: 'lectura' });
  const r = await api('lector', 'POST', 'batches', { client_id: CLIENT_UNO, format: '606', period: '202608', name: 'x' });
  assert.equal(r.status, 403);
  assert.equal((await api('admin', 'POST', 'batches', { client_id: OTHER_TENANT_CLIENT, format: '606', period: '202608', name: 'x' })).status, 404);
});

test('lote 606: idempotencia, registro de archivos, RAR y duplicados', async () => {
  const body = { client_id: CLIENT_UNO, format: '606', period: '202608', name: 'Compras agosto', idempotency_key: 'lote-compras-agosto-0001' };
  const first = await ok('admin', 'POST', 'batches', body);
  const again = await ok('admin', 'POST', 'batches', body);
  assert.equal(again.batch.id, first.batch.id); assert.equal(again.reused, true);
  state.batch606 = first.batch.id;
  const files = await upload('admin', state.batch606, ['factura-alfa.jpg', 'factura-beta.png', 'lote-varias.pdf', 'escaneada.pdf', 'otra-empresa.jpg', 'simbolo-dolar.jpg', 'paquete.zip', 'facturas.rar']);
  assert.match(files.find(f => f.name === 'facturas.rar').error, /RAR/);
  const dupReg = await ok('admin', 'POST', `batches/${state.batch606}/files`, { files: [{ name: 'copia.jpg', size: fs.statSync(path.join(dir, 'factura-alfa.jpg')).size, sha256: sha(fs.readFileSync(path.join(dir, 'factura-alfa.jpg'))) }] });
  assert.match(dupReg.files[0].error, /^Esta factura ya fue cargada el \d{2}\/\d{2}\/\d{4} en el lote «Compras agosto»/);
  assert.equal(dupReg.files[0].upload_url, undefined);
});

test('recuperación: un trabajo tomado por un proceso caído se recupera al vencer el arrendamiento', async () => {
  await ok('admin', 'POST', `batches/${state.batch606}/start`);
  const { rows } = await db.query("select * from nala_claim_jobs('proceso-caido', 1, null, 1)");
  assert.equal(rows.length, 1);
  state.crashedJob = rows[0].id;
  await new Promise(r => setTimeout(r, 1500));
});

test('procesamiento en segundo plano con reintentos, ZIP, PDF de varias facturas y fallos', async () => {
  const d = await drain('admin', state.batch606);
  assert.equal(d.batch.status, 'review');
  const crashed = d.jobs.find(j => j.id === state.crashedJob);
  assert.equal(crashed.status, 'succeeded');
  const alfaDoc = d.documents.find(x => x.original_name === 'factura-alfa.jpg');
  const alfaJobs = d.jobs.filter(j => j.document_id === alfaDoc.id && j.kind === 'extract');
  assert.equal(alfaJobs[0].attempts, 3, 'reintentó dos veces antes de lograrlo');
  assert.equal(d.documents.find(x => x.original_name === 'escaneada.pdf').status, 'failed');
  assert.equal(d.documents.find(x => x.original_name === 'factura-zeta.jpg').status, 'duplicate');
  assert.equal(d.documents.find(x => x.original_name === 'leeme.txt').status, 'unsupported');
  assert.match(d.documents.find(x => x.original_name === 'comprimido.rar').error, /RAR/);
  assert.equal(d.documents.find(x => x.original_name === 'lote-varias.pdf').page_count, 2);
  assert.ok(d.progress.elapsed_ms > 0);
  const list = await ok('admin', 'GET', `invoices?batch_id=${state.batch606}`);
  assert.equal(list.total, 8);
  const by = ncf => list.invoices.find(i => i.ncf === ncf && i.batch_id === state.batch606);
  state.inv = { alfa: by('B0100000101'), beta: by('B0100000202'), delta: by('B0100000501'), otra: by('B0100000601'), dolar: by('B0100000701'), gamma: by('E310000000401'), zeta2: by('B0100000802') };
  const codes = i => i.issues.map(x => x.code);
  assert.ok(codes(state.inv.beta).includes('DIFERENCIA_TOTAL'));
  assert.ok(codes(state.inv.delta).includes('TASA_REQUERIDA'));
  assert.ok(codes(state.inv.otra).includes('EMPRESA_INCORRECTA'));
  assert.ok(codes(state.inv.dolar).includes('MONEDA_NO_IDENTIFICADA'));
  const copies = list.invoices.filter(i => i.ncf === 'B0100000101');
  assert.equal(copies.length, 2);
  state.copy = copies.find(i => codes(i).includes('DUPLICADO'));
  state.inv.alfa = copies.find(i => i !== state.copy);
  assert.ok(state.copy, 'la copia posterior queda marcada');
  assert.match(state.copy.issues.find(i => i.code === 'DUPLICADO').message, /^Comprobante repetido\. El NCF B0100000101 \(131999999\) ya está en revisión desde el .* en el lote «Compras agosto»/);
  assert.ok(codes(state.inv.alfa).includes('COPIA_POSTERIOR'));
  assert.equal(state.inv.alfa.critical_count === 0 || !codes(state.inv.alfa).includes('DUPLICADO'), true);
  const pdfInvoices = list.invoices.filter(i => i.document_id === d.documents.find(x => x.original_name === 'lote-varias.pdf').id);
  assert.deepEqual(pdfInvoices.map(i => i.page_from).sort(), [1, 1, 2]);
  assert.equal(state.inv.delta.fields.monto_bienes, '100.00');
  assert.equal(state.inv.alfa.fields.itbis, '1800.00');
  assert.equal(state.inv.dolar.fields.moneda, null, '"$" no se interpreta como USD ni DOP');
});

test('reprocesar fallidos no duplica y respeta correcciones humanas', async () => {
  const before = (await ok('admin', 'GET', `invoices?batch_id=${state.batch606}`)).total;
  // Human correction on an invoice, then reprocess its document.
  const inv0 = state.inv.beta;
  await ok('admin', 'PATCH', `invoices/${inv0.id}`, { version: inv0.version, fields: { total: '2360.00' } });
  await fixture('escaneada.pdf#1', [okBody([inv({ ...A, ncf: 'B0100000801', monto_servicios: '3000.00', subtotal: '3000.00', itbis: '540.00', total: '3540.00' })])]);
  await fixture('factura-beta.png#1', [okBody([inv({ ...A, emisor: { nombre: 'Servicios Beta EIRL', rnc_cedula: '131999999' }, ncf: 'B0100000202', monto_servicios: '2000.00', subtotal: '2000.00', itbis: '360.00', total: '9999.00' })])]);
  const r = await ok('admin', 'POST', `batches/${state.batch606}/reprocess`, { failed_only: true });
  assert.equal(r.requeued, 1);
  const docBeta = (await ok('admin', 'GET', `batches/${state.batch606}`)).documents.find(x => x.original_name === 'factura-beta.png');
  await ok('admin', 'POST', `batches/${state.batch606}/reprocess`, { failed_only: false, document_ids: [docBeta.id] });
  await drain('admin', state.batch606);
  const after = await ok('admin', 'GET', `invoices?batch_id=${state.batch606}`);
  assert.equal(after.total, before + 1, 'sólo aparece la factura del documento que antes falló');
  const beta = after.invoices.find(i => i.id === inv0.id);
  assert.equal(beta.fields.total, '2360.00', 'la corrección humana se conserva');
  assert.equal(after.invoices.filter(i => i.ncf === 'B0100000202').length, 1);
  state.inv.beta = beta;
});

test('auditoría: versión, bloqueo, guardar ≠ aprobar, críticos bloquean, advertencias con motivo', async () => {
  const copy = (await ok('admin', 'GET', `invoices/${state.copy.id}`)).invoice;
  assert.equal((await api('admin', 'POST', `invoices/${copy.id}/approve`, { version: copy.version })).status, 422, 'la copia repetida no se aprueba');
  const discarded = await ok('admin', 'POST', `batches/${state.batch606}/discard-duplicates`);
  assert.equal(discarded.discarded, 1);
  assert.equal((await ok('admin', 'GET', `invoices/${copy.id}`)).invoice.status, 'excluded');
  const alfa = (await ok('admin', 'GET', `invoices/${state.inv.alfa.id}`)).invoice;
  assert.ok(!alfa.issues.some(i => i.code === 'COPIA_POSTERIOR'), 'al descartar la copia, la original queda limpia');
  // Concurrency: oficial locks the invoice; admin cannot save meanwhile.
  await ok('oficial', 'POST', `invoices/${alfa.id}/lock`);
  const fresh = (await ok('admin', 'GET', `invoices/${alfa.id}`));
  assert.equal(fresh.lock.locked_by_other, true);
  assert.equal((await api('admin', 'PATCH', `invoices/${alfa.id}`, { version: fresh.invoice.version, fields: { forma_pago: '02' } })).status, 423);
  await ok('oficial', 'DELETE', `invoices/${alfa.id}/lock`);
  assert.equal((await api('admin', 'PATCH', `invoices/${alfa.id}`, { version: fresh.invoice.version - 1, fields: { forma_pago: '02' } })).status, 409, 'versión vieja');
  const saved = await ok('admin', 'PATCH', `invoices/${alfa.id}`, { version: fresh.invoice.version, fields: { tipo_bienes_servicios: '02' } });
  assert.equal(saved.invoice.status, 'reviewed');
  assert.ok(saved.invoice.corrected_fields.includes('tipo_bienes_servicios'));
  assert.equal(saved.invoice.critical_count, 0);
  const warnings = saved.invoice.issues.filter(i => i.severity === 'warning');
  if (warnings.length) {
    assert.equal((await api('admin', 'POST', `invoices/${alfa.id}/approve`, { version: saved.invoice.version })).status, 422);
  }
  const approved = await ok('admin', 'POST', `invoices/${alfa.id}/approve`, { version: saved.invoice.version, accept_warnings: true, reason: 'Revisado contra el original' });
  assert.equal(approved.invoice.status, 'approved');
  assert.equal((await api('admin', 'PATCH', `invoices/${alfa.id}`, { version: approved.invoice.version, fields: { total: '1' } })).status, 409, 'aprobada no se edita');
  state.inv.alfa = approved.invoice;
  // Critical: total difference remains blocked until corrected.
  const delta = (await ok('admin', 'GET', `invoices/${state.inv.delta.id}`)).invoice;
  assert.equal((await api('admin', 'POST', `invoices/${delta.id}/approve`, { version: delta.version, accept_warnings: true, reason: 'x x x x x' })).status, 422);
  const fixed = await ok('admin', 'PATCH', `invoices/${delta.id}`, { version: delta.version, fields: { tasa_cambio: '60.2500', tasa_fecha: '2026-08-05', tasa_fuente: 'Banco Central RD', tipo_bienes_servicios: '09' } });
  assert.equal(fixed.invoice.critical_count, 0);
  assert.equal(fixed.invoice.total_dop, '7109.50');
  state.inv.delta = (await ok('admin', 'POST', `invoices/${delta.id}/approve`, { version: fixed.invoice.version, accept_warnings: true, reason: 'Tasa BCRD del día' })).invoice;
  const dolar = (await ok('admin', 'GET', `invoices/${state.inv.dolar.id}`)).invoice;
  const dolarFixed = await ok('admin', 'PATCH', `invoices/${dolar.id}`, { version: dolar.version, fields: { moneda: 'DOP', tipo_bienes_servicios: '02' } });
  state.inv.dolar = (await ok('admin', 'POST', `invoices/${dolar.id}/approve`, { version: dolarFixed.invoice.version, accept_warnings: true, reason: 'Confirmado en pesos con el proveedor' })).invoice;
  const events = await ok('admin', 'GET', `events?invoice_id=${alfa.id}`);
  const actions = events.events.map(e => e.action);
  for (const a of ['extracted', 'saved', 'approved']) assert.ok(actions.includes(a), a);
  assert.equal(events.events.find(e => e.action === 'approved').reason, 'Revisado contra el original');
});

test('reubicación a otra empresa sin duplicar y revertir aprobación', async () => {
  const before = await ok('admin', 'GET', 'stats');
  const otra = (await ok('admin', 'GET', `invoices/${state.inv.otra.id}`)).invoice;
  const moved = await ok('admin', 'POST', `invoices/${otra.id}/relocate`, { client_id: CLIENT_DOS, period: '202608', reason: 'La factura es de Cliente Dos' });
  assert.equal(moved.invoice.id, otra.id);
  assert.equal(moved.invoice.client_id, CLIENT_DOS);
  assert.ok(!moved.invoice.issues.some(i => i.code === 'EMPRESA_INCORRECTA'));
  const after = await ok('admin', 'GET', 'stats');
  assert.equal(after.stats.invoices, before.stats.invoices, 'el total consolidado no cambia');
  const uno = await ok('admin', 'GET', `stats?client_id=${CLIENT_UNO}`); const dos = await ok('admin', 'GET', `stats?client_id=${CLIENT_DOS}`);
  assert.equal(uno.stats.invoices + dos.stats.invoices, after.stats.invoices);
  const reverted = await ok('admin', 'POST', `invoices/${state.inv.dolar.id}/revert`, { reason: 'Revisar moneda nuevamente' });
  assert.equal(reverted.invoice.status, 'reviewed');
  state.inv.dolar = (await ok('admin', 'POST', `invoices/${state.inv.dolar.id}/approve`, { version: reverted.invoice.version, accept_warnings: true, reason: 'Confirmado de nuevo' })).invoice;
});

test('indicadores coinciden entre panel, lote, auditoría y exportación', async () => {
  const stats = (await ok('admin', 'GET', `stats?client_id=${CLIENT_UNO}&period_from=202608&period_to=202608&format=606`)).stats;
  const invoices = await ok('admin', 'GET', `invoices?client_id=${CLIENT_UNO}&period=202608&format=606&status=pending_review,reviewed,approved`);
  assert.equal(stats.invoices, invoices.total);
  assert.equal(stats.approved, invoices.invoices.filter(i => i.status === 'approved').length);
  const batchDetail = await ok('admin', 'GET', `batches/${state.batch606}`);
  const batchList = (await ok('admin', 'GET', `batches?client_id=${CLIENT_UNO}`)).batches.find(b => b.id === state.batch606);
  assert.deepEqual(batchList.summary, batchDetail.stats);
  const preview = await ok('admin', 'POST', 'exports/preview', { client_id: CLIENT_UNO, format: '606', period: '202608' });
  assert.equal(preview.snapshot.lines.length, stats.approved);
  const sumTotal = preview.snapshot.lines.reduce((s, l) => s + Number(l.values[9]), 0) + preview.snapshot.lines.reduce((s, l) => s + Number(l.values[10] || 0), 0);
  assert.equal(Math.round(sumTotal * 100), Math.round(Number(stats.approved_total_dop) * 100), 'conciliación de montos');
});

test('exportación 606: vista previa, advertencias aceptadas, TXT y Excel con la misma instantánea', async () => {
  const body = { client_id: CLIENT_UNO, format: '606', period: '202608' };
  const preview = await ok('admin', 'POST', 'exports/preview', body);
  assert.deepEqual(preview.snapshot.errors, []);
  assert.ok(preview.snapshot.warnings.some(w => w.code === 'PENDIENTES_SIN_APROBAR'));
  const missing = await api('admin', 'POST', 'exports', { ...body, preview_fingerprint: preview.fingerprint });
  assert.equal(missing.status, 422);
  const created = await ok('admin', 'POST', 'exports', { ...body, preview_fingerprint: preview.fingerprint, accepted_warnings: preview.snapshot.warnings.map(w => w.code), reason: 'Pendientes se reportan en rectificativa' });
  state.export606 = created.export.id;
  const txtLink = await ok('admin', 'GET', `exports/${state.export606}/download?type=txt`);
  const txt = Buffer.from(await (await fetch(txtLink.url)).arrayBuffer());
  assert.equal(sha(txt), created.export.txt_sha256);
  const text = txt.toString('latin1');
  assert.equal(text, formats.toTxt(preview.snapshot), 'TXT = vista previa');
  assert.deepEqual(formats.validateTxt('606', text).problems, []);
  assert.match(txtLink.file_name, /^DGII_F_606_101010632_202608\.TXT$/);
  const xlsxLink = await ok('admin', 'GET', `exports/${state.export606}/download?type=xlsx`);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await (await fetch(xlsxLink.url)).arrayBuffer()));
  const ws = wb.getWorksheet('Formato 606');
  preview.snapshot.lines.forEach((line, i) => {
    assert.equal(ws.getRow(7 + i).getCell(2).value, line.values[0]);
    assert.equal(ws.getRow(7 + i).getCell(5).value, line.values[3]);
    assert.equal(ws.getRow(7 + i).getCell(11).value, line.values[9] ? Number(line.values[9]) : null);
  });
  const custom = await ok('admin', 'GET', `exports/${state.export606}/download?type=custom&columns=x_counterpart,rnc_cedula,ncf,itbis`);
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(Buffer.from(custom.base64, 'base64'));
  assert.equal(wb2.worksheets[0].getCell('B1').value, 'RNC o Cédula');
  // Open the invoice from an export line.
  const lineInvoice = await ok('admin', 'GET', `invoices/${preview.snapshot.lines[0].invoice_id}`);
  assert.equal(lineInvoice.exports[0].export_id, state.export606);
});

test('estados de exportación: generado → enviado → aceptado; revertir queda bloqueado', async () => {
  await ok('admin', 'POST', `exports/${state.export606}/status`, { status: 'submitted', reference: 'OFV-123456' });
  assert.equal((await api('admin', 'POST', `exports/${state.export606}/status`, { status: 'generated' })).status, 409);
  await ok('admin', 'POST', `exports/${state.export606}/status`, { status: 'accepted', notes: 'Completado en Consulta Envíos 606' });
  const r = await api('admin', 'POST', `invoices/${state.inv.alfa.id}/revert`, { reason: 'probar bloqueo' });
  assert.equal(r.status, 409);
  const stats = (await ok('admin', 'GET', `stats?client_id=${CLIENT_UNO}`)).stats;
  assert.equal(stats.exports_accepted, 1);
});

test('lote 607: forma de pago, consumo resumido y TXT con tipo de ingreso de 1 dígito', async () => {
  const b = (await ok('admin', 'POST', 'batches', { client_id: CLIENT_UNO, format: '607', period: '202608', name: 'Ventas agosto' })).batch;
  await upload('admin', b.id, ['venta-credito.png', 'venta-consumo.png']);
  await ok('admin', 'POST', `batches/${b.id}/start`);
  await drain('admin', b.id);
  const list = await ok('admin', 'GET', `invoices?batch_id=${b.id}`);
  for (const invoice of list.invoices) {
    const saved = await ok('admin', 'PATCH', `invoices/${invoice.id}`, { version: invoice.version, fields: { tipo_ingreso: '01' } });
    assert.equal(saved.invoice.critical_count, 0, JSON.stringify(saved.invoice.issues));
    await ok('admin', 'POST', `invoices/${invoice.id}/approve`, { version: saved.invoice.version, accept_warnings: true, reason: 'Revisado' });
  }
  const preview = await ok('admin', 'POST', 'exports/preview', { client_id: CLIENT_UNO, format: '607', period: '202608', batch_ids: [b.id] });
  assert.deepEqual(preview.snapshot.errors, []);
  assert.equal(preview.snapshot.lines.length, 1);
  assert.equal(preview.snapshot.consumer_summary.count, 1);
  const txt = formats.toTxt(preview.snapshot);
  assert.equal(txt.split('\r\n')[1], '131999999|1|B0100000900||1|20260810||5000.00|900.00||||||||||5900.00||||');
});

test('permisos por empresa asignada y enlaces directos', async () => {
  await ok('admin', 'PUT', 'team/00000000-0000-0000-0000-00000000a002', { nala_role: 'oficial', all_clients: false, client_ids: [CLIENT_DOS] });
  assert.equal((await api('oficial', 'GET', `invoices/${state.inv.alfa.id}`)).status, 404);
  assert.equal((await api('oficial', 'GET', `exports/${state.export606}`)).status, 404);
  const own = await ok('oficial', 'GET', 'invoices');
  assert.ok(own.invoices.length >= 1 && own.invoices.every(i => i.client_id === CLIENT_DOS));
  const doc = await ok('oficial', 'GET', `documents/${state.inv.otra.document_id}/url`);
  const original = Buffer.from(await (await fetch(doc.url)).arrayBuffer());
  assert.equal(sha(original), sha(fs.readFileSync(path.join(dir, 'otra-empresa.jpg'))), 'el original se conserva intacto');
  assert.equal((await api('oficial', 'GET', `documents/${state.inv.alfa.document_id}/url`)).status, 404);
  assert.equal((await api('otraadmin', 'GET', `invoices/${state.inv.alfa.id}`)).status, 404);
  assert.equal((await api('otraadmin', 'GET', `batches/${state.batch606}`)).status, 404);
  assert.equal((await api('otraadmin', 'GET', 'stats')).data.stats.invoices, 0);
  assert.equal((await api('oficial', 'PUT', 'settings', { settings: {} })).status, 403);
});

test('volver a enviar una factura ya leída: se rechaza con un mensaje claro', async () => {
  const b = (await ok('admin', 'POST', 'batches', { client_id: CLIENT_UNO, format: '606', period: '202609', name: 'Reenvío' })).batch;
  const files = await upload('admin', b.id, ['factura-alfa.jpg']);
  assert.match(files[0].error, /^Esta factura ya fue cargada el \d{2}\/\d{2}\/\d{4} en el lote «Compras agosto» \(Cliente Uno SRL, 606 08\/2026\)\. Comprobantes: B0100000101 aprobada\. No se vuelve a leer\.$/);
  assert.equal((await ok('admin', 'GET', `batches/${b.id}`)).documents.length, 0, 'no se registra ni se vuelve a leer');
});

test('consulta RNC: dueño, estado, antigüedad, adecuación y aviso de deudas', async () => {
  const r = await ok('admin', 'GET', 'rnc/101-01063-2');
  assert.equal(r.structure.checkDigitValid, true);
  assert.equal(r.official.found, true);
  assert.equal(r.official.data.nombre, 'BANCO POPULAR DOMINICANO S A BANCO MULTIPLE');
  assert.equal(r.registry.found, true);
  assert.equal(r.registry.fecha_constitucion, '1984-08-15');
  assert.match(r.debts.message, /no publica deudas/);
  const missing = await ok('admin', 'GET', 'rnc/130000009');
  assert.equal(missing.official.found, false);
  assert.match(missing.official.data.message, /no se encuentra inscrito/);
});

test('worker programado protegido por secreto', async () => {
  assert.equal((await fetch(`${stack.base}/api/nala/jobs/worker`)).status, 401);
  const r = await fetch(`${stack.base}/api/nala/jobs/worker`, { headers: { authorization: `Bearer ${process.env.NALA_WORKER_SECRET}` } });
  assert.equal(r.status, 200);
});

test('rutas existentes de NALA y otros módulos siguen funcionando', async () => {
  const H = sessions.admin;
  const analyze = await fetch(`${stack.base}/api/nala/analyze`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(analyze.status, 400);
  assert.equal((await analyze.json()).error, 'archivo requerido');
  assert.equal((await fetch(`${stack.base}/api/nala/analyze`, { method: 'POST' })).status, 401);
  const chat = await fetch(`${stack.base}/api/nala/chat`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [] }) });
  assert.equal(chat.status, 400);
  for (const route of ['/api/clients', '/api/config', '/api/users', '/api/credentials', '/api/ir2/resumen?rnc=101010632']) {
    const r = await fetch(stack.base + route, { headers: H });
    assert.equal(r.status, 200, route);
  }
  const { rows } = await db.query("select count(*)::int as n from direct_credentials");
  assert.equal(rows[0].n, 1, 'datos existentes intactos');
});
