# NALA — flujo fiscal 606/607

NALA (Núcleo Automatizado de Listados Administrativos · CaSa Labs) convierte
facturas en formatos de envío DGII auditados:

**carga → extracción OCR/IA → validación → auditoría → aprobación → exportación 606/607**

La IA sólo transcribe lo impreso; todos los cálculos, códigos y reglas fiscales
los aplica el código (`lib/nala/validate.js`, reglas versionadas en
`lib/nala/rules.js`). Los montos usan decimales exactos (`lib/nala/money.js`):
un valor desconocido queda vacío, nunca se convierte en cero.

## Módulos

> **Moneda**: siempre DOP (`derive()` en `validate.js` la fija; la extracción, el guardado y el procesamiento de lotes escriben `moneda: 'DOP'`). No hay conversión por tasa ni avisos de moneda. La lista de auditoría muestra Subtotal/ITBIS/Total (`subtotal_dop`, `itbis_dop`, `total_dop`; subtotal = total − impuestos si aún no hay bienes/servicios).

> **Excel con listas**: `lib/nala/excel.js` escribe en el 606 las columnas Tipo Bienes y Servicios y Forma de Pago con el texto de la opción de la herramienta de la DGII (`TOOL_606_LISTS` en `formats.js`) y les aplica validación de lista contra la hoja oculta `Listas`; en el Excel oficial esas celdas se desbloquean (la hoja sigue protegida). El TXT conserva el código de 2 dígitos.
> El Excel oficial se reconstruye en cada descarga (`GET exports/:id/download?type=xlsx`) desde `snapshot`, no se sirve el archivo guardado; solo si la exportación no tiene snapshot se usa el de Storage.

> **Apertura**: Direct abre NALA con `window.open('/nala/index.html','serp-nala')` (pestaña nueva; si ya existe se enfoca). NALA detecta su *shell* con `NALA.host()` (padre del iframe o `window.opener`) para leer el token, renovarlo (`directRefresh`), pedir el envío a la DGII (`nala-open-dgii-envio`) y volver (`NALA.goBack()`). El iframe `#nala-frame` de `public/index.html` sigue como respaldo pero ya no se usa al abrir.

> **Eliminar un comprobante aprobado**: `POST invoices/:id/exclude` sobre un comprobante aprobado exige además el permiso `revert`; revierte la aprobación (mismas protecciones: no si está en una exportación enviada/aceptada; las generadas pasan a *superseded*) y lo excluye, todo en un paso y con evento en el historial.

> El **Asistente NALA (chat, IR-17)** está oculto temporalmente (sin entrada en el menú y su URL `#/asistente` redirige al panel). Para reactivarlo, quita el 7º valor `true` de su entrada en `NAV` (`public/nala/js/app.js`).

