// Local stand-in for the Supabase HTTP surface used by SERP, for tests only:
//   /rest/v1/*     → proxied to a real PostgREST over the local Postgres
//   /auth/v1/*     → password login + JWT verification against auth.users
//   /storage/v1/*  → private bucket emulation on disk with signed URLs
// Everything else in the stack (routes, SQL, RPCs) runs for real.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const b64url = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function sign(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}
function verify(token, secret) {
  const [head, body, sig] = String(token || '').split('.');
  if (!sig) return null;
  const expected = b64url(crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest());
  if (expected !== sig) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64').toString());
  if (payload.exp && payload.exp < Date.now() / 1000) return null;
  return payload;
}

function readBody(req) {
  return new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
}

async function start({ port, postgrestUrl, jwtSecret, dbUrl, storageDir }) {
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  fs.mkdirSync(storageDir, { recursive: true });
  const buckets = new Set();
  const signedTokens = new Map(); // token -> {bucket, path, mode, exp}
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
  const serviceOk = req => { const p = verify(String(req.headers.authorization || '').replace(/^Bearer /, ''), jwtSecret); return p?.role === 'service_role'; };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' });
        return res.end();
      }
      if (url.pathname.startsWith('/rest/v1')) {
        const body = await readBody(req);
        const target = postgrestUrl + url.pathname.replace('/rest/v1', '') + url.search;
        const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
        const r = await fetch(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
        const out = Buffer.from(await r.arrayBuffer());
        const h = {}; r.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) h[k] = v; });
        res.writeHead(r.status, h); return res.end(out);
      }
      if (url.pathname === '/auth/v1/token') {
        const { email, password } = JSON.parse((await readBody(req)).toString() || '{}');
        const { rows } = await db.query('select id, email from auth.users where lower(email) = lower($1) and encrypted_password = $2', [email, password]);
        if (!rows[0]) return json(res, 400, { error_description: 'Invalid login credentials' });
        const token = sign({ sub: rows[0].id, email: rows[0].email, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }, jwtSecret);
        return json(res, 200, { access_token: token, token_type: 'bearer', user: { id: rows[0].id, email: rows[0].email } });
      }
      if (url.pathname === '/auth/v1/user') {
        const payload = verify(String(req.headers.authorization || '').replace(/^Bearer /, ''), jwtSecret);
        if (!payload?.sub) return json(res, 401, { msg: 'invalid JWT' });
        const { rows } = await db.query('select id, email from auth.users where id = $1', [payload.sub]);
        if (!rows[0]) return json(res, 401, { msg: 'user not found' });
        return json(res, 200, { id: rows[0].id, email: rows[0].email, aud: 'authenticated', role: 'authenticated' });
      }
      if (url.pathname.startsWith('/auth/v1/admin/users')) {
        if (!serviceOk(req)) return json(res, 401, { msg: 'service role required' });
        if (req.method === 'GET') {
          const { rows } = await db.query('select id, email from auth.users');
          return json(res, 200, { users: rows, aud: 'authenticated' });
        }
        if (req.method === 'POST') {
          const { email, password } = JSON.parse((await readBody(req)).toString() || '{}');
          if (!email || !password) return json(res, 400, { msg: 'email y password requeridos' });
          const dup = await db.query('select 1 from auth.users where lower(email) = lower($1)', [email]);
          if (dup.rows[0]) return json(res, 422, { msg: 'A user with this email address has already been registered', error_code: 'email_exists' });
          const { rows } = await db.query('insert into auth.users (id, email, encrypted_password) values (gen_random_uuid(), $1, $2) returning id, email', [email, password]);
          return json(res, 200, { id: rows[0].id, email: rows[0].email, aud: 'authenticated', role: 'authenticated' });
        }
        if (req.method === 'DELETE') {
          const id = url.pathname.split('/').pop();
          await db.query('delete from auth.users where id = $1', [id]);
          return json(res, 200, {});
        }
        return json(res, 405, { msg: 'not implemented in test gateway' });
      }
      if (url.pathname.startsWith('/storage/v1/')) return storage(req, res, url);
      json(res, 404, { error: 'not found' });
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  });

  async function storage(req, res, url) {
    const rest = url.pathname.replace('/storage/v1', '');
    const filePath = (bucket, key) => path.join(storageDir, bucket, ...key.split('/').map(decodeURIComponent));
    let m;
    if (rest === '/bucket' && req.method === 'POST') {
      if (!serviceOk(req)) return json(res, 401, { message: 'unauthorized' });
      const { id } = JSON.parse((await readBody(req)).toString());
      if (buckets.has(id)) return json(res, 409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      buckets.add(id); fs.mkdirSync(path.join(storageDir, id), { recursive: true });
      return json(res, 200, { name: id });
    }
    if ((m = /^\/bucket\/([^/]+)$/.exec(rest)) && req.method === 'GET') {
      if (!serviceOk(req)) return json(res, 401, { message: 'unauthorized' });
      return buckets.has(m[1]) ? json(res, 200, { id: m[1], name: m[1], public: false }) : json(res, 404, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
    }
    if ((m = /^\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(rest))) {
      const [, bucket, key] = m;
      if (req.method === 'POST') {
        if (!serviceOk(req)) return json(res, 401, { message: 'unauthorized' });
        const token = crypto.randomBytes(16).toString('hex');
        signedTokens.set(token, { bucket, key: decodeURIComponent(key), mode: 'upload', exp: Date.now() + 7200e3 });
        return json(res, 200, { url: `/object/upload/sign/${bucket}/${key}?token=${token}` });
      }
      if (req.method === 'PUT') {
        const t = signedTokens.get(url.searchParams.get('token'));
        if (!t || t.mode !== 'upload' || t.exp < Date.now() || t.bucket !== bucket || t.key !== decodeURIComponent(key)) return json(res, 400, { message: 'invalid signature' });
        let body = await readBody(req);
        const type = String(req.headers['content-type'] || '');
        if (type.startsWith('multipart/form-data')) {
          // Take the file part (last part) from a FormData upload.
          const boundary = '--' + type.split('boundary=')[1];
          const parts = body.toString('latin1').split(boundary).filter(p => p.includes('\r\n\r\n'));
          const last = parts[parts.length - 1];
          body = Buffer.from(last.slice(last.indexOf('\r\n\r\n') + 4, last.lastIndexOf('\r\n')), 'latin1');
        }
        const target = filePath(bucket, t.key);
        if (fs.existsSync(target) && req.headers['x-upsert'] !== 'true') return json(res, 409, { message: 'The resource already exists' });
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body);
        signedTokens.delete(url.searchParams.get('token'));
        return json(res, 200, { Key: `${bucket}/${t.key}` });
      }
    }
    if ((m = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(rest))) {
      const [, bucket, key] = m;
      if (req.method === 'POST') {
        if (!serviceOk(req)) return json(res, 401, { message: 'unauthorized' });
        const { expiresIn } = JSON.parse((await readBody(req)).toString() || '{}');
        if (!fs.existsSync(filePath(bucket, key))) return json(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        const token = crypto.randomBytes(16).toString('hex');
        signedTokens.set(token, { bucket, key: decodeURIComponent(key), mode: 'download', exp: Date.now() + (expiresIn || 60) * 1000 });
        return json(res, 200, { signedURL: `/object/sign/${bucket}/${key}?token=${token}` });
      }
      if (req.method === 'GET') {
        const t = signedTokens.get(url.searchParams.get('token'));
        if (!t || t.mode !== 'download' || t.exp < Date.now() || t.key !== decodeURIComponent(key)) return json(res, 400, { message: 'invalid or expired signature' });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' });
        return res.end(fs.readFileSync(filePath(bucket, t.key)));
      }
    }
    if ((m = /^\/object\/([^/]+)\/(.+)$/.exec(rest)) && !rest.startsWith('/object/sign') && !rest.startsWith('/object/upload')) {
      if (!serviceOk(req)) return json(res, 401, { message: 'unauthorized' });
      const [, bucket, key] = m;
      if (req.method === 'GET') {
        const target = filePath(bucket, key);
        if (!fs.existsSync(target)) return json(res, 400, { statusCode: '404', message: 'Object not found' });
        res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(fs.readFileSync(target));
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const target = filePath(bucket, key);
        if (fs.existsSync(target) && req.method === 'POST' && req.headers['x-upsert'] !== 'true') return json(res, 400, { statusCode: '409', message: 'The resource already exists' });
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, await readBody(req));
        return json(res, 200, { Key: `${bucket}/${decodeURIComponent(key)}` });
      }
    }
    if ((m = /^\/object\/([^/]+)$/.exec(rest)) && req.method === 'DELETE') {
      if (!serviceOk(req)) return json(res, 401, { message: 'unauthorized' });
      const { prefixes } = JSON.parse((await readBody(req)).toString());
      const removed = [];
      for (const key of prefixes || []) { const target = filePath(m[1], key); if (fs.existsSync(target)) { fs.unlinkSync(target); removed.push({ name: key }); } }
      return json(res, 200, removed);
    }
    json(res, 404, { message: `storage route not emulated: ${req.method} ${rest}` });
  }

  await new Promise(resolve => server.listen(port, resolve));
  return { server, db, close: async () => { server.close(); await db.end(); } };
}

module.exports = { start, sign, verify };
