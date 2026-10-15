# NALA — flujo fiscal 606/607

NALA (Núcleo Automatizado de Listados Administrativos · CaSa Labs) convierte
facturas en formatos de envío DGII auditados:

**carga → extracción OCR/IA → validación → auditoría → aprobación → exportación 606/607**

La IA sólo transcribe lo impreso; todos los cálculos, códigos y reglas fiscales
los aplica el código (`lib/nala/validate.js`, reglas versionadas en
`lib/nala/rules.js`). Los montos usan decimales exactos (`lib/nala/money.js`):
un valor desconocido queda vacío, nunca se convierte en cero.

## Módulos

| Módulo | Qué hace |
|---|---|
| Panel de control | Indicadores del período (consolidado o por empresa), tendencia de 12 meses y empresas con pendientes. |
| Dashboard por empresa | Lotes, pendientes, aprobadas, observaciones y exportaciones de la empresa activa. |
| Empresas clientes | Las mismas empresas de SERP (`direct_clients`); registro, edición, búsqueda y configuración contable (tipos por defecto, desglose bienes/servicios, régimen, cierre). |
| Consulta RNC | De quién es (razón social, nombre comercial), estado, actividad, régimen, facturador electrónico, aviso de Adecuación/Transformación (Consulta RNC de dgii.gov.do) y **antigüedad**: fecha de constitución o inicio de operaciones del archivo oficial `DGII_RNC.zip`. Estructura y dígito verificador se muestran aparte. Deudas, pagos y "al día" **no son públicos** (Código Tributario, art. 47): la pantalla lo explica en vez de suponerlos. |
| Carga masiva y lotes | JPG, PNG, PDF y ZIP (RAR se rechaza con aviso). Empresa, mes, año, formato y nombre. Originales en almacenamiento privado con huella SHA-256. Progreso, duración, reintentos y errores por documento. |
| Auditoría fiscal | Vista por lote y vista unificada; original a la izquierda (zoom, rotación, páginas) y datos a la derecha en formulario u hoja; anterior/siguiente, deshacer, guardar, aprobar, revertir, reubicar, excluir; historial completo. |
| Exportar DGII 606/607 | Por empresa y período, consolidado o por lotes. Vista previa con errores y advertencias; TXT y Excel desde la misma instantánea; seguimiento generado → enviado → aceptado/rechazado. |
| Equipo y oficiales | Roles (supervisor, oficial, auditor, sólo lectura), empresas asignadas y ajustes de permisos; validados en el servidor. |
| Configuración | Integraciones, límites, tolerancia de conciliación, retención documental y plantillas de Excel personalizado. |
| Asistente NALA | El chat contable y la lectura rápida 606/607/IR-17 existentes, sin cambios (`public/nala/asistente.html`). |

## Facturas repetidas

- **Mismo archivo otra vez** (misma huella SHA-256, en cualquier lote de la
  empresa operadora): no se sube ni se vuelve a leer. El usuario ve al instante
  *"Esta factura ya fue cargada el 05/08/2026 en el lote «Compras agosto»
  (Cliente Uno SRL, 606 08/2026). Comprobantes: B0100000101 aprobada. No se
  vuelve a leer."* Lo mismo para copias dentro de un ZIP.
- **Misma factura en otro archivo** (mismo NCF y contraparte, por ejemplo
  escaneada de nuevo): la copia posterior queda bloqueada con *"Esta factura ya
  fue procesada: el NCF … está aprobada el … en el lote … y exportada en …"*;
  no se puede aprobar. La original no se bloquea. El lote muestra un aviso con
  el botón **Descartar repetidas** y la auditoría el botón **Descartar esta
  copia**; cada descarte queda en el historial.

## Arquitectura

- `api/nala.js` — único punto de entrada (Vercel Hobby admite 12 funciones y SERP
  ya usaba 12). `vercel.json` reescribe `/api/nala/<ruta>` → `/api/nala?route=<ruta>`.
  `/api/nala/analyze` y `/api/nala/chat` siguen respondiendo con los manejadores
  originales, renombrados a `api/nala/_analyze.js` y `api/nala/_chat.js` **sin
  cambiar su contenido** (el guion bajo evita que cuenten como función).
