# Monitor DGII — entrega

Módulo nuevo dentro de Direct para consultar la **disponibilidad de los
servicios de facturación electrónica (e-CF) de la DGII**, con comprobaciones
automáticas cada minuto desde el servidor, historial de incidentes y alertas por
correo. Se integró al menú, la navegación, la autenticación y los permisos
existentes de Direct, sin tocar los módulos ni los datos actuales.

## 1. Qué comprueba y por qué es seguro

La comprobación es la **“Obtención de semilla de autenticación”** del flujo e-CF:
un `GET` de **solo lectura**, **sin certificado** y **sin credenciales**, que **no
genera ninguna transacción fiscal**. Se valida el código HTTP **y** el contenido
(que la respuesta sea el XML `<SemillaModel>` con `<valor>`).

Solo se muestra como verificado lo que el monitor probó. El panel lo deja claro:

> *Monitor independiente de Direct. El estado refleja las comprobaciones indicadas
> y no garantiza el funcionamiento de todos los servicios de la DGII.*

No se comprueba `validarsemilla` (requiere **certificado digital** del
contribuyente). Queda documentado como requisito: si en el futuro se quisiera
comprobar la obtención de token, habría que firmar la semilla con un certificado,
usando el mecanismo seguro de Direct (cifrado en el navegador); **nunca** se
expondrían claves privadas, tokens ni certificados.

### Fuente oficial de los endpoints

DGII — **“Descripción Técnica de Facturación Electrónica” v1.5 (mayo 2023)**.
Base por ambiente: `https://ecf.dgii.gov.do/{ambiente}/autenticacion`

| Ambiente | Clave | Semilla (GET, lo que comprueba el monitor) |
|---|---|---|
| Pruebas (TesteCF) | `testecf` | `https://ecf.dgii.gov.do/testecf/autenticacion/api/autenticacion/semilla` |
| Certificación (CerteCF) | `certecf` | `https://ecf.dgii.gov.do/certecf/autenticacion/api/autenticacion/semilla` |
| Producción (eCF) | `ecf` | `https://ecf.dgii.gov.do/ecf/autenticacion/api/autenticacion/semilla` |

Además se comprueba el **subsistema oficial de estatus e-CF** de la DGII:

| Servicio | Clave | Endpoint (GET, lo que comprueba el monitor) |
|---|---|---|
| Estatus e-CF (statusecf) | `statusecf_subsistema` | `https://statusecf.dgii.gov.do/api-docs/v1/definition.json` |

Esta comprobación (`check_type = http`) solo verifica que el subsistema esté
**en línea** (código 2xx). El **estado detallado por servicio** lo ofrece la
API `statusecf` (`/api/EstatusServicios/ObtenerEstatus`, `VerificarEstado`,
`ObtenerVentanasMantenimiento`), pero esos endpoints exigen una **ApiKey emitida
por la DGII** (`Authorization: ApiKey {key}`). Cuando se disponga de ella se
puede añadir como secreto y activar para cubrir todos los servicios e-CF y las
ventanas de mantenimiento.

Otros portales (p. ej. `www.dgii.gov.do`) responden **403 a peticiones desde
servidores/datacenter**, por lo que no son fuentes fiables de estado y no se
monitorean (darían un “fallo” falso permanente).

Los destinos están restringidos por una **allowlist** en el servidor
(`lib/monitor/endpoints.js`): solo `https` a los hosts oficiales
`ecf.dgii.gov.do` y `statusecf.dgii.gov.do`. La configuración referencia los
endpoints por clave, nunca por URL libre, para que no se puedan apuntar
comprobaciones a redes internas ni a terceros.

## 2. Cómo está hecho

- **Base de datos** (Supabase, proyecto `Nala`): migración
  `supabase/migrations/202610140001_dgii_monitor.sql` — tablas
  `dgii_monitor_checks`, `dgii_monitor_results`, `dgii_monitor_incidents`,
  `dgii_monitor_daily`, `dgii_monitor_subscriptions`, `dgii_monitor_notifications`,
  `dgii_monitor_runner`, `dgii_monitor_settings`; índices; función de retención
  `dgii_monitor_prune`; RLS **deny-all** (solo el service role accede); y las 3
  comprobaciones por defecto (una por ambiente). **Aplicada** al proyecto.