| Módulo | Qué hace |
|---|---|
| Panel de control | Indicadores del período (consolidado o por empresa), tendencia de 12 meses y empresas con pendientes. |
| Período global y «Todos» | La cabecera filtra por **empresa activa · período · formato**. El botón **«Todos»** junto al período quita el filtro de mes y muestra **todos los lotes y comprobantes de todos los períodos** (útil para ver lo que falta por corregir sin elegir fecha); el panel pasa a totales de todos los períodos y la exportación (por mes para la DGII) parte del mes anterior. |
| Dashboard por empresa | Lotes, pendientes, aprobadas, observaciones y exportaciones de la empresa activa. |
| Empresas clientes | Las mismas empresas de SERP (`direct_clients`); registro, edición, búsqueda y configuración contable (tipos por defecto, desglose bienes/servicios, régimen, cierre). |
| Consulta RNC | De quién es (razón social, nombre comercial), estado, actividad, régimen, facturador electrónico, aviso de Adecuación/Transformación (Consulta RNC de dgii.gov.do) y **antigüedad**: fecha de constitución o inicio de operaciones del archivo oficial `DGII_RNC.zip`. Estructura y dígito verificador se muestran aparte. Deudas, pagos y "al día" **no son públicos** (Código Tributario, art. 47): la pantalla lo explica en vez de suponerlos. |
| Carga masiva y lotes | JPG, PNG, PDF y ZIP (RAR se rechaza con aviso). Empresa, mes, año, formato y nombre. Originales en almacenamiento privado con huella SHA-256. Progreso, duración, reintentos y errores por documento. Cada lote se puede **renombrar** (botón ✏️ en la lista, `PATCH /api/nala/batches/:id`, permiso `upload`) o **eliminar** (🗑, permiso `reprocess`). |
| Auditoría fiscal | Vista por lote y vista unificada; original a la izquierda (zoom, rotación, páginas, y **«Aa Copiar texto»**: OCR en el navegador con `tesseract.js` fijado a 5.1.1 y SRI, idioma `spa` desde jsDelivr; el texto queda como una **capa transparente seleccionable sobre la imagen** (una línea por `div`, posicionada en % de la página con unidades `cqh` y ajustada al ancho de la línea; la caja `.viewer-page` mide lo que se ve, ya rotada) y como lista copiable por línea; requiere en la CSP `'wasm-unsafe-eval'` y `cdn.jsdelivr.net` en `connect-src`) y datos a la derecha en formulario u hoja; anterior/siguiente, deshacer, guardar, aprobar, revertir, reubicar, excluir; historial completo. **Edición en línea**: cada comprobante con observaciones trae un botón **✎ Corregir** que despliega bajo la fila solo los campos señalados por las reglas (revalidados en el servidor al guardar) y, si queda con cotejo verde, un botón **✓ Aprobar**; las copias repetidas ofrecen **Descartar esta copia**. Se abre el detalle completo solo para ver el documento. |
| Exportar DGII 606/607 | Abre con **«Listos para exportar»** (`GET /api/nala/export-ready`): por empresa, formato y período, comprobantes aprobados, si la auditoría está completa (aprobados > 0 y ninguno pendiente) y el último archivo del mes. **TXT** / **Excel** con un clic: previsualiza, reutiliza el último archivo si la huella no cambió o genera uno nuevo (errores críticos bloquean; las advertencias se aceptan una por una con motivo) y descarga. TXT y Excel salen de la misma instantánea; seguimiento generado → enviado → aceptado/rechazado. |
| Equipo y oficiales | Roles (supervisor, oficial —puede aprobar, editar y revertir aprobaciones—, auditor, sólo lectura), empresas asignadas y ajustes de permisos; validados en el servidor. |
| Configuración | Integraciones, límites, tolerancia de conciliación, retención documental y plantillas de Excel personalizado. |
| Asistente NALA | El chat contable y la lectura rápida 606/607/IR-17 existentes, sin cambios (`public/nala/asistente.html`). |

## Estimación Fiscal toma el 606/607 de NALA

Estimación Fiscal consulta `GET /api/ir2/resumen?…&fuente=nala` (código en `lib/nala/fiscal-summary.js`) y muestra, por empresa y año, lo **aprobado** en NALA: compras 606 por tipo de gasto (alimenta Gastos NCF y el Anexo J) y el 606/607 mensual con estado de auditoría y último archivo/referencia. Los comprobantes pendientes o excluidos **no** suman. La empresa se enlaza por RNC o cédula.

## Envío a la DGII (después del TXT)

Según el instructivo oficial de la DGII (feb. 2026): el TXT se envía por la Oficina
Virtual → **Enviar Archivos** → *Tipo Información* (p. ej. «606 - COMPRAS DE BIENES Y
SERVICIOS») → *Período* AAAAMM → **Continuar** → **Examinar** → **Enviar Datos**. La OFV
responde «El archivo ha sido recibido para validación» con el **Número Referencia**
(se registra en NALA). La validación tarda ~30 minutos; el resultado se ve en
**Consultas → Consulta Envíos 606** (*Estatus Validación*: Recibido, En proceso,
Completado, Error; «Ver Resumen» da los totales y el *Detalle Validación* las líneas con
error). Si el último archivo queda *CARGADO-COMPLETADO* se toma como el válido; una
rectificativa reemplaza al anterior. Sin operaciones en el período, los formatos
606/607/608 se remiten de forma informativa en *Declaraciones en cero*.

**Informativo en cero.** Para un período sin operaciones, *Exportar → Informativo en cero*
guía el trámite (OFV → Declaraciones Juradas → **Declaraciones en Cero** → *Formato o
Impuesto* → *Período* → **Presentar Declaración y/o Formato**) y guarda el código de
referencia («El formato ha sido presentado satisfactoriamente con el código de
referencia: …»). API: `GET/POST /api/nala/zero-filings` (permiso `submit` para registrar).
Se guarda como evento inmutable `zero_filed` (entidad `client`, sin migración). Se
rechaza (409) si el período tiene comprobantes **aprobados** o **sin aprobar** en ese
formato (606/607; el 608 no se maneja en NALA) y si el código ya estaba registrado.

