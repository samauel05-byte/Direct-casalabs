// Almacenamiento privado de documentos de nómina (recibos firmados, soportes de
// pago, expediente del empleado) en Supabase Storage. El navegador nunca recibe
// credenciales: la carga la hace el servidor y la descarga usa enlaces firmados
// de corta duración emitidos tras verificar permisos y pertenencia (tenant).
const supabase = require('../supabase');

const BUCKET = process.env.NOMINA_STORAGE_BUCKET || 'nomina-docs';
let bucketReady = false;

async function ensureBucket() {
  if (bucketReady) return;
  const { error } = await supabase.storage.getBucket(BUCKET);
  if (error) {
    const { error: createError } = await supabase.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 25 * 1024 * 1024 });
    if (createError && !/exist/i.test(createError.message || '')) throw new Error(`No se pudo preparar el almacenamiento: ${createError.message}`);
  }
  bucketReady = true;
}

async function upload(path, buffer, contentType) {
  await ensureBucket();
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType, upsert: false });
  if (error) throw new Error(`No se pudo guardar el archivo: ${error.message}`);
}

async function signedDownload(path, seconds = 300, downloadName = null) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, seconds, downloadName ? { download: downloadName } : undefined);
  if (error) throw new Error(`No se pudo generar el enlace temporal: ${error.message}`);
  return data.signedUrl;
}

async function remove(paths) {
  if (!paths.length) return;
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) throw new Error(`No se pudo eliminar del almacenamiento: ${error.message}`);
}

module.exports = { BUCKET, ensureBucket, upload, signedDownload, remove };