- **Lógica** (`lib/monitor/`): `endpoints.js` (allowlist oficial), `check.js`
  (comprobación + clasificación + validación de semilla + saneo), `incidents.js`
  (máquina de incidentes y métricas puras), `store.js` (resultados, incidentes,
  resumen diario, agregados, single-flight), `alerts.js` (notificaciones + envío).
- **API** (`api/monitor.js`, reescrita por `vercel.json`):
  `GET /api/monitor/status`, `GET /api/monitor/day`, `GET /api/monitor/admin`,
  `POST /api/monitor/config|check|subscriptions`, `POST /api/monitor/cron`.
- **Panel** (`public/monitor/index.html`) con **4 vistas**: **Resumen** (selector
  de ambiente, resumen general que no se pinta verde si hay servicios sin
  comprobar/sin datos recientes/con incidentes, tarjetas de estado/última
  comprobación/tiempo/disponibilidad 24h/incidentes activos, y por servicio:
  disponibilidad+cobertura 24h/7d/30d/90d, barras diarias de 90 días, gráfico de
  tiempos, incidentes); **Incidentes** (tabla filtrable, clic → cronología del
  día); **Verificaciones** (registro paginado y filtrable, distingue Programada /
  Manual); **Configuración** (solo admin). Lee solo datos guardados (no llama a la
  DGII por visita). Color + icono + texto.
- **Respaldo del scheduler (pg_cron de Supabase)**: un job `monitor-dgii` de
  `pg_cron`/`pg_net` llama cada minuto a `/api/monitor/cron` con la cabecera
  `x-monitor-secret`, leyendo el valor del Vault (`monitor_cron_secret`, el mismo
  `MONITOR_CRON_SECRET` de Vercel). Es independiente de Cloudflare: si el Worker
  deja de disparar (pasó el 15/10/2026), el monitor sigue comprobando. Conviven
  los dos; el endpoint evita comprobaciones duplicadas. Alta (una sola vez):
  `select vault.create_secret('<MONITOR_CRON_SECRET>', 'monitor_cron_secret');` y
  `select cron.schedule('monitor-dgii', '* * * * *', $$ select net.http_post(url := 'https://app.casalabs.com.do/api/monitor/cron', headers := jsonb_build_object('x-monitor-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'monitor_cron_secret'), 'Content-Type', 'application/json'), timeout_milliseconds := 30000); $$);`
- **Scheduler** (`worker.js` + `wrangler.toml`): el Cloudflare Worker ejecuta un
  cron `* * * * *` (1 minuto) que llama a `/api/monitor/cron` con un secreto.
  Independiente del navegador.
- **Integración Direct** (`public/index.html`): entrada “Monitor DGII” en el menú
  de herramientas, vista con iframe, apertura con token de sesión y handshake.

## 3. Estados y umbrales

Operativo · Degradado (supera el umbral de lentitud) · Sin respuesta/Respuesta
inválida · Sin datos · Sin datos recientes · Pausado. Un fallo aislado **no** se
presenta como caída general. Umbrales configurables por el administrador; por
defecto: incidente tras **2 fallos** consecutivos, cierre tras **2 respuestas
válidas** consecutivas, lentitud **3000 ms**, timeout **10000 ms**. Todos los
resultados individuales se conservan aunque no se haya abierto incidente.

Fechas en **UTC** en la base; se muestran en **America/Santo_Domingo**.

## 4. Métricas

- **Disponibilidad** = comprobaciones válidas / ejecutadas × 100. Una respuesta
  lenta pero válida cuenta como disponible y además se marca como degradada.
- **Cobertura** = ejecutadas / esperadas durante el período activo (desde la
  puesta en marcha). Los períodos sin monitoreo aparecen como **“Sin datos”**; no
  cuentan como disponibilidad ni como caída. No se muestra historial anterior a la
  puesta en marcha. Con pocas comprobaciones se muestra **“Sin datos suficientes”**
  (umbral configurable `min_observations`) en vez de un porcentaje engañoso.
