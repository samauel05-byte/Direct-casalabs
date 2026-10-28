/* Códigos de un solo uso por tiempo (TOTP, RFC 6238), como los del Token Digital.
 * Corre en el navegador (y en Node para las pruebas) con WebCrypto. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TOTP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function base32Decode(s) {
    const clean = String(s || '').toUpperCase().replace(/[\s-]+/g, '').replace(/=+$/, '');
    if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('La clave del token no es válida (solo letras A–Z y números 2–7).');
    let bits = 0, value = 0; const out = [];
    for (const ch of clean) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
    if (out.length < 10) throw new Error('La clave del token es demasiado corta.');
    return new Uint8Array(out);
  }

  // ── Token con identificador (UUID) ──
  // La DGII muestra al activar el token un identificador tipo 123e4567-e89b-… (no una clave base32).
  // No se sabe cómo lo convierte la app en clave, así que se prueban interpretaciones habituales
  // contra un código real del celular («calibrar») y se guarda la que coincide:
  //   serp:<modo>:<algoritmo>:<periodo>:<dígitos>:<uuid>
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isUuid = v => UUID_RE.test(String(v || '').trim());
  const enc = t => new TextEncoder().encode(t);
  const hexBytes = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
  const KEY_MODES = {
    hexbytes: u => hexBytes(u.replace(/-/g, '')),
    text: u => enc(u.toLowerCase()), textup: u => enc(u.toUpperCase()),
    textnd: u => enc(u.replace(/-/g, '').toLowerCase()), textndup: u => enc(u.replace(/-/g, '').toUpperCase()),
  };
  const ALGS = { sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512' };
  function parseSpec(raw) {
    const m = /^serp:([a-z]+):(sha1|sha256|sha512):(\d{2,3}):(\d):([0-9a-f-]{36})$/i.exec(raw);
    if (!m || !KEY_MODES[m[1]] || !isUuid(m[5])) throw new Error('La clave del token no es válida.');
    return { key: KEY_MODES[m[1]](m[5]), period: +m[3], digits: +m[4], algorithm: ALGS[m[2]] };
  }

  // Acepta la clave en texto (JBSW Y3DP …) o el enlace del QR (otpauth://totp/…?secret=…&period=30&digits=6).
  function parse(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('Falta la clave del token.');
    if (/^serp:/i.test(raw)) return parseSpec(raw);
    let secret = raw, period = 30, digits = 6, algorithm = 'SHA-1';
    if (/^otpauth:\/\//i.test(raw)) {
      let u; try { u = new URL(raw); } catch (_) { throw new Error('El enlace otpauth no es válido.'); }
      secret = u.searchParams.get('secret') || '';
      const p = Number(u.searchParams.get('period')), d = Number(u.searchParams.get('digits')), a = (u.searchParams.get('algorithm') || '').toUpperCase();
      if (p >= 10 && p <= 120) period = p;
      if (d === 6 || d === 7 || d === 8) digits = d;
      if (a === 'SHA256') algorithm = 'SHA-256'; else if (a === 'SHA512') algorithm = 'SHA-512';
    }
    return { key: base32Decode(secret), period, digits, algorithm };
  }

  async function hotp(cfg, counter) {
    const cryptoObj = (typeof globalThis !== 'undefined' && globalThis.crypto) || require('crypto').webcrypto;
    const msg = new Uint8Array(8); let c = counter;
    for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
    const key = await cryptoObj.subtle.importKey('raw', cfg.key, { name: 'HMAC', hash: cfg.algorithm }, false, ['sign']);
    const h = new Uint8Array(await cryptoObj.subtle.sign('HMAC', key, msg));
    const o = h[h.length - 1] & 15;
    const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(bin % Math.pow(10, cfg.digits)).padStart(cfg.digits, '0');
  }

  // → { code, remaining (segundos que le quedan), period }
  async function generate(input, nowMs) {
    const cfg = typeof input === 'string' ? parse(input) : input;
    const t = Math.floor((nowMs == null ? Date.now() : nowMs) / 1000);
    return { code: await hotp(cfg, Math.floor(t / cfg.period)), remaining: cfg.period - (t % cfg.period), period: cfg.period };
  }
  const isValid = input => { try { parse(input); return true; } catch (_) { return false; } };
  // Busca qué interpretación del UUID produce el código que muestra la app ahora (±2 pasos).
  // → cadena «serp:…» lista para guardar, o null si ninguna coincide.
  async function calibrate(uuid, code, nowMs) {
    const u = String(uuid || '').trim().toLowerCase(); const c = String(code || '').replace(/\D/g, '');
    if (!isUuid(u) || c.length < 6 || c.length > 8) return null;
    const t = Math.floor((nowMs == null ? Date.now() : nowMs) / 1000);
    for (const mode of Object.keys(KEY_MODES)) for (const alg of Object.keys(ALGS)) for (const period of [30, 60]) {
      const cfg = { key: KEY_MODES[mode](u), period, digits: c.length, algorithm: ALGS[alg] };
      for (let d = -2; d <= 2; d++) {
        if (await hotp(cfg, Math.floor(t / period) + d) === c) return `serp:${mode}:${alg}:${period}:${c.length}:${u}`;
      }
    }
    return null;
  }
  return { base32Decode, parse, generate, isValid, isUuid, calibrate };
});