- `lib/nala/` — contexto y permisos, validación, formatos, Excel, extracción
  (`extractor.js`, OpenAI con `OPENAI_API_KEY` del servidor), Consulta RNC
  (`rnc-dgii.js`), almacenamiento privado (`storage.js`), cola de trabajos
  (`pipeline.js`) y rutas (`lib/nala/api/*`).
- `supabase/migrations/202609300001_nala_fiscal_pipeline.sql` — tablas `nala_*`,
  funciones `nala_claim_jobs`, `nala_finish_job`, `nala_refresh_batch` y
  `nala_stats`, RLS cerrada al navegador y bucket privado `nala-documents`.

### Datos y permisos

- El tenant sale siempre del perfil autenticado; cada consulta filtra por él y
  las claves foráneas compuestas `(tenant_id, client_id)` impiden mezclar empresas.
- Cada ruta valida el permiso y la empresa asignada, también en enlaces directos
  (factura, documento, exportación); fuera de alcance responde 404.
- Los originales se sirven sólo con enlaces firmados de 5 minutos; las cargas
  usan enlaces firmados de subida emitidos tras validar el permiso.
- Los secretos (OpenAI, rol de servicio, worker) viven sólo en el servidor.
- `nala_events` es inmutable (trigger) y guarda cargas, extracciones,
  correcciones campo a campo, aprobaciones con motivo, reversiones,
  reubicaciones, exclusiones, exportaciones y cambios de estado.
- Todos los indicadores salen de la función SQL `nala_stats`, por eso coinciden
  entre panel, dashboard, lotes, auditoría y exportación.

### Trabajos persistentes

1. Al iniciar un lote se crea un trabajo `prepare` por archivo: verifica la
   huella, detecta archivos repetidos, expande ZIP (límite de tamaño y de
   cantidad; ZIP anidados y RAR se marcan "no admitido") y divide PDF en grupos
   de páginas.
2. Cada grupo es un trabajo `extract`: envía las páginas (imagen o PDF, sirve
   para escaneados) al modelo con un esquema JSON estricto. Admite varias
   facturas por página y una factura en varias páginas.
3. Los trabajos se reclaman con `FOR UPDATE SKIP LOCKED` y un arrendamiento de
   120 s; si un proceso cae, el trabajo se recupera al vencer el arrendamiento.
   Reintentos limitados (configurable) con espera exponencial; los errores no
   recuperables fallan de inmediato con su motivo.
4. Idempotencia: los lotes aceptan `idempotency_key`; cada factura tiene una
   clave `documento:página:índice`, así reprocesar no duplica, conserva los
   campos corregidos por personas y no toca facturas aprobadas o excluidas.

Los trabajos avanzan:
- mientras haya una pestaña de NALA abierta (llama a `POST /api/nala/jobs/tick`);
- con el worker programado (`/api/nala/jobs/worker`, protegido por
  `NALA_WORKER_SECRET`), recomendado cada minuto con `pg_cron` (abajo);
- y con la recuperación diaria de Vercel Cron (`vercel.json`, usa `CRON_SECRET`).

## Puesta en marcha

1. **Migración**: aplicar `supabase/migrations/202609300001_nala_fiscal_pipeline.sql`
   en el proyecto Supabase de SERP (SQL Editor o `supabase db push`). Es aditiva
   e idempotente: no modifica datos existentes.
2. **Variables de entorno en Vercel** (servidor):

   | Variable | Uso | Estado |
   |---|---|---|
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | ya usadas por SERP | existentes |
   | `OPENAI_API_KEY` | extracción (la misma que usa el asistente) | existente |
   | `NALA_WORKER_SECRET` | autoriza el worker programado (≥ 16 caracteres) | **nueva, opcional pero recomendada** |
   | `CRON_SECRET` | autoriza la recuperación diaria de Vercel Cron | **nueva, opcional** |
   | `NALA_OPENAI_MODEL` | modelo de extracción (por defecto `gpt-4o`) | opcional |
   | `NALA_STORAGE_BUCKET` | bucket privado (por defecto `nala-documents`) | opcional |