- **Una sola observación por intervalo programado**: las métricas y los incidentes
  usan únicamente las comprobaciones **programadas** (`source='auto'`). Las
  **manuales** del administrador y los **reintentos** quedan en el registro de
  verificaciones para diagnóstico, pero **no alteran** los porcentajes ni abren
  incidentes. En una comprobación programada que falla por un error transitorio
  (timeout/DNS/TLS/red) se hace **un reintento controlado** y se guarda solo el
  resultado final (una observación por intervalo).

## 5. Permisos y aislamiento

- **Usuarios autorizados**: consultan estado e historial (el estado del servicio
  es general y se comparte).
- **Administradores**: configurar, pausar, verificación manual (con límite de
  frecuencia) y administrar alertas.
- **Privado por firma (tenant)**: destinatarios de alertas y registro de
  notificaciones. Errores y respuestas se **sanean** antes de guardar/mostrar.
- **Auditoría**: cada cambio de configuración (pausar/reanudar, umbrales, ajustes
  globales, suscripciones, verificación manual, prueba de correo) se registra con
  **quién y cuándo** (`dgii_monitor_audit`), visible en la vista de Configuración.

## 6. Variables de entorno

| Variable | Dónde | Necesaria para | Estado |
|---|---|---|---|
| `MONITOR_CRON_SECRET` | Vercel **y** Cloudflare Worker | Autorizar al scheduler a llamar `/api/monitor/cron` | Configurada en Vercel; en el Worker va como **secreto** (persiste entre redespliegues) |
| `MONITOR_APP_URL` | Cloudflare Worker | URL base de Direct que llama el cron | **Fijada en `wrangler.toml` (`[vars]`)** = `https://app.casalabs.com.do`; así sobrevive a los redespliegues del Worker |
| `MONITOR_SMTP_HOST`, `MONITOR_SMTP_PORT`, `MONITOR_SMTP_USER`, `MONITOR_SMTP_PASS`, `MONITOR_ALERT_FROM` | Vercel | **Enviar alertas por SMTP desde tu buzón** (recomendado). Puerto 465 (SSL) o 587 (STARTTLS). | **Pendiente** (sin esto, los avisos se registran pero no se envían) |
| `MONITOR_RESEND_API_KEY` + `MONITOR_ALERT_FROM` | Vercel | Alternativa de envío por Resend (HTTPS) si no se usa SMTP | Opcional |
| `MONITOR_HEARTBEAT_URL` | Vercel | Dead-man switch externo para detectar que el monitor se detuvo | **Pendiente** (sin esto, la alerta “monitor detenido” no está disponible) |
| `CRON_SECRET` | Vercel | Solo si además se quiere activar un cron de Vercel (plan Pro); el endpoint también acepta `Authorization: Bearer CRON_SECRET` | Opcional |

> **IMAP vs SMTP:** IMAP sirve para *leer* correo; para *enviar* las alertas se usa
> **SMTP** del mismo buzón. Casi todos los proveedores ofrecen ambos (p. ej. Gmail:
> `smtp.gmail.com:465` con una *contraseña de aplicación*; Outlook/Office365:
> `smtp.office365.com:587`). La contraseña del buzón se guarda **cifrada** en
> Vercel (nunca en el navegador ni en el repo).

> `MONITOR_CRON_SECRET` ya quedó en Vercel: `lBFWpzJDAnIAXW4e-qkZaRJmaJkgMw0o`.
> Toma efecto en el próximo despliegue de producción.

## 7. Activar el proceso programado (pendiente de tu lado)

Tu **Cloudflare Worker `portal-rd-relay` ya se despliega solo desde Git** (Workers
Builds): cada push lo redepliega, y el cron `* * * * *` y la variable
`MONITOR_APP_URL` vienen de `wrangler.toml`, así que se aplican solos al fusionar
a `main` y **sobreviven a los redespliegues**. Solo falta **1 secreto** en el
panel de Cloudflare (no hay acceso a tu cuenta desde aquí):

1. Cloudflare dashboard → **Workers & Pages** → `portal-rd-relay` → **Settings** →
   **Variables and Secrets**:
   - Secret `MONITOR_CRON_SECRET` = `lBFWpzJDAnIAXW4e-qkZaRJmaJkgMw0o`
2. Guardar. En la próxima corrida del cron (cada minuto) el Worker llamará a
   `/api/monitor/cron` y empezarán las comprobaciones.

