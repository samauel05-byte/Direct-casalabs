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

Los destinos están restringidos por una **allowlist** en el servidor
(`lib/monitor/endpoints.js`): solo `https` al host `ecf.dgii.gov.do`. La
configuración referencia los endpoints por clave, nunca por URL libre, para que
no se puedan apuntar comprobaciones a redes internas ni a terceros.

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
- **Panel** (`public/monitor/index.html`): estado por servicio y ambiente,
  disponibilidad 24h/7d/30d/90d + cobertura, barras diarias de 90 días, gráfico de
  tiempos, incidentes, filtros, detalle por día, indicador de actualización y
  próxima comprobación. Lee solo datos guardados (no llama a la DGII por visita).
- **Scheduler** (`worker.js` + `wrangler.toml`): el Cloudflare Worker ejecuta un
  cron `* * * * *` (1 minuto) que llama a `/api/monitor/cron` con un secreto.
  Independiente del navegador.
- **Integración Direct** (`public/index.html`): entrada “Monitor DGII” en el menú
  de herramientas, vista con iframe, apertura con token de sesión y handshake.

## 3. Estados y umbrales

Operativo · Degradado (supera el umbral de lentitud) · Sin respuesta/Respuesta
inválida · Sin datos · Sin datos recientes · Pausado. Un fallo aislado **no** se
presenta como caída general. Umbrales configurables por el administrador; por
defecto: incidente tras **3 fallos** consecutivos, cierre tras **2 respuestas
válidas** consecutivas, lentitud **3000 ms**, timeout **10000 ms**. Todos los
resultados individuales se conservan aunque no se haya abierto incidente.

Fechas en **UTC** en la base; se muestran en **America/Santo_Domingo**.

## 4. Métricas

- **Disponibilidad** = comprobaciones válidas / ejecutadas × 100. Una respuesta
  lenta pero válida cuenta como disponible y además se marca como degradada.
- **Cobertura** = ejecutadas / esperadas durante el período activo (desde la
  puesta en marcha). Los períodos sin monitoreo aparecen como **“Sin datos”**; no
  cuentan como disponibilidad ni como caída. No se muestra historial anterior a la
  puesta en marcha.

## 5. Permisos y aislamiento

- **Usuarios autorizados**: consultan estado e historial (el estado del servicio
  es general y se comparte).
- **Administradores**: configurar, pausar, verificación manual (con límite de
  frecuencia) y administrar alertas.
- **Privado por firma (tenant)**: destinatarios de alertas y registro de
  notificaciones. Errores y respuestas se **sanean** antes de guardar/mostrar.

## 6. Variables de entorno

| Variable | Dónde | Necesaria para | Estado |
|---|---|---|---|
| `MONITOR_CRON_SECRET` | Vercel **y** Cloudflare Worker | Autorizar al scheduler a llamar `/api/monitor/cron` | **Configurada en Vercel** (falta ponerla igual en el Worker) |
| `MONITOR_APP_URL` | Cloudflare Worker | URL base de Direct que llama el cron (por defecto `https://app.casalabs.com.do`) | Opcional |
| `MONITOR_RESEND_API_KEY` + `MONITOR_ALERT_FROM` | Vercel | Enviar alertas por correo (proveedor Resend, vía HTTPS) | **Pendiente** (sin esto, los avisos se registran pero no se envían) |
| `MONITOR_HEARTBEAT_URL` | Vercel | Dead-man switch externo para detectar que el monitor se detuvo | **Pendiente** (sin esto, la alerta “monitor detenido” no está disponible) |

> `MONITOR_CRON_SECRET` ya quedó en Vercel: `lBFWpzJDAnIAXW4e-qkZaRJmaJkgMw0o`.
> Toma efecto en el próximo despliegue de producción.

## 7. Activar el proceso programado (pendiente de tu lado)

El código del scheduler está listo; para activarlo hay que **desplegar el
Cloudflare Worker** con el cron y el secreto (no se puede hacer desde aquí porque
requiere tus credenciales de Cloudflare):

```bash
# en la raíz del repo, con wrangler autenticado en tu cuenta Cloudflare
wrangler secret put MONITOR_CRON_SECRET   # pega: lBFWpzJDAnIAXW4e-qkZaRJmaJkgMw0o
wrangler secret put MONITOR_APP_URL       # pega: https://app.casalabs.com.do
wrangler deploy                           # publica el Worker con el cron "* * * * *"
```

**Alternativa compatible** si no se usa Cloudflare cron: un cron externo (p. ej.
cron-job.org) que haga `POST https://app.casalabs.com.do/api/monitor/cron` cada
minuto con la cabecera `x-monitor-secret: <MONITOR_CRON_SECRET>`.

**Limitación identificada:** Vercel (plan actual) no ejecuta crons por minuto
—su cron de este repo es diario—, por eso el scheduler de 1 minuto va en el
Cloudflare Worker (que sí admite granularidad de 1 minuto) o en un cron externo.
Hasta activar uno de los dos, el panel mostrará **“Sin datos / Monitor detenido”**
(no se simula actividad).

## 8. Alertas por correo

Un solo aviso por cambio de estado (incidente confirmado, recuperación, monitor
detenido), sin duplicados (índice único `incident_id,email,kind`) y con reintentos
controlados. Incluye servicio, ambiente, hora RD, descripción y enlace al módulo.
IMAP no se usa para enviar. Mientras no se configure `MONITOR_RESEND_API_KEY` +
`MONITOR_ALERT_FROM`, los cambios de estado se **registran** pero no se envían
correos, y el panel lo indica.

## 9. Pruebas realizadas

`npm run test:monitor` — 28 pruebas, todas en verde. Con respuestas controladas:

- Respuesta válida → **ok**; lenta pero válida → **degraded**; error HTTP (500) →
  **down/http**; formato incorrecto → **invalid**; timeout (abort) → **down/timeout**;
  DNS (ENOTFOUND) → **dns**; TLS → **tls**.
- Incidentes: abre tras 3 fallos consecutivos, cierra tras 2 respuestas válidas;
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
