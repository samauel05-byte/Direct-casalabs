// Mirrors the crypto helpers in the web app exactly
const C = {
  _b64(u8) { return btoa(String.fromCharCode(...u8)); },
  _u8(b64)  { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)); },
  async deriveKey(pw, saltB64) {
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name:'PBKDF2', salt:C._u8(saltB64), iterations:200000, hash:'SHA-256' },
      km, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']
    );
  },
  async deriveKeyFromBytes(rawBytes, saltB64) {
    const km = await crypto.subtle.importKey('raw', rawBytes, 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name:'PBKDF2', salt:C._u8(saltB64), iterations:200000, hash:'SHA-256' },
      km, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']
    );
  },
  async dec(key, iv, ct) {
    const raw = await crypto.subtle.decrypt(
      { name:'AES-GCM', iv: new Uint8Array(iv) }, key, new Uint8Array(ct)
    );
    return JSON.parse(new TextDecoder().decode(raw));
  },
  async decBytes(key, ivArr, ctArr) {
    const raw = await crypto.subtle.decrypt(
      { name:'AES-GCM', iv: new Uint8Array(ivArr) }, key, new Uint8Array(ctArr)
    );
    return new Uint8Array(raw);
  },
};

const API = 'https://app.casalabs.com.do';
let masterKey = null;
let credentials = [];

const $ = id => document.getElementById(id);

function showStatus(id, msg, type) {
  const el = $(id);
  el.textContent = msg;
  el.className = 'status ' + type;
}
function clearStatus(id) { $(id).className = 'status'; }

// ── Unlock: calls the Vercel API, derives masterKey client-side ───────────────
async function unlock() {
  const user = $('master-user').value.trim();
  const pw   = $('master-pw').value;
  if (!user || !pw) {
    showStatus('status-lock', 'Completa usuario y contraseña.', 'err');
    return;
  }

  showStatus('status-lock', 'Conectando…', 'warn');
  $('btn-unlock').disabled = true;

  try {
    // Step 1: Login to Vercel API
    const loginRes = await fetch(API + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pw }),
    }).then(r => r.json());

    if (!loginRes.ok) {
      showStatus('status-lock', loginRes.error || 'Credenciales incorrectas.', 'err');
      $('btn-unlock').disabled = false;
      return;
    }

    const token = loginRes.access_token;

    // Step 2: Derive userKey from password + userSalt
    const userKey = await C.deriveKey(pw, loginRes.userSalt);

    // Step 3: Decrypt vault secret
    const vaultSecret = await C.decBytes(userKey, loginRes.vaultKeyIv, loginRes.vaultKeyCt);

    // Step 4: Get vaultSalt from config
    const configRes = await fetch(API + '/api/config', {
      headers: { 'Authorization': 'Bearer ' + token },
    }).then(r => r.json());
    const vaultSalt = configRes.config?.vaultSalt;
    if (!vaultSalt) throw new Error('No se pudo obtener la configuración del vault.');

    // Step 5: Derive masterKey
    masterKey = await C.deriveKeyFromBytes(vaultSecret, vaultSalt);

    // Step 6: Fetch credentials
    const credsRes = await fetch(API + '/api/credentials', {
      headers: { 'Authorization': 'Bearer ' + token },
    }).then(r => r.json());
    credentials = credsRes.credentials || [];

    // Show main screen
    clearStatus('status-lock');
    $('lock-screen').hidden = true;
    $('main-screen').hidden = false;
    renderCredentials();

  } catch (e) {
    showStatus('status-lock', 'Error: ' + e.message, 'err');
  }
  $('btn-unlock').disabled = false;
}

// ── Portal name helpers ───────────────────────────────────────────────────────
const INST_NAMES = {
  dgii: 'DGII', tss: 'TSS', trabajo: 'Min. Trabajo', cardnet: 'Cardnet',
};
const INST_HOSTS = {
  dgii: 'dgii.gov.do', tss: 'tss.gob.do', trabajo: 'mt.gob.do', cardnet: 'cardnet.com.do',
};

// ── Render credentials ────────────────────────────────────────────────────────
async function renderCredentials() {
  const list = $('cred-list');
  if (!credentials.length) {
    list.innerHTML = '<div style="font-size:12px;color:#64748b;padding:8px 0">No hay credenciales en tu bóveda.</div>';
    return;
  }

  const items = await Promise.all(credentials.map(async (c, i) => {
    try {
      const d = await C.dec(masterKey, c.iv, c.ct);
      return { i, c, d };
    } catch { return null; }
  }));

  list.innerHTML = '';
  for (const item of items) {
    if (!item) continue;
    const { i, c, d } = item;
    const name    = d.companyName || d.name || 'Sin nombre';
    const portal  = INST_NAMES[c.institution] || c.institution || '';
    const userStr = d.username || d.user || '';
    const div = document.createElement('div');
    div.className = 'cred-item';
    div.innerHTML = `
      <div class="cred-info">
        <div class="cred-name">${esc(name)}</div>
        <div class="cred-sub">${esc(portal)} · ${esc(userStr)}</div>
      </div>
      <div class="cred-actions">
        <button class="btn btn-sm btn-green" data-i="${i}">▶ Usar</button>
      </div>`;
    list.appendChild(div);
  }

  list.querySelectorAll('[data-i]').forEach(btn => {
    btn.addEventListener('click', () => fillCurrent(parseInt(btn.dataset.i)));
  });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Fill form in current tab ──────────────────────────────────────────────────
async function fillCurrent(index) {
  const cred = credentials[index];
  if (!cred) return;

  let data;
  try { data = await C.dec(masterKey, cred.iv, cred.ct); }
  catch { showStatus('status-main', 'Error al descifrar.', 'err'); return; }

  // Map institution key to portal host
  const host = INST_HOSTS[cred.institution] || cred.institution || '';

  const payload = {
    username: data.username || data.user || '',
    password: data.password || data.pass || '',
    cedula:   data.cedula || '',
    tarjeta:  data.tarjeta || '',
    dgiiCodes: data.dgiiCodes ? data.dgiiCodes.split(/[,;|\n]+/).map(code => code.trim()).filter(Boolean) : [],
    portal:   host,
  };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { showStatus('status-main', 'No hay pestaña activa.', 'err'); return; }

  chrome.tabs.sendMessage(tab.id, { type: 'FILL_FORM', creds: payload }, (resp) => {
    if (chrome.runtime.lastError) {
      showStatus('status-main', 'Abre el portal de login primero, luego da clic en ▶ Usar.', 'warn');
    } else {
      showStatus('status-main', '✓ Formulario rellenado.', 'ok');
      setTimeout(() => clearStatus('status-main'), 3000);
    }
  });
}

// ── Refresh ───────────────────────────────────────────────────────────────────
$('btn-refresh').addEventListener('click', async () => {
  showStatus('status-main', 'Actualizando…', 'warn');
  const user = await chrome.storage.session.get('lastUser');
  // Re-login silently not possible without storing password — just show message
  showStatus('status-main', 'Cierra sesión e ingresa de nuevo para actualizar.', 'warn');
  setTimeout(() => clearStatus('status-main'), 3000);
});

// ── Lock ──────────────────────────────────────────────────────────────────────
$('btn-lock').addEventListener('click', () => {
  masterKey = null;
  credentials = [];
  $('master-pw').value = '';
  $('main-screen').hidden = true;
  $('lock-screen').hidden = false;
  clearStatus('status-lock');
});

// ── Unlock triggers ───────────────────────────────────────────────────────────
$('btn-unlock').addEventListener('click', unlock);
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !$('lock-screen').hidden) unlock();
});
