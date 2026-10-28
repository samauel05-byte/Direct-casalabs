import { createRequire } from 'module';
import { webcrypto } from 'crypto';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const { subtle } = webcrypto;
const BASE_URL = 'https://app.casalabs.com.do';
const ADMIN_USER = 'root';
const ADMIN_PASS = '050700';
const EXCEL_PATH = '/root/.claude/uploads/16fc45d8-96de-5e25-9879-9e6b37aae4e2/182d0384-PARA_SUBIR.xlsx';

const b64enc = (bytes) => Buffer.from(bytes).toString('base64');
const b64dec = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));

async function deriveKey(password, saltB64) {
  const km = await subtle.importKey('raw', Buffer.from(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: b64dec(saltB64), iterations: 200000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function deriveKeyFromBytes(rawBytes, saltB64) {
  const km = await subtle.importKey('raw', rawBytes, 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: b64dec(saltB64), iterations: 200000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function decBytes(key, iv64, ct64) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64dec(iv64) }, key, b64dec(ct64));
  return new Uint8Array(pt);
}

async function enc(key, obj) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
  return { iv: b64enc(iv), ct: b64enc(new Uint8Array(ct)) };
}

async function api(method, path, body, token) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(BASE_URL + path, opts);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${method} ${path} → ${r.status}: ${t}`);
  }
  return r.json();
}

function str(v) { return String(v || '').trim(); }

function extractPortals(row) {
  // Returns array of {portal, username, password, extra}
  const portals = [];

  // DGII
  const dgiiUser = str(row[1]);
  const dgiiPass = str(row[2]);
  if (dgiiUser && dgiiPass) portals.push({ portal: 'dgii', username: dgiiUser, password: dgiiPass });

  // TSS (Tesorería) — RNC o Cédula + Cédula + CLASS
  const tssUser = str(row[4]);    // tesoreria_rnc_cedula (RNC o Cédula)
  const tssCedula = str(row[5]);  // tesoreria_cedula (Cédula)
  const tssPass = str(row[6]);    // tesoreria_class (CLASS)
  if (tssUser && tssPass) portals.push({ portal: 'tss', username: tssUser, cedula: tssCedula, password: tssPass });

  // Min. Trabajo
  const trabajoUser = str(row[8]);  // mintrabajo_username
  const trabajoPass = str(row[9]);  // mintrabajo_password
  if (trabajoUser && trabajoPass) portals.push({ portal: 'trabajo', username: trabajoUser, password: trabajoPass });

  // SIRLA/IDOPPRIL
  const sirlaUser = str(row[10]);  // idoppril_rnc_user
  const sirlaPass = str(row[11]);  // idoppril_password
  if (sirlaUser && sirlaPass) portals.push({ portal: 'sirla', username: sirlaUser, password: sirlaPass });

  // Azul
  const azulUser = str(row[12]);
  const azulPass = str(row[13]);
  if (azulUser && azulPass) portals.push({ portal: 'azul', username: azulUser, password: azulPass });

  // Carnet (cardnet in Excel)
  const carnetUser = str(row[14]);
  const carnetPass = str(row[15]);
  if (carnetUser && carnetPass) portals.push({ portal: 'carnet', username: carnetUser, password: carnetPass });

  return portals;
}

async function main() {
  console.log('=== UPLOAD COMPANIES FROM EXCEL ===\n');

  // 1. Login
  console.log('1. Logging in as admin...');
  const loginRes = await api('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASS });
  const { access_token, userSalt, vaultKeyIv, vaultKeyCt } = loginRes;
  console.log('   Login OK');

  // 2. Derive vaultSecret
  console.log('2. Deriving vault secret...');
  const userKey = await deriveKey(ADMIN_PASS, userSalt);
  const vaultSecret = await decBytes(userKey, vaultKeyIv, vaultKeyCt);
  console.log('   Vault secret decrypted');

  // 3. Get config + derive masterKey
  console.log('3. Fetching config and deriving masterKey...');
  const { config } = await api('GET', '/api/config', null, access_token);
  const masterKey = await deriveKeyFromBytes(vaultSecret, config.vaultSalt);
  console.log('   MasterKey derived. vaultSalt =', config.vaultSalt);

  // 4. Parse Excel
  console.log('4. Parsing Excel...');
  const wb = XLSX.readFile(EXCEL_PATH);
  const ws = wb.Sheets['PARA SUBIR'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const dataRows = rows.slice(2).filter(r => str(r[0]));
  console.log(`   Found ${dataRows.length} companies\n`);

  // 5. Upload each company
  let uploaded = 0, skipped = 0, errors = 0;

  for (const row of dataRows) {
    const companyName = str(row[0]);
    const portals = extractPortals(row);

    if (portals.length === 0) {
      console.log(`  SKIP  ${companyName} — no credentials`);
      skipped++;
      continue;
    }

    process.stdout.write(`  ${companyName} — ${portals.map(p => p.portal).join(', ')} ... `);

    try {
      for (const { portal, username, cedula, password } of portals) {
        const payload = { companyName, username, password };
        if (cedula) payload.cedula = cedula;
        const { iv, ct } = await enc(masterKey, payload);
        const id = `${portal}_${companyName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${Date.now()}`;
        await api('PUT', `/api/credentials/${id}`, { institution: portal, category: 'acceso', iv, ct }, access_token);
      }
      console.log('OK');
      uploaded++;
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      errors++;
    }
  }

  console.log(`\n=== DONE: ${uploaded} uploaded, ${skipped} skipped, ${errors} errors ===`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