NALA recoge esto así: la guía de la exportación lleva esos pasos; mientras está
*enviada* muestra el cuadre de totales contra «Ver Resumen»; y al registrar un rechazo
ofrece las alertas de la DGII con su acción a tomar. El límite de 10.000 registros por
archivo ya se valida al exportar (`EXCEDE_MAXIMO`).

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
  (`rnc-dgii.js`) y padrón oficial descargable (`rnc-registry.js`),
  auto-completado de la contraparte (`counterparty.js`), almacenamiento privado
  (`storage.js`), cola de trabajos (`pipeline.js`) y rutas (`lib/nala/api/*`).

### Progreso del lote (monótono)

`lib/nala/progress.js` (`batchProgress(documents, jobs)`) calcula el avance
**ponderado por documento**, no por trabajo: el número de trabajos no se conoce
al inicio (un PDF/ZIP sólo se parte en sus `extract`/documentos hijo cuando corre
su `prepare`), así que medir `hechos/totales` hacía retroceder la barra. Cada
documento «hoja» (los ZIP son contenedores y cuentan sus hijos) aporta una
fracción que sólo sube: terminado = 1; en curso = trabajos hechos ÷ trabajos
conocidos. `api/batches.js` lo expone en `progress` (con `docs_total`/`docs_done`)
y el frontend además aplica un **piso por lote** para que la barra nunca baje
mientras procesa. Con pruebas unitarias en `tests/nala/unit.test.js`.

### Auto-completado de la contraparte (lectura por lotes)

Al leer cada factura, la IA a veces trae sólo el nombre de la contraparte
(proveedor en 606, cliente en 607) o sólo su RNC/cédula. `counterparty.js`
rellena el que falte, **sin pisar campos corregidos a mano** y sólo sobre vacíos:

1. **RNC válido (9/11 dígitos) y nombre vacío** → nombre oficial del padrón de la
   DGII (`rnc-registry.find`, en memoria tras la primera descarga).
2. **Nombre presente y RNC vacío** → RNC de una contraparte ya vista de la misma
   empresa. `pipeline.js` arma un directorio `nombre normalizado → RNC` con el
   historial del cliente (`counterpartDirectory`, una sola consulta por trabajo);
   nunca asigna el RNC de la propia empresa del lote.

Corre en `extract` (lecturas nuevas) y en `revalidate` (pulsar **«Revalidar»**
completa lo ya cargado sin volver a llamar a la IA). La comparación de nombres se
normaliza (mayúsculas, sin acentos ni puntuación). Si el padrón no está
disponible, la lectura continúa igual.
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
   | `NALA_OCR_TESSERACT` | `1`/`true` activa un OCR previo con Tesseract (`tesseract.js`, WASM) que se envía al modelo como texto de referencia para cotejar montos/NCF/RNC. Apagado por defecto; experimental. | opcional |
   | `NALA_OCR_LANGS` | idiomas del OCR (por defecto `spa+eng`) | opcional |

   El OCR es un **apoyo**, no un motor aparte: corre **sólo en el Asistente**
   (`/api/nala/analyze`, al soltar fotos o páginas de PDF escaneadas) — en el
   procesamiento por lotes se desactivó porque el OCR por página es muy pesado
   para el presupuesto por trabajo del worker. Sólo sobre páginas-imagen, le da al modelo
   de visión una capa de texto para no dejar vacíos los números difíciles, y la
   imagen sigue mandando. Nunca interrumpe la lectura (si falla, se ignora). Baja
   los datos de idioma a `/tmp` en el primer uso, así que la primera lectura tras
   un arranque en frío tarda unos segundos más. `extraction_meta.ocr` indica si se usó.

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

5. **Límite de tamaño por archivo**: por defecto **100 MB** (configurable por
   tenant entre 1 y 100 MB en *Configuración → Límites*). Requiere que el
   **Global file size limit** de Supabase Storage (Project Settings → Storage)
   sea ≥ 100 MB (ya configurado a 150 MB en plan **Pro**); el bucket
   `nala-documents` (`fileSizeLimit` 100 MB) y la validación del API se mantienen
   alineados. La subida es directa a Supabase con URL firmada, así que un archivo
   que supere el límite global es rechazado por el almacenamiento (el navegador
   lo muestra como “Error de red”): si se vuelve a topar, subir el límite global.
   Para pasar de 100 MB, elevar ese límite global y, en el código, el
   default/bounds (`lib/nala/settings.js`), el tope del API
   (`lib/nala/api/batches.js`) y el `fileSizeLimit` del bucket.

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
  duplicar, control de versión (sin bloqueo de edición), aprobación con advertencias, reubicación,
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