> **Importante:** un redespliegue del Worker puede **borrar variables puestas a
> mano** en el panel que no estén en `wrangler.toml`. Por eso `MONITOR_APP_URL`
> ahora está en el código. Los **secretos** (como `MONITOR_CRON_SECRET`) sí
> persisten entre redespliegues; si alguna vez el cron deja de correr tras un
> despliegue, confirma que ese secreto siga presente y que el **Cron Trigger**
> `* * * * *` siga listado en Settings → Triggers.

**Alternativa** si prefieres no tocar el Worker: un cron externo (p. ej.
cron-job.org) que haga `POST https://app.casalabs.com.do/api/monitor/cron` cada
minuto con la cabecera `x-monitor-secret: lBFWpzJDAnIAXW4e-qkZaRJmaJkgMw0o`.
(También se dejó soporte para el cron de Vercel vía `Authorization: Bearer
CRON_SECRET`, pero no se añadió el cron a `vercel.json` para no arriesgar el
despliegue de producción si la cuenta estuviera en plan Hobby, que no ejecuta
crons por minuto.)

Hasta activar uno de los anteriores, el panel mostrará **“Sin datos / Monitor
detenido”** (no se simula actividad).

## 8. Alertas por correo

Un solo aviso por cambio de estado (incidente confirmado, recuperación, monitor
detenido), sin duplicados (índice único `incident_id,email,kind`) y con reintentos
controlados. Incluye servicio, ambiente, hora RD, descripción y enlace al módulo.
El envío usa **SMTP** de tu buzón (nodemailer) si defines `MONITOR_SMTP_*`;
**IMAP no se usa para enviar** (solo serviría para leer). Como alternativa acepta
Resend. Mientras no haya proveedor configurado, los cambios de estado se
**registran** pero no se envían correos, y el panel lo indica. La vista de
Configuración incluye un **envío de prueba** a un destinatario configurado.

## 9. Pruebas realizadas

`npm run test:monitor` — 28 pruebas, todas en verde. Con respuestas controladas:

- Respuesta válida → **ok**; lenta pero válida → **degraded**; error HTTP (500) →
  **down/http**; formato incorrecto → **invalid**; timeout (abort) → **down/timeout**;
  DNS (ENOTFOUND) → **dns**; TLS → **tls**.
- Incidentes: abre tras 2 fallos consecutivos, cierra tras 2 respuestas válidas;
  un fallo aislado no abre incidente.
- Métricas: disponibilidad y cobertura (incluye períodos sin datos → `null`), y
  `expectedRuns` que no cuenta antes de la puesta en marcha.
- Seguridad: la allowlist rechaza endpoints no oficiales y `http` sin salir a la red.

La UI se verificó renderizada (escritorio y móvil) con datos representativos.

### Comprobación real contra el endpoint oficial permitido

Ejecutada desde el servidor contra los 3 ambientes (14-oct-2026):

| Ambiente | HTTP | Resultado | Tiempo |
|---|---|---|---|
| TesteCF | 200 | semilla válida (`<SemillaModel><valor>…`) → **Operativo** | 533 ms |
| CerteCF | 200 | semilla válida → **Operativo** | 324 ms |
| eCF (prod) | 200 | semilla válida → **Operativo** | 67 ms |

Qué demuestra: el monitor **obtiene realmente la semilla de autenticación** de los
endpoints oficiales de la DGII, valida HTTP + estructura del XML y clasifica el
estado y el tiempo de respuesta correctamente. No demuestra el funcionamiento de
otros servicios e-CF (envío, aprobación, consultas), que no se comprueban.

## 10. Requisitos pendientes de configuración

1. **Scheduler**: desplegar el Cloudflare Worker con el cron y los secretos
   (sección 7), o configurar un cron externo. Sin esto no hay comprobaciones
   automáticas.
2. **Alertas por correo**: definir `MONITOR_RESEND_API_KEY` y `MONITOR_ALERT_FROM`
   (o adaptar a otro proveedor/SMTP). Sin esto, los avisos se registran pero no se
   envían.
3. **Alerta de “monitor detenido”**: configurar `MONITOR_HEARTBEAT_URL` (heartbeat
   externo independiente). Sin esto, esa alerta no está disponible.