3. **Worker cada minuto (recomendado)** — en Supabase, con las extensiones
   `pg_cron` y `pg_net` activas y el secreto guardado en Vault:

   ```sql
   select vault.create_secret('<NALA_WORKER_SECRET>', 'nala_worker_secret');
   select cron.schedule('nala-worker', '* * * * *', $$
     select net.http_post(
       url := 'https://app.casalabs.com.do/api/nala/jobs/worker',
       headers := jsonb_build_object('Authorization', 'Bearer ' ||
         (select decrypted_secret from vault.decrypted_secrets where name = 'nala_worker_secret')),
       timeout_milliseconds := 60000);
   $$);
   ```

4. **Permisos**: los administradores tienen acceso total. Los usuarios con la
   casilla NALA trabajan como *oficial* sobre todas las empresas hasta que se les
   asigne rol y empresas en *Equipo y oficiales*.
   - La sección **Administración** del menú (*Equipo y oficiales* y
     *Configuración*) sólo aparece para quien tenga los permisos `team_manage`
     y `settings_manage` respectivamente; un rol de digitación no los ve ni
     puede entrar por URL directa (se redirige al panel). El servidor valida
     igualmente cada ruta.

5. **Límite de tamaño por archivo**: por defecto **50 MB** (configurable por
   tenant entre 1 y 50 MB en *Configuración → Límites*). El tope real lo impone
   el **límite global de subida de Supabase Storage**, que en plan **Free no
   puede pasar de 50 MB**; el bucket `nala-documents` y la validación del API se
   mantienen alineados a ese valor. Para permitir hasta 100 MB hay que estar en
   plan **Pro** y subir el *Global file size limit* a 100 MB
   (Project Settings → Storage); luego se elevan en el código el default/bounds,
   el tope del API (`lib/nala/api/batches.js`) y el `fileSizeLimit` del bucket.
   La subida es directa a Supabase con URL firmada, así que un archivo que supere
   el límite global es rechazado por el almacenamiento (el navegador lo muestra
   como “Error de red”).

## Pruebas

```bash
npm install
npm run test:nala
```

- `tests/nala/unit.test.js` — decimales, RNC/cédula/NCF, validación, TXT 606/607
  contra el formato de la macro oficial, Excel (texto vs. números, mismo orden).
- `tests/nala/flow.test.js` — flujo completo por API sobre Postgres + PostgREST
  reales: permisos y aislamiento entre empresas operadoras, idempotencia,
  ZIP/PDF/RAR/duplicados, reintentos, recuperación de trabajos, reproceso sin
  duplicar, bloqueo y versión, aprobación con advertencias, reubicación,
  reversión, conciliación de indicadores, exportación 606/607, descarga de TXT
  y Excel, estados de envío y rutas existentes de SERP.
- `tests/nala/ui.test.js` — Chromium: carga, procesamiento, auditoría, aprobación
  y exportación desde la interfaz.

Las pruebas usan Postgres 16 local, PostgREST, un emulador de Auth/Storage de
Supabase (`tests/nala/support/fake-supabase.js`) y un sustituto de la API de
OpenAI que devuelve extracciones fijas para facturas sintéticas generadas en
la prueba (`tests/nala/support/fake-openai.js`). Esos sustitutos existen sólo
en `tests/`; el producto llama a los servicios reales.

`npm run nala:local` levanta el mismo entorno para usarlo en el navegador
(`http://127.0.0.1:54380/nala/index.html`).

## Estado en producción (01/10/2026)

- **Migración**: aplicada en el proyecto Supabase de SERP; los datos existentes
  quedaron intactos. Las funciones `nala_*` sólo las ejecuta el rol de servicio.
- **Secretos**: `NALA_WORKER_SECRET` y `CRON_SECRET` creados en Vercel
  (producción y preview); el secreto del worker también está en Supabase Vault.
- **Worker**: `pg_cron` (`nala-worker`) llama cada minuto a
  `https://app.casalabs.com.do/api/nala/jobs/worker`; responde 401 sin secreto y
  200 con él. Vercel Cron hace además la recuperación diaria.

## Pendiente de verificar

- **Extracción con OpenAI real**: la integración (visión + PDF, esquema JSON
  estricto) usa la misma `OPENAI_API_KEY` del asistente y está probada con un
  sustituto del contrato de la API. Falta revisar en Auditoría el primer lote
  real (se recomienda empezar con 3–5 facturas).
- **Envío a la DGII**: la Oficina Virtual no tiene API pública; el envío y su
  resultado se registran manualmente en NALA.
