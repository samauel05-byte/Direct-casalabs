// Private document storage (Supabase Storage). The browser never receives
// credentials: uploads and downloads use short-lived signed URLs issued after
// a permission check.
const supabase = require('../supabase');

const BUCKET = process.env.NALA_STORAGE_BUCKET || 'nala-documents';
let bucketReady = false;

async function ensureBucket() {
  if (bucketReady) return;
  const { error } = await supabase.storage.getBucket(BUCKET);
  if (error) {
    const { error: createError } = await supabase.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 50 * 1024 * 1024 });
    if (createError && !/exist/i.test(createError.message || '')) throw new Error(`No se pudo preparar el almacenamiento privado: ${createError.message}`);
  }
  bucketReady = true;
}

async function signedUpload(path) {
  await ensureBucket();
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw new Error(`No se pudo firmar la carga: ${error.message}`);
  return data.signedUrl;
}

async function signedDownload(path, seconds = 300, downloadName = null) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, seconds, downloadName ? { download: downloadName } : undefined);
  if (error) throw new Error(`No se pudo generar el enlace temporal: ${error.message}`);
  return data.signedUrl;
}

async function download(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw new Error(`No se pudo leer el archivo original: ${error.message || 'no encontrado'}`);
  return Buffer.from(await data.arrayBuffer());
}

async function upload(path, buffer, contentType) {
  await ensureBucket();
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`No se pudo guardar el archivo: ${error.message}`);
}

async function remove(paths) {
  if (!paths.length) return;
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) throw new Error(`No se pudo eliminar del almacenamiento: ${error.message}`);
}

module.exports = { BUCKET, ensureBucket, signedUpload, signedDownload, download, upload, remove };
