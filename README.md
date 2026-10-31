# DIRECT — Plataforma contable multiempresa

Sistema para equipos contables que centraliza clientes, credenciales cifradas y herramientas de trabajo para los portales dominicanos.

> **Nota de mantenimiento:** este README y [`ABOUT.md`](ABOUT.md) se mantienen al día con cada cambio del repositorio. Si modificas funcionalidad, actualízalos en el mismo cambio.

## Modelo multiempresa

Hay dos niveles claramente separados:

1. **Empresa operadora (tenant):** por ejemplo, `Save` o `Contadores del Este`. Cada usuario inicia sesión dentro de una sola empresa operadora.
2. **Clientes:** son las empresas que atiende esa operadora. Sus credenciales, RNC, archivos y resultados pertenecen exclusivamente a su empresa operadora.

Los módulos Direct, CAMI, NALA, IR-2 y Estimación Fiscal son funciones comunes del producto: se habilitan para cada empresa operadora contratante, pero sus consultas siempre usan el tenant del usuario autenticado. Por eso Contadores del Este nunca puede ver datos de Save, aun cuando ambos utilicen exactamente los mismos módulos.

## URL de producción

**[https://app.casalabs.com.do](https://app.casalabs.com.do)**

---

## Portales soportados

Direct abre cada portal en una pestaña nueva. Según el portal, el acceso es de tres tipos:

- **Auto-login por relay:** el relay (Cloudflare Worker) sirve el portal y rellena y envía el formulario automáticamente.
- **Semi-automático:** el portal usa un proveedor de identidad externo que impide el auto-login; Direct abre el portal y guía el pegado de las credenciales paso a paso.
- **Abrir directo / solo abrir:** abre el portal (o formulario público) sin rellenar.

| Portal | Clave | Acceso |
|--------|-------|--------|
| DGII — Dirección General de Impuestos Internos | `dgii` | Auto-login por relay (incluye tarjeta de códigos) |
| TSS — Tesorería de la Seguridad Social | `tss` | Auto-login por relay (SUIR WebForms) |
| Ministerio de Trabajo (OVI) | `trabajo` | Auto-login por relay (SPA) |
| SISALRIL | `sirla` | Semi-automático (Keycloak, ver abajo) |
| Cardnet | `carnet` | Auto-login por relay |
| Azul | `azul` | Auto-login por relay |
| IDOPPRIL | `idoppril` | Auto-login por relay |
| ONAPI | `onapi` | Auto-login por relay |
| Formalízate | `formalizate` | Auto-login por relay |
| Cámara de Comercio (Firma digital) | `camara` | Formulario público por relay |
| Digisign — Facturación electrónica | `digisign` | Abrir directo |
| Correo GD (Webmail) | `gdmail` | Abrir directo |
| Nexo — Gestor de pendientes (`https://nexo.casalabs.com.do/`) | `nexo` | Solo abre |
| Citrus — Pagos y servicios | `citrus` | Auto-login por relay |

**SISALRIL** inicia sesión con Keycloak en un dominio aparte (`idp.sisalril.gob.do`) que rechaza cualquier origen que no sea el suyo, por lo que el auto-login por relay no es posible. Direct ofrece un panel semi-automático de 2 pasos: copia el correo al abrir y la contraseña con un toque, para pegarlos en el portal real.

---

## El relay (Cloudflare Worker)

Los portales se abren a través de `portal-rd-relay.samauel05.workers.dev`, que:

- Sirve la página del portal y le inyecta el script de auto-login (credenciales solo en el hash de la URL, nunca al servidor del relay).
- El origen permitido por CORS del relay es `https://app.casalabs.com.do` (el dominio antiguo `direct-save.vercel.app` ya no se usa).
- Reescribe recursos y navegación para que el portal siga funcionando dentro del relay «como un sistema normal», sin extensiones de navegador.
- **Aísla la sesión de cada empresa por `flow`**: al abrir una segunda empresa del mismo portal, su sesión no hereda la de la primera (cookies con prefijo `serp_<flow>_`). Aplica tanto a los portales clásicos (DGII, etc.) como a los SPA (Ministerio de Trabajo, SISALRIL).
- Avisa a Direct el resultado del inicio de sesión por `postMessage`.
- **Token Digital de la DGII**: si la pantalla de la Oficina Virtual trae la casilla «Token Digital» (`tokenInput()`), el robot calcula el TOTP en la página (`totpCode`, RFC 6238, mismo formato que `public/js/totp.js`, incluidas las claves `serp:` calibradas) con `p.totp` (solo en el hash) y envía; sin `p.totp` deja el foco en la casilla y no envía. Mientras haya casilla de token no se escribe la tarjeta de códigos en ella. La DGII muestra el token en una **segunda pantalla** (Usuario de solo lectura + Clave + «Token Digital» + Continuar): tras enviar la primera pantalla, `waitAndRun` detecta esa casilla, la llena y pulsa Continuar **una sola vez** (guarda `serp-dgii-token-submit-<flujo>` en sessionStorage para no repetir envíos y evitar bloqueos de la cuenta).
- **Jalado automático 606/607 (solo DGII)**: cuando la Oficina Virtual se abre desde Estimación Fiscal con «Jalar de DGII» (el lanzamiento lleva `capture` en el hash), el relay inyecta un botón flotante «Traer 606/607 a SERP» que serializa las tablas de la pantalla (p. ej. «Consulta de Envíos») y las manda a la app por `postMessage`; la app las pasa a su importador con vista previa. Aislado tras esa bandera: no aparece en aperturas normales ni en otros portales.

El relay se despliega automáticamente desde `main`.

---

## Seguridad

- **Sesión compartida entre pestañas de módulos**: Direct (`broadcastSession`) publica `{token, sid}` en el `BroadcastChannel` `serp-session` al iniciar/renovar sesión y responde a `{type:'need'}` (renovando si el token vence en < 90 s). `public/serp-host.js` mantiene el último token (`__serpToken`, `sessionStorage.dtoken`) y expone `serpRequestToken()`; CAMI (`analisis.js`) lo usa tras un 401. El canal es de mismo origen y no incluye el refresh token.
- **Token Digital DGII (TOTP)**: `public/js/totp.js` implementa RFC 6238 con WebCrypto (HMAC-SHA1/256/512, 6–8 dígitos, periodo configurable; acepta clave base32 o enlace `otpauth://`). La clave se guarda en el campo `totp` del secreto cifrado de la credencial DGII (igual que `dgiiCodes`); el código se calcula sólo en el navegador. Nota de seguridad: guardar contraseña y segundo factor en la misma bóveda reduce la protección del 2FA al secreto de la bóveda; se acepta por conveniencia operativa del contador. Pruebas con los vectores de la RFC: `tests/direct/totp.test.js`. Si lo que se pega es un UUID (identificador del token, no la clave), el formulario lo avisa: con un UUID no se pueden generar códigos; hace falta el enlace `otpauth://` del QR. Para tokens con UUID existe la **calibración** (`TOTP.calibrate`): prueba modos de clave (`hexbytes`, `text`, `textup`, `textnd`, `textndup`) × SHA-1/256/512 × periodo 30/60 s contra un código real del celular (±2 pasos) y guarda la combinación como `serp:<modo>:<alg>:<periodo>:<dígitos>:<uuid>`.
- **KDF versionado de la bóveda**: la llave de usuario (contraseña → AES-GCM) se deriva con PBKDF2-SHA256. La sal guardada en `direct_profiles.user_key_salt` lleva su versión: `v2$<base64>` = 600.000 iteraciones; sin prefijo = legado (200.000). Al iniciar sesión con una sal legada, el cliente re-envuelve el **mismo** secreto de bóveda con una sal v2 (verifica que abre) y lo envía con `PATCH /api/auth/login` (`prevSalt` como compare-and-swap; sólo el propio usuario). La derivación del secreto aleatorio de 32 bytes hacia `masterKey` (`deriveKeyFromBytes`, 200.000) **no cambia**: cambiarla invalidaría todas las credenciales guardadas. Pruebas: `tests/direct/kdf*.test.js`.
```
Contraseña del usuario (solo en memoria del navegador)
        │
        ▼ PBKDF2 · SHA-256 · 200 000 iteraciones + salt personal
        │
        ▼ Clave de usuario (desencripta la clave de bóveda)
        │
        ▼ Secreto de bóveda (bytes aleatorios, en memoria únicamente)
        │
        ▼ PBKDF2 · SHA-256 · 200 000 iteraciones + vaultSalt global
        │
        ▼ MasterKey AES-256-GCM
        │
        ├─ Cifra cada credencial antes de subirla al servidor
        └─ Descifra al abrirla — el servidor nunca ve texto plano
```

- El servidor **nunca** recibe credenciales en texto plano
- Todo el cifrado/descifrado ocurre en el navegador (Web Crypto API)
- El secreto de bóveda existe **solo en memoria de sesión**
- Cada usuario tiene su propio salt y su copia cifrada del secreto de bóveda
- Los nombres de empresa van cifrados: solo se descifran en el navegador
- **Aislamiento multiempresa**: clientes y credenciales se consultan con el tenant del perfil autenticado
- **Sesión única por usuario**: un nuevo inicio desde otro equipo bloquea automáticamente la sesión anterior
- **Renovación silenciosa de sesión**: el `access_token` dura 1 h; el navegador guarda el `refresh_token` solo en `sessionStorage` (vida de la pestaña) y lo canjea en `POST /api/auth/refresh`, que renueva contra Supabase **en el servidor** (la anon key no sale de ahí). La renovación es proactiva (unos minutos antes de vencer) y reactiva (al recibir un 401 se renueva y se reintenta la petición una vez antes de bloquear la bóveda). Respeta la sesión única: un navegador ya desplazado por otro no puede renovarse (se valida `X-Direct-Session` contra `direct_active_sessions`). El iframe de Estimación Fiscal solicita la renovación a la app padre y reintenta su guardado.
- **RLS sin acceso directo desde navegador**: las operaciones pasan por rutas autenticadas del servidor (rol de servicio)

---

## Módulos

**Verificar claves en lote (`DX.verifyKeys`, `public/js/direct-extras.js`):** solo DGII. Abre UNA ventana con el clic (para no ser bloqueada) y, por cada credencial, llama `autoLoginForm(..., win)` con `window.__serpEnteringCred` fijado; el relay informa `serp-login-result` (`ok`/`failed`) y el manejador de DX lo entrega a `DX.verifyHook`. Espera 60 s por empresa, pausa 3,5 s entre empresas, un intento por empresa sin reintentos; los toasts de «clave rechazada» se silencian mientras `DX.verifying`. El botón vive en la barra `#verify-bar` de la vista Empresas de la DGII.

**Edición de credenciales (`saveCompany`/`openCompanyModal`, `public/index.html`):** el portal sale de la credencial editada (`_coInst`), no de `activePortal` (que es `null` al abrir «Actualizar clave» desde el Inicio); el payload parte del texto descifrado previo (no pierde `rnc`, `cedula`, etc.); `apiRequest` no lanza con 403/400/500, así que `saveCompany` y los borrados exigen `ok === true` y usan el `updated_at` del servidor. `PUT /api/credentials/:id` lo pueden usar los usuarios con acceso a Direct solo para actualizar una credencial existente que ven (portal en `portals_direct`, id en `companies_direct` si hay empresas asignadas, mismo portal/categoría); crear, eliminar (`DELETE`) e importar (`POST /api/credentials`) siguen siendo solo del administrador. Pruebas: `tests/direct/credentials-put.test.js`.

**Buscador de Direct (`public/index.html`):** `buildHomeIndex` indexa las credenciales descifradas y, además, los clientes de `GET /api/clients` que no tienen credencial (`sinAcceso`, sin chips de acceso); la búsqueda por RNC compara solo dígitos. `renderHomeResults` sugiere RNC con distancia de edición ≤ 1 cuando no hay resultados (≥ 7 dígitos). La vista Empresas usa `data-digits` y el Panel de Nómina compara RNC sin guiones.

**NALA — revertir aprobación:** `POST invoices/:id/revert` ya no exige `reason` (sin motivo se registra «Reabierta para editar»); la UI solo pide confirmar. Aprobar con advertencias, excluir y reubicar siguen exigiendo motivo.

**NALA — errores de la DGII → factura:** `views-export.js` expone `NALA.dgiiErrors` (`parse`/`match`): extrae del texto pegado pares `RNC-NCF`, NCF sueltos y números de línea, los cruza con `snapshot.lines` del archivo exportado (columnas `ncf` y `rnc_cedula`, `line_no`) y enlaza cada coincidencia a `#/auditoria/<invoice_id>`; también sugiere la acción de `DGII_ALERTS` según el texto. También se abre desde el botón «Errores de la DGII» de la lista de exportaciones (`dgiiErrorsModal`: elige el archivo, carga su `snapshot` con `GET exports/:id` y reutiliza el mismo cuadro). Pruebas: `tests/direct/nala-dgii-errors.test.js`.

**Política de privacidad:** `public/privacidad.html` usa el nombre «Direct» (ya no «SERP»).

**Nexo para todos:** el portal Nexo (Otros accesos) se muestra a todo usuario que inicia sesión, tenga o no acceso a Direct ni asignado el portal en `portals_direct` (`renderPortalGrid`).

**Usuarios — nombres en la lista:** `GET /api/users` resuelve el nombre de cada usuario con `usernameMap` (paginado y con respaldo `getUserById` por cuenta), de modo que la lista de usuarios ya no muestra «?» si la consulta masiva de Supabase Auth falla o queda incompleta.

**NALA — zoom del panel de datos:** el panel derecho de la auditoría (Datos / Historial / Exportaciones) tiene botones −/+/100 % (0.7×–2×, `zoom` CSS sobre `#ebody`), igual que el visor de la factura; el nivel se recuerda en `localStorage` (`nala_editor_zoom`).

**NALA — TXT del 606:** `SCHEMAS['606']` marca `isr_retenido` («Monto Retención Renta») con `alwaysWrite`: `cellText` lo escribe siempre (`0.00` sin retención) e ignora el estilo aprendido (`blank_zero`), porque la DGII rechaza el archivo con «Retencion Renta:(), Numero NO válido» cuando va vacío. El 607 no cambia.

**CAMI ← NALA (autollenado)**: `GET /api/ir2/resumen?tipo=cami-nala&rnc=&periodo=AAAAMM` (`lib/cami-nala.js`, mismo permiso de CAMI/NALA y tenant; respeta `nala_member_clients`) devuelve, por formato, las filas **aprobadas** de `nala_invoices` armadas con `formats.buildSnapshot` y las etiquetas oficiales de la DGII (`headers` + `rows`), los pendientes, el resumen de consumo B02/E32 (<RD$250.000) y los e-CF excluidos del 607. `public/cami/itbis-web.html` (`loadFromNala`) lo pasa por `process606`/`process607` como si fuera un archivo (marca `fromNala`), sin pisar archivos subidos a mano salvo con el botón «Traer de NALA». Pruebas: `tests/cami/nala-source.test.js`.

**CAMI — cuadros de compras** (`process606` también suma `totIsc`, `totOtrosImp` y `totPropina`, columnas ISC / Otros Impuesto/Tasas / Propina legal, que se muestran como líneas informativas y no entran en el cálculo del ITBIS) (el signo de nota de crédito del 606 sale solo del NCF vía `compraNcfCode`; la columna «Tipo Bienes y Servicios» 01–11 es tipo de gasto, y «Tipo de Ingreso» del 607 se ignora como tipo de comprobante): `process606` agrega `summary.compras` (`byNcf`, `byPago`, `byTipo`: cantidad, monto e ITBIS) usando `compraNcfCode`, `compraPagoKey` y `compraTipoKey` (alias nuevo `forma_pago` en `AL606`); `updateIT1` los muestra junto a los de ventas y oculta el bloque de ventas si no hay 607. Son informativos en pantalla (la plantilla oficial del IT-1 no trae casillas de compras por tipo).

**CAMI — IT-1 con un solo archivo**: `updateIT1`/`exportIT1DGII` usan `it1S6()`/`it1S7()`, que devuelven el resumen cargado o uno vacío (`empty606Summary`/`empty607Summary`); el IT-1 se habilita con 606, 607 o ambos.

**Conciliación bancaria** (`/conciliacion/`): herramienta 100 % del lado del navegador (sin API ni datos en el servidor). `engine.js` (UMD, también corre en Node) normaliza montos (`1,234.56`, `1.234,56`, `(500)`, `DB/CR`) y fechas (dd/mm/yyyy, ISO, serial Excel) a centavos/ISO, adivina columnas por encabezado y concilia 1 a 1: puntaje por referencia (exacta/parcial), diferencia de fecha (tolerancia configurable) y descripción; estados `auto` / `review` (monto repetido, fecha distinta, posible duplicado) / `confirmed`; separa cargos bancarios (comisión, impuesto 0.15 %, ITBIS, intereses…) y detecta duplicados por lado. La salida a Excel (SheetJS vendorizado) trae Resumen, Conciliados, Por revisar, Solo en banco/libros, Cargos y Duplicados. Visible en Accesos para admin y quienes tengan NALA, IR-2 o Estimación. Pruebas: `npm run test:conciliacion`. Los CSV se leen como texto (UTF-8, o Windows-1252 si no lo es) y sin convertir fechas (`raw:true`), para que dd/mm/aaaa llegue intacto a `parseDate`; los `.xlsx`/`.xls` se leen como binario.

**Apertura de módulos**: NALA, CAMI, Nómina, IR-2, Estimación Fiscal y Monitor DGII se abren cada uno en su propia pestaña (`window.open` sin `noopener`, nombre `serp-<módulo>`; si ya existe se le da el foco). La pestaña hereda una copia de `sessionStorage` (token) y habla con el shell de Direct por `window.opener` mediante `public/serp-host.js` (`serpHost()`, `serpBack()` y tema `direct_theme`). El shell valida el origen de cada mensaje contra la ventana registrada (`_modWin`).

| Módulo | Descripción |
|--------|-------------|
| **Direct** | Bóveda de credenciales con portales gubernamentales y auto-login; inicio con avisos de contraseña, historial de entradas y permisos por empresa |
| **CAMI** | Herramienta ITBIS — cálculo de IVA / facturas 606/607 e IT-1 |
| **NALA** | Flujo fiscal 606 y 607: carga masiva, extracción OCR/IA, validación, auditoría, aprobación y exportación DGII; chat IA e IR-17; informativo en cero para períodos sin operaciones (ver `docs/nala/README.md`) |
| **Nómina** | **Panel general** (todas las empresas, calendario de la quincena, neto/aportes, qué requiere atención, CSV) y nómina por empresa con **empresas propias del módulo** (pestaña Empresas: el usuario crea la empresa y le sube la nómina): columnas dinámicas (monto/número/texto/fórmula sin `eval`), empleados, períodos editables con totales/neto y exportación a Excel (ver `docs/nomina/README.md`). Volantes itemizados (HTML/PDF, neto en letras), ficha del empleado con gráfica y volante por período, y avisos de cambios sin guardar. En la ventana **Novedad** del empleado, escribir un monto enciende solo el interruptor del concepto (antes se descartaba si no se encendía). Los montos aceptan comas, espacios y «RD$»; un valor no numérico devuelve error 400 con el nombre de la casilla (antes se descartaba en silencio). El imponible suma «Otros (+)» como `otros_mas*p_div/(1+cobra_entero)` (con «Cobra entero» el extra ya es del mes y no se duplica). Si una llamada devuelve 401, `api()` pide un token renovado a Direct (`serpRequestToken`, canal `serp-session`) y reintenta una vez; si no hay, muestra un mensaje claro. `nomina_settings` referencia `nomina_companies` (migración `202610300001`); antes apuntaba a `direct_clients` y guardar Ajustes devolvía el error 23503. |
| **IR-2** | Declaración de renta |
| **Estimación Fiscal** | Gastos NCF · Inmuebles · Retenciones · Vehículos · Envíos 606 · DGA |

**Estimación Fiscal ← NALA**: `GET /api/ir2/resumen?rnc=…&anio=…&tipo=dgii-modulos&fuente=nala` (mismo permiso que Estimación; sin función nueva por el límite de 12 de Vercel Hobby) devuelve, vía `lib/nala/fiscal-summary.js`, el resumen **solo de comprobantes aprobados** de la empresa NALA con ese RNC/cédula en el año: `meses` (por período y formato: aprobados, pendientes, total, ITBIS, retenciones, auditoría completa/en proceso, último archivo y referencia), `gastos` (606 por tipo de bienes y servicios) y `resumen`. `public/dgii/index.html` lo consulta al elegir empresa/año, llena Gastos NCF (filas con `origen:'nala'`, que no pisan filas manuales) y muestra la tabla mensual en Envíos. Empresa sin registro en NALA → `client:null`.
El histórico `envios606` se completa con `nalaEnvios()` (una fila por `meses[]` con aprobados > 0, `origen:'nala'`); `applyNalaEnvios()` reemplaza solo las filas `origen:'nala'` y conserva las manuales/importadas.

El botón «Anexo J del IR-2 ↗» de Gastos NCF pide confirmación, guarda y abre `/ir2/anexos.html?…&origen=gastos` con `window.open` en pestaña nueva (no reemplaza el iframe de Estimación); con `origen=gastos` el botón de volver de esa página cierra la pestaña.

Guardado de Estimación (`public/dgii/index.html`): autoguardado con debounce de 1.5 s (`markDirty`/`saveQuiet`), indicador `#sbadge`, `beforeunload` con cambios pendientes y bandera `LOADED` que impide guardar encima del registro cuando la carga falló (401 → renueva vía `dgii-session-refresh` y reintenta una vez). `onCell` solo actualiza totales (no reconstruye la tabla). `rncTyped` selecciona la empresa al teclear un RNC conocido.
| **Clientes** | Gestión de los clientes de la empresa operadora mediante Excel |

**Guía central de empresas**: `public/js/empresas.js` es el conector compartido que lee la lista de clientes (`/api/clients`, aislada por firma) y autocompleta **nombre ↔ RNC** donde se pidan (Estimación Fiscal, IR-2, CAMI). Al elegir/escribir el nombre rellena el RNC y viceversa; normaliza los datos (quita el prefijo «GENERALES » de la importación y deduplica por nombre). Cada módulo lo incluye y conecta su par de campos con `SERP_EMPRESAS.attach(nombreId, rncId)`. NALA usa la misma guía con su propia lista ya cargada (`NALA.state.clients`) en el formulario de empresa cliente.

Los nombres de empresa de la **bóveda de credenciales** (lista de empresas de un portal, buscador global de accesos, detalle y edición) también se limpian del prefijo heredado «GENERALES » al descifrarse en el navegador (`C._cleanCompany` dentro de `C.dec`, en `public/index.html`): es conservador (solo al inicio, nunca deja el nombre vacío) y, al guardar una credencial editada, el nombre queda limpio de forma permanente.

---

## Asistente de IA en los módulos (separado de NALA)

Además de la IA de NALA (que **no se toca** y mantiene su propia configuración de
OpenAI), los módulos de Direct tienen un **asistente de IA** propio:

- **Backend**: `api/ai.js` (ruta `/api/ai/chat`, reescrita en `vercel.json`),
  autenticado con la sesión de Direct. La **personalidad** del asistente la pone
  el servidor según el `module` (`accesos`, `nomina`, `contable`); el cliente
  nunca define el rol ni ve la llave.
- **Motor**: `lib/ai/assistant.js`, cliente compatible con OpenAI configurable por
  entorno: `AI_API_KEY`, `AI_BASE_URL` (por defecto OpenRouter) y `AI_MODEL`
  (fuerza un modelo concreto). Es **independiente** de las variables de NALA
  (`OPENAI_API_KEY`, `NALA_OPENAI_*`). Envía `reasoning:{enabled:false}` y, si el
  modelo igual deja `content` vacío, usa el campo `reasoning` como respaldo.
  **Cadena de modelos**: como muchos modelos gratis de OpenRouter son de
  razonamiento y, con contexto, se quedan sin presupuesto de tokens y devuelven
  el texto vacío, el motor prueba varios **en orden hasta que uno responde**
  (por defecto Gemma de instrucción primero, luego Nemotron). `AI_MODEL` fuerza
  uno solo si se prefiere.
- **Widget**: `public/js/ai-assistant.js`, un botón flotante ✨ + panel de chat
  reutilizable (UI pura); cada módulo lo monta con `AIAssistant.mount({module,
  auth, getContext, suggestions})`. Escapa el texto y solo permite **negrita**.
- **Contexto en vivo**: el widget envía como `context` lo que el usuario está
  viendo en pantalla (empresa, período, cifras, tablas del módulo). Si el módulo
  no define `getContext`, se usa `defaultContext()`, que toma el texto visible del
  contenido (hasta 3000 caracteres, sin el propio panel del asistente). El
  servidor lo inyecta en el *system prompt* como "Contexto del módulo", así el
  asistente responde sobre los datos reales que el usuario tiene abiertos (p. ej.
  "resume la nómina que tengo abierta") en vez de dar respuestas genéricas. No se
  envían contraseñas: las credenciales no están como texto visible.
- Montado en **Accesos** (shell, guía de trámites/portales), **Nómina**, **CAMI**,
  **DGII** e **IR-2**; cada uno con su personalidad (`accesos`/`nomina`/`contable`)
  y sus sugerencias.

Para activarlo basta poner `AI_API_KEY` (llave de OpenRouter u otro proveedor
compatible) en Vercel; sin la llave, el asistente responde que no está configurado.

---

## Roles de usuario

| Rol | Permisos |
|-----|----------|
| `admin` | Gestiona usuarios, credenciales, clientes e importaciones de su propia empresa |
| `user` | Accede a los portales y datos asignados dentro de su propia empresa |

El admin puede:
- Crear y desactivar usuarios
- Asignar acceso a módulos (Direct / CAMI / NALA / Nómina / IR-2 / Estimación Fiscal)
- Asignar portales individuales a cada usuario
- **Asignar empresas (clientes) concretas a cada usuario**: un empleado ve solo las empresas que se le asignan (vacío = todas)
- Restablecer la contraseña de cualquier usuario

---

## Características de Direct

- **Auto-login**: un clic envía automáticamente las credenciales al portal en una nueva pestaña
- **Aviso de contraseña vencida**: si un portal rechaza la clave, la empresa se marca para actualizarla
- **Revisión de tarjetas de códigos DGII**: revisa/corrige la tarjeta y avisa si faltan códigos o hay repetidos
- **Historial de entradas**: registro de quién entró a qué portal y cuándo (solo admin)
- **Permisos por empresa**: cada usuario ve únicamente las empresas asignadas
- **Cifrado AES-256-GCM** en el navegador — las credenciales viajan y se almacenan siempre cifradas
- **Carga de clientes por Excel** con validación de estructura, formatos y duplicados
- **Sesión exclusiva**: al abrir el mismo usuario en otro equipo se bloquea la sesión anterior
- **Sincronización en tiempo real** — cualquier cambio se refleja al instante
- **Tema claro y cálido por defecto**, renovado y amigable (fondo tipo papel cálido, acentos azules); con tema oscuro y modo automático disponibles desde el selector de apariencia. La calidez es consistente en toda la app y en los módulos (NALA, CAMI, IR-2, Estimación Fiscal, páginas de anexos/resumen y la política de privacidad)
- **Experiencia móvil** pulida para uso en celular (ver abajo)
- **Monitor DGII**: estado de los servicios de facturación electrónica (e-CF) con comprobaciones automáticas cada minuto, disponibilidad e historial de incidentes (ver abajo)

---

## Monitor DGII (disponibilidad de facturación electrónica e-CF)

> **Programador:** las comprobaciones cada minuto las dispara el Cloudflare Worker (`worker.js`) **y, como respaldo independiente, un job `pg_cron` de Supabase** (`monitor-dgii`) que llama a `/api/monitor/cron` con el secreto del Vault. Ver `docs/monitor-dgii.md`.

Módulo dentro de Direct para consultar el estado de los servicios de la DGII. La
comprobación es la **“Obtención de semilla de autenticación”** e-CF: un `GET` de
solo lectura, sin certificado ni credenciales, que **no genera transacciones
fiscales**; valida el código HTTP y la estructura del XML `<SemillaModel>`.
Endpoints oficiales por ambiente (`testecf`, `certecf`, `ecf`) restringidos por
allowlist a `https://ecf.dgii.gov.do`.

Además comprueba la disponibilidad del **subsistema oficial de estatus e-CF**
(`statusecf.dgii.gov.do`, `GET` de solo lectura, sin credenciales). El estado
detallado por servicio de esa API requiere una **ApiKey emitida por la DGII**
(`Authorization: ApiKey …`); si se dispone de ella puede activarse en el futuro.
Otros portales de la DGII (p. ej. `www.dgii.gov.do`) bloquean el acceso desde
servidores, por lo que no son fuentes fiables de estado y no se monitorean.

- **Comprobación cada minuto** desde el servidor (Cloudflare Worker cron,
  independiente del navegador; evita duplicados entre instancias con single-flight).
- **Estados**: Operativo · Degradado · Sin respuesta/Inválida · Sin datos · Sin
  datos recientes · Pausado. Un fallo aislado no se presenta como caída general.
- **Incidentes**: abre tras 2 fallos consecutivos, cierra tras 2 respuestas válidas
  (umbrales configurables). Agrupa fallos del mismo servicio.
- **Métricas reales**: disponibilidad (válidas/ejecutadas) y cobertura
  (ejecutadas/esperadas) por 24h/7d/30d/90d; barras diarias de 90 días; gráfico de
  tiempos. Fechas en UTC, se muestran en America/Santo_Domingo.
- **Cuatro vistas**: Resumen (con resumen general que no se pinta verde si hay
  servicios sin comprobar, sin datos recientes o con incidentes), Incidentes,
  Registro de verificaciones (paginado; distingue programadas de manuales) y
  Configuración (solo admin, con auditoría de quién cambia qué y cuándo).
- **Métricas limpias**: una sola observación por intervalo programado; las
  verificaciones manuales y los reintentos no alteran los porcentajes.
- **Permisos**: todos los usuarios autorizados consultan; solo admin configura,
  pausa, verifica manualmente y administra alertas. Destinatarios de alertas
  privados por firma.
- **Alertas por correo** por cambio de estado (sin duplicados), por **SMTP del
  buzón del usuario** (IMAP solo lee; SMTP envía) o Resend como alternativa, con
  envío de prueba; pendiente de configurar el proveedor y el heartbeat externo.

Detalles de activación, variables de entorno, fuente oficial y pruebas en
`docs/monitor-dgii.md`.

---

## Analítica de uso (aprender cómo se usa el sistema)

Para entender a qué se dedica cada usuario dentro de SERP y proponer mejoras, se
registra la **navegación del sistema** (no lo que pasa dentro de los portales):

- Tabla `direct_usage_events` (aislada por firma, RLS deny-all, solo servidor vía
  service role). Columnas: `kind` (`module_open` | `portal_view` | `view` |
  `search` | `session` | `feature`), `target` (clave opaca de módulo/portal/vista),
  `meta` (jsonb, solo contadores), `user_id`/`username`, `created_at`.
- API en `api/credentials.js` bajo `?usage=1`: `POST` registra (mejor esfuerzo,
  nunca rompe la app ni filtra errores), `GET` lista (solo admin) para el panel.
- Frontend: helper `trackUsage(kind, target, meta)` en `public/index.html`
  (fire-and-forget, aplasta repetidos en 3s). Instrumentado en apertura de
  portal/módulo, uso del buscador (solo cuenta) e inicio de sesión. Las entradas
  por empresa y los resultados de login siguen en `direct_access_events`.

**Privacidad (regla dura)**: nunca se guardan nombres de empresa, RNC, textos de
búsqueda ni nada de dentro de los portales del gobierno (va cifrado en el
navegador; el servidor no lo ve). La medición es **por usuario con nombre**, así
que debe declararse en la Política de Privacidad y en «Seguridad de los datos»
de Play Store.

**Panel de inteligencia (admin)**: `usageStats` (`?stats=1`) combina
`direct_access_events` y `direct_usage_events` y el panel (`DX.openUsage` en
`public/js/direct-extras.js`) muestra, además de KPIs y actividad por
día/portal/hora: **uso por módulo** (con aviso de módulos nunca usados),
**a qué se dedica cada usuario** (módulo y portal principal, sesiones, búsquedas)
y **cuellos de botella** (empresas con más logins rechazados; el nombre se
resuelve en el navegador). El reporte periódico de recomendaciones es la
siguiente etapa.

## Experiencia móvil

El sistema está pulido para usarse cómodo en el teléfono (preparación para el
lanzamiento en Play Store como app), manteniendo el estilo actual:

- `viewport-fit=cover` + `env(safe-area-inset-*)` para respetar notch y barra de
  gestos en pantalla completa; `theme-color` por tema para la barra del navegador.
- Campos de formulario a 16px en celular para que el navegador **no** haga zoom al
  enfocar; `text-size-adjust:100%` para que no infle el texto.
- Sin destello azul ni retardo de 300ms al tocar (`-webkit-tap-highlight-color`,
  `touch-action:manipulation`); sin scroll horizontal.
- En Accesos: cabecera y márgenes compactos, botón de editar empresa con mayor
  área táctil, y **modales como hoja inferior** en pantallas pequeñas.
- Los módulos (NALA, CAMI, IR-2, DGII, Estimación) comparten
  `public/css/mobile-base.css` con las mejoras universales y seguras; el pulido de
  layout propio de cada módulo (tablas anchas, pestañas) es trabajo incremental.

---

## NALA — 606 y 607

- **Barra de filtros por pantalla**: `SCOPE_BY_VIEW` en `public/nala/js/app.js` define qué controles (empresa, período, formato) y la etiqueta de vista se muestran en cada vista; las que no filtran por ellos (Consulta RNC, Empresas clientes, Equipo, Configuración) no los muestran.
- **«Le toca a» en lotes**: con el permiso `team_manage`, la lista de lotes agrega la columna de oficiales asignados a la empresa (`GET team` → `nala_member_clients`); no lista a admins ni a miembros con `all_clients`.
NALA genera el TXT de la DGII y, además, deja las declaraciones listas en la **Herramienta de Envío oficial** de la DGII, con el mismo flujo para el **606** y el **607**:

- **Copiar y pegar**: entrega las filas en el formato exacto de la herramienta (606: 25 columnas B..Z; 607: 23 columnas B..X) para pegarlas en B12.
- **Excel con macro**: el usuario sube su herramienta oficial (.xlsm) en Configuración → Plantillas DGII y NALA se la devuelve llena (encabezado y filas), conservando el macro intacto.
- **Aprendizaje del TXT de ejemplo**: NALA aprende de TXT ya enviados cómo escribir montos y qué campos deja vacíos, por formato.
- **Enviar a la DGII de la empresa (asistido)**: en el detalle de una exportación, el botón **«Enviar a la DGII de la empresa»** descarga el TXT y pide al shell de Direct que abra la **Oficina Virtual de esa empresa ya logueada** (empareja el RNC de la exportación con su acceso DGII de la bóveda y usa el auto-login del relay, con la tarjeta de códigos cifrada). El usuario solo entra a **Remisión/Envío de Archivos**, adjunta el TXT descargado y envía; el archivo se adjunta a mano porque la DGII no permite adjuntarlo por código. Luego registra el número de recepción con «Registrar envío a DGII». Requiere la bóveda abierta y que exista el acceso DGII de la empresa; si no, NALA lo avisa. Mecanismo: `postMessage` `nala-open-dgii-envio` del iframe de NALA al shell (`public/index.html`), que responde con `nala-dgii-envio-result`.

Detalle en `docs/nala/README.md` y `docs/nala/dgii-606-607.md`.

---

## Estructura del proyecto

```
SERP/
├── api/                   — Funciones serverless (auth, credentials, clients, users, nala, nomina)
├── lib/                   — Núcleo: auth, tenant, db/supabase y librerías NALA y Nómina
├── public/
│   ├── activar.html       — Alta de una firma nueva con el enlace de licencia
│   ├── index.html         — App Direct (HTML + CSS + JS)
│   ├── js/                — direct-extras (inicio, historial, tarjetas, permisos)
│   ├── nala/              — App NALA (módulos + asistente)
│   └── nomina/            — App Nómina (empleados, columnas, períodos)
├── worker.js              — Relay Cloudflare Worker de los portales
├── supabase/migrations/   — Migraciones SQL (tenants, sesión única, NALA, Nómina, eventos Direct, …)
├── tests/                 — Pruebas Node (test:direct, test:nala, test:nomina)
└── vercel.json            — Ruteo de API y archivos estáticos
```

---

## Tecnologías

- **Frontend**: HTML + CSS + JS vanilla — sin frameworks
- **Cifrado**: Web Crypto API (AES-256-GCM, PBKDF2)
- **Backend**: Vercel Serverless Functions (Node.js)
- **Base de datos**: Supabase (PostgreSQL + Auth)
- **Relay de portales**: Cloudflare Worker (`portal-rd-relay`)
- **Despliegue**: Vercel (dominio `app.casalabs.com.do`), auto-deploy desde `main`

---

## Licencias y alta de firmas nuevas

Cada cliente que compra Direct es una **firma (tenant)** propia, aislada de las demás. Todas comparten la misma infraestructura (el relay de Cloudflare y la clave de OpenAI son de la plataforma: **ninguna firma configura ni toca claves ni código**); una firma nueva solo carga su información (clientes y empresas por Excel, accesos) y empieza a trabajar.

- **Administrador de la plataforma:** el usuario `root` (firma Save) tiene `direct_profiles.is_platform_admin = true`. Solo él ve el botón **Licencias** en Accesos y puede usar `/api/licenses/list|create|resend|revoke|extend|suspend|resume`. Una firma de cliente, aunque su administrador sea `admin`, no puede.
- **Emitir:** en el panel se registra cliente, correo, plan (etiqueta), meses y tope de usuarios. Se crea una fila en `direct_licenses` con el **hash** del token (el token en claro solo viaja en el enlace) y se manda por correo `https://app.casalabs.com.do/activar?t=…` (SMTP `LICENSE_SMTP_*`; si no existen usa el buzón del monitor `MONITOR_SMTP_*` / `MONITOR_ALERT_FROM`; si no hay correo, el panel muestra el enlace para copiarlo). El enlace es de **un solo uso** y vence en 14 días; se puede reenviar (genera uno nuevo y anula el anterior) o anular.
- **Activar** (`/activar`, página pública): el cliente elige nombre de firma, usuario y contraseña. La bóveda se crea **en su navegador** con el mismo esquema que el primer uso de Direct (llave PBKDF2 `v2$` de la contraseña envuelve un secreto aleatorio; verificador en `direct_config`). El servidor reclama la licencia de forma atómica, crea la firma (`direct_tenants`), el usuario administrador (todos los módulos y portales), la config de la bóveda y, si algo falla, deshace todo y deja la licencia pendiente. Usuario repetido → 409; usuarios reservados (`root`, `admin`, `soporte`…) no se permiten.
- **Vigencia:** `direct_tenants.license_until` (la firma Save y las anteriores a las licencias tienen `null` = sin vencimiento). Pasado el vencimiento hay **5 días de gracia** (aviso en Accesos); después la firma no puede iniciar sesión ni usar la API (los datos se conservan). `license_status = 'suspended'` bloquea de inmediato. `lib/licenses.js` (`stateOf`, caché de 60 s por firma) lo aplica en `lib/auth.js` y en el login con un mensaje claro. El panel permite **+1 mes / +12 meses**, suspender y reactivar (la firma de la plataforma no se puede suspender).
- **Administrador de la plataforma y vencimiento:** `root` (`is_platform_admin`) nunca queda bloqueado, aunque venza o se suspenda la licencia de su propia firma (`lib/auth.js` y login); los demás usuarios de esa firma sí. Así, si a la firma de la plataforma se le pone vencimiento (p. ej. un contrato de 2 años a US$150 al mes), `root` sigue administrando las licencias.
- **Tope de usuarios:** `direct_tenants.max_users` (null = sin tope) se valida al crear usuarios (`POST /api/users`).
- **Cobro con PayPal (suscripción mensual o anual por usuario):** los botones de tu web crean la suscripción elegida, de US$20 por usuario al mes o US$220 por usuario al año (un mes gratis), sin límite de usuarios. PayPal avisa al webhook `POST /api/licenses/paypal-webhook`, que **verifica la firma** con la API de PayPal, **consulta la suscripción** (la fuente de verdad es PayPal, no el aviso) y: (1) si es nueva y está `ACTIVE`, crea la licencia con el número exacto de usuarios pagados y le manda el enlace de activación; (2) en cada cobro (`PAYMENT.SALE.COMPLETED`) la vigencia de la firma pasa a `billing_info.next_billing_time` (idempotente: no se suma dos veces); (3) cancelar, suspender, vencer o fallar el cobro solo cambia `paypal_status`: lo ya pagado se respeta y, si no hay más cobros, la firma vence sola (gracia de 5 días). Una suspensión puesta a mano por root no se revierte con un cobro. El webhook escribe en los logs de Vercel cada aviso recibido, si la firma no se pudo verificar (y por qué) y el resultado (`[paypal] …`), para diagnosticar. Los avisos se registran en `direct_paypal_events` (sin duplicados; un aviso que falló se reintenta). Planes autorizados: mensual `P-40C63856H2223050UNLRQ22A` y anual `P-3Y610531YH220333YNLRQ22I`. Migración `202610290002_paypal.sql`.
- Migración `202610290001_licencias.sql`. Pruebas: `npm run test:licenses` (API de punta a punta en el stack local: permisos, activación, aislamiento, vencimiento, suspensión, tope).

---

## Pruebas

```bash
npm run test:direct   # app Direct + relay (worker.js)
npm run test:nala     # flujo fiscal NALA (unit + UI)
npm run test:licenses # licencias y alta de firmas (stack local)
```

---

## Migraciones requeridas

Aplica las migraciones de `supabase/migrations/` en orden. Entre otras: crean el tenant inicial `Save` y asocian los datos actuales, activan la sesión única por usuario, crean las tablas de NALA y los eventos de Direct (historial de entradas y permisos por empresa).

---

## Alta de una empresa nueva y carga por Excel

**CAMI · análisis guardados.** Tabla `cami_analisis` (migración `202610230001_cami_analisis.sql`: por tenant, `borrador` único por usuario con índice parcial, `data` jsonb comprimido `{v,gz}`, `resumen` para la lista; RLS cerrada, solo service role). API en `lib/cami-analisis.js`, enrutada desde `api/ir2/resumen.js` con `?tipo=cami-analisis` (sin función serverless nueva): `GET` lista / `?id=` / `?borrador=1`, `POST` (borrador, copia nueva o actualizar por `id`), `DELETE`. Permiso: administrador o `access_cami`; borrar copia: autor o administrador. Cliente: `public/cami/analisis.js` (cargado al final de `itbis-web.html`): captura `STATE`/`CARD_STATE`/`IR2_STATE`, nombres de archivo y los campos con `id`; comprime con `CompressionStream`; autoguarda con debounce de 1.8 s enganchando `handleFile`/`handleCardFile`/`handleIR2File`/`resetMod`/`resetIR2` y los eventos `input`/`change`; usa el token de la pestaña de Direct (`window.opener`, con `directRefresh` ante un 401). Pruebas: `npm run test:cami`.

**Cron de Nómina.** `lib/nomina/cron.js` debe importar el cliente como `const supabase = require('../supabase')` (el módulo exporta el cliente directamente, no un objeto): con `{ supabase }` quedaba `undefined` y `/api/nomina/cron` (Vercel cron `0 13 * * *`) fallaba con «Cannot read properties of undefined (reading 'from')».

**Formulario IR-2 (`public/ir2/`).** `formulario.js` define las casillas del formulario (`CAS`: celda de la plantilla, tipo `in`/`calc`/`pct`), sus fórmulas (`compute`, mismas del Excel oficial) y `buildXlsx`, que edita el XML de `IR-2.template.xlsx` (copia del Excel de la DGII sin vínculos externos ni datos de empresa; hoja protegida como el original) escribiendo solo los valores de las celdas: conserva diseño, celdas combinadas y fórmulas internas, y deja `fullCalcOnLoad`. Las casillas calculadas escritas a mano se escriben como valor fijo. La pestaña «Formulario IR-2» de `index.html` toma los valores automáticos de `derivados()` (A/B ← ingresos brutos, 1 ← utilidad antes de ISR, 2 ← no deducibles, 3 ← exentos, 8 ← pérdidas anteriores, 13 ← anticipos, 14 ← retenciones, 21 ← ISR percibido) y guarda lo manual en `localStorage` (`ir2_form_<rnc>_<año>`). Pruebas: `npm run test:ir2`.

**Exportar Excel (Estimación Fiscal).** `exportEstimacion` (`public/dgii/index.html`) arma con SheetJS un libro con una hoja por módulo de `MODS` (columnas en `EXPORT_COLS`, totales en `EXPORT_SUMAR`) a partir de `DATA` y lo descarga como `ESTIMACION <NOMBRE> <AÑO>.xlsx`; sin llamadas al servidor.

**Importar IR-2 (Excel).** `importIr2File` (`public/dgii/index.html`, pestaña Gastos NCF) lee con `/cami/vendor/xlsx.full.min.js` la hoja `606` del Excel del IR-2: localiza el encabezado («Tipo Bienes y Servicios Comprados», «Total Monto Facturado»), agrupa por código de tipo (01–11) y arma filas `{tipo_gasto:'NN - Nombre', monto, cantidad_ncf, ajuste_de}` con el catálogo de NALA. Reemplaza las filas de los tipos presentes y verifica RNC (hoja `J`) y año (Fecha Comprobante). Suma las líneas del 606, no el resumen del archivo (que puede diferir).

**Anexo J (`public/ir2/anexos.html`).** `importGastos` lee `data.gastos` de `GET /api/ir2/resumen?tipo=dgii-modulos` enviando `Authorization` y `X-Direct-Session` (de `localStorage.direct_session_id`); sin ese encabezado el servidor responde 401. Si la respuesta no es OK se muestra un aviso en `#source-note`.

**Estimación Fiscal ← NALA (606).** `applyNalaGastos` (`public/dgii/index.html`) mezcla las filas `origen:'nala'` (refrescadas en cada carga desde `fuente=nala`) con las del usuario, que se conservan; una fila de NALA editada a mano pasa a ser del usuario y guarda `ajuste_de` (tipo de gasto original) para que no se vuelva a agregar. Aviso si una fila manual repite un tipo de gasto de NALA; «Dejar solo NALA» (`replaceGastosNala`) borra las manuales.

**CAMI — detección de columnas.** `detectCols` (`public/cami/itbis-web.html`) busca primero por alias exactos; para `itbis_retenido` (606/607) y `retenido` (tarjetas) añade un respaldo que acepta cualquier encabezado con «reten…» que no sea ISR/renta/tipo/porcentaje (p. ej. «ITBIS Retenido por Terceros» del 607 de NALA). En NALA, el cuadro de advertencias de exportación (`askWarnings`) trae el motivo prellenado.

**Sincronizar con la lista oficial (Direct).** Nombre y RNC de las empresas de la bóveda van dentro del `ct` cifrado de `direct_credentials`, por lo que solo se pueden cambiar en el navegador. El botón admin «Sincronizar con lista oficial» (`openSyncModal`/`applySync` en `public/index.html`) descifra cada credencial, la cruza con `GET /api/clients` (`direct_clients`) por RNC o nombre exacto (sin sufijos SRL/EIRL/SA…), y re-cifra con `companyName` y `rnc` oficiales vía `POST /api/credentials` (lotes de 40, mismos `id`). Opcionalmente crea las empresas oficiales ausentes como acceso `dgii` (`username` = RNC, clave vacía). Coincidencias por prefijo solo se listan.

**CAMI — tipo de ITBIS por factura (607) y revisión del 606** (`public/cami/itbis-web.html`). `process607(rows, overrides)` acepta un mapa `{índice de factura: tasa}`; con la tasa elegida y el ITBIS facturado reconstruye `_gravado = ITBIS / tasa` y deja el resto como `_exento`, y devuelve `facturas` (para el panel) y `overrides` (se guardan en el snapshot del análisis). `setTipo607` reprocesa `allRows` con los nuevos tipos y vuelve a renderizar. `process606` devuelve `revision`: una fila por factura con alertas (`Sin NCF`, `NCF inválido`, `NCF duplicado`, `Sin RNC`, `Sin fecha`, `ITBIS mayor al 18%`, `Retenido mayor al ITBIS`), mostradas en una tabla con búsqueda, filtro y páginas de 100. Por factura, si las formas de pago suman `|monto| + ITBIS` (y no `|monto|`), el monto del 607 se interpreta como **sin ITBIS** y `_total` = monto + ITBIS; así el cuadre de formas de pago del IT-1 no deja diferencia. `get607GrossTotal` aplica la misma regla en conjunto (formas de pago = bruto + ITBIS ⇒ bruto + ITBIS), y `analisis.js` reprocesa 606/607 desde `allRows` al restaurar un análisis guardado. `process607` devuelve `summary.constr` ({count, facturado sin ITBIS, gravado, exento, itbis}) de las facturas `C18`; `exportIT1DGII` pone `constr.facturado` en `T56` del Anexo A (casilla 34), cachea `W56/T59/W59/W60` (monto sujeto = 10 %), suma ese monto a `V26` del IT-1 y resta `constr.exento` de `V18` (la casilla 38 llega a `V20` por la fórmula de la plantilla). El tipo `C18` («18 % Construcción») calcula igual que 18 % (base gravada = ITBIS ÷ 0,18, el resto exento) pero suma en la tarjeta «ITBIS Construcción» (`byTasa.t10`) en vez de en la de 18 %.

Cuando se vende el sistema a una firma nueva (p. ej. `Contadores del Este`), se crea primero su **tenant** y su administrador. Ese administrador no hereda usuarios, clientes ni credenciales de Save. Luego se sube el Excel de esa firma, que valida encabezados, formatos y duplicados y crea/actualiza solo sus clientes. Una carga debe ejecutarse siempre dentro del tenant correcto.

El script `upload-companies.mjs` lee el Excel de credenciales y las sube a la bóveda cifrada:

```bash
DIRECT_ADMIN_PASS='…' node upload-companies.mjs ruta/al/archivo.xlsx   # DIRECT_ADMIN_USER opcional (por defecto root)
```

El script inicia sesión como admin, deriva el masterKey en local, cifra cada credencial con AES-256-GCM y hace PUT a la API. El servidor nunca ve las contraseñas en texto plano.
