# Acerca de SERP

**SERP** es una plataforma contable multiempresa para firmas que gestionan los trámites de sus clientes en los portales dominicanos (DGII, TSS, Ministerio de Trabajo, SISALRIL, bancos, etc.). Centraliza, en un solo lugar y con las credenciales cifradas de extremo a extremo, el acceso a esos portales y las herramientas fiscales del día a día.

- **Producción:** https://app.casalabs.com.do
- **Relay de portales:** `portal-rd-relay.samauel05.workers.dev` (Cloudflare Worker)

> Este archivo y el [`README.md`](README.md) se mantienen al día con cada cambio del repositorio.

## Para qué sirve

- **Bóveda de credenciales cifradas** por empresa cliente, con auto-login a los portales del gobierno y bancos sin extensiones de navegador.
- **Flujo fiscal 606/607 (NALA)**: carga de facturas, extracción con IA, validación, auditoría, aprobación y generación del TXT y de la Herramienta de Envío oficial de la DGII.
- **Herramientas contables**: CAMI (ITBIS / IT-1), IR-2 (renta) y Estimación Fiscal.
- **Gestión de clientes** por empresa operadora, con carga masiva por Excel.

## Cómo está construido

| Capa | Tecnología |
|------|------------|
| Frontend | HTML + CSS + JS vanilla (sin frameworks) |
| Cifrado | Web Crypto API — AES-256-GCM + PBKDF2 (en el navegador) |
| Backend | Vercel Serverless Functions (Node.js) |
| Base de datos | Supabase (PostgreSQL), acceso solo por rutas de servidor con rol de servicio |
| Relay de portales | Cloudflare Worker (`worker.js`) |
| Despliegue | Vercel (`app.casalabs.com.do`) + Cloudflare, auto-deploy desde `main` |

## Principios

- **Privacidad por diseño**: el servidor nunca ve credenciales ni nombres de empresa en texto plano; todo se cifra/descifra en el navegador con la contraseña del usuario.
- **Aislamiento multiempresa (tenant)**: cada firma solo ve sus propios datos.
- **Aislamiento por empresa en el relay**: abrir varias empresas del mismo portal no mezcla sesiones.
- **Sin extensiones**: los portales funcionan a través del relay «como un sistema normal».

## Estado y novedades recientes

- **Direct — mejoras de la vista de empresas de un portal**: al cerrar sesión ahora se pide confirmación («¿Seguro que quieres salir?») para evitar salidas accidentales (los cierres automáticos por inactividad o sesión reemplazada siguen siendo inmediatos). La misma confirmación se pide al salir de cualquier módulo (NALA, CAMI, IR-2, Estimación Fiscal) con «Volver». El buscador de empresas se movió arriba, más grande y claro (filtra por nombre o RNC en vivo). La lista de empresas sale en orden alfabético. Se quitó el banner con el nombre del portal (era redundante) y «Configurar URL» ahora solo lo ve el administrador. «Sincronizar Excel» pasó a ser un enlace pequeño al final.

- **Guía central de empresas — autocompletado nombre ↔ RNC en todo el sistema**: la lista de clientes de la firma es ahora la fuente única para rellenar empresa y RNC. En Estimación Fiscal, IR-2 (declaración y resumen), CAMI (ITBIS e IR-2) y en el formulario de empresa cliente de NALA, al escribir o elegir el nombre de una empresa conocida se rellena su RNC solo, y al escribir un RNC conocido se rellena el nombre; el campo muestra la lista de empresas para elegir. Un solo conector (`public/js/empresas.js`) consume `/api/clients` (aislado por firma); NALA usa su propia lista ya cargada. Además se limpió la base de clientes (se quitó el prefijo «GENERALES » que traía la importación y se fusionaron los duplicados), así que la lista de Clientes quedó limpia.

- **Sesión que no se cae a mitad de trabajo (renovación silenciosa)**: el token de acceso dura 1 hora; antes, al pasar ese tiempo, guardar en Estimación Fiscal (u otra pantalla) fallaba con «Tu sesión expiró» y había que volver a entrar. Ahora la app renueva la sesión sola —de forma proactiva unos minutos antes de vencer y, si hace falta, al vuelo cuando una petición recibe 401— reintentando el guardado sin que el usuario tenga que relogearse ni perder lo que tiene en pantalla. La renovación corre en el servidor (la anon key de Supabase nunca sale de ahí) y mantiene la sesión única por equipo: un navegador ya desplazado por otro no puede renovarse. El iframe de Estimación pide la renovación a la app y reintenta su guardado automáticamente.
- **Estimación Fiscal — jalado automático del 606/607 desde la DGII**: en la pestaña de Envíos, «Jalar de DGII» abre la Oficina Virtual de esa empresa por el relay (auto-login) y ahí el relay muestra un botón flotante **«Traer 606/607 a SERP»**. Al pulsarlo en «Consulta de Envíos», el relay serializa la tabla y la manda a la app, que la vuelca en el importador de la pestaña de Envíos con vista previa (el sistema trae los datos solo, sin copiar/pegar ni capturas de pantalla; se confirma con «Agregar filas» porque son montos). La captura está aislada tras una bandera: solo aparece cuando se lanzó con «Jalar de DGII» y solo en la DGII, sin afectar el auto-login de ningún portal.
- **Estimación Fiscal — importar Envíos 606/607 (ingesta)**: la pestaña de «Consulta Envíos» ahora tiene un botón «Importar / Pegar 606-607»: se pega la tabla de envíos de la Oficina Virtual (o de Excel) y el módulo detecta las filas y calcula los totales solo, sin tecleo (tolerante a formato de números dominicano y US, con vista previa antes de aplicar). Es la primera etapa para automatizar la estimación; el cálculo fiscal y el jalado automático desde la DGII vienen después.

- **Direct — Citrus, ONAPI, Formalízate e IDOPPRIL con acceso directo**: estos portales ya tienen su URL de inicio de sesión configurada, así que se abren y autollenan a través del relay como el resto (Citrus `ecf.citrus.com.do`, ONAPI `onapi.gob.do/siteServices`, Formalízate `vu.formalizate.gob.do`, IDOPPRIL `idoppril.gob.do`). Antes estaban definidos pero sin URL, por lo que no se podían abrir.
- **Seguridad — aislamiento por firma reforzado**: los datos de IR-2 / Estimación Fiscal y la configuración (incluido el verificador de bóveda y la config de portales) ahora están ligados a la firma (tenant) a nivel de base de datos y de API. Antes IR-2 se consultaba solo por RNC, lo que podía dejar ver datos de otra firma; ahora cada firma solo accede a lo suyo. También se endurecieron las cabeceras (CSP/HSTS), el escape de datos en pantalla y la validación de entradas.
- **Direct — abrir varias empresas a la vez (portales SPA)**: ahora se pueden abrir varias empresas del mismo portal SPA (Ministerio de Trabajo, SISALRIL) al mismo tiempo sin que la segunda herede la sesión de la primera. El relay aísla por empresa todo el estado que compartían las pestañas del mismo origen: el almacenamiento (localStorage + IndexedDB), las cookies que la propia app escribe con `document.cookie` (el token `Abp.AuthToken` del framework ABP, que era la causa real de que se repitiera la empresa) y los canales entre pestañas (BroadcastChannel y SharedWorker por empresa; Service Worker desactivado). Activo siempre, de forma transparente.
- **Direct — logos en favoritos y recientes**: las tarjetas de inicio (favoritos y recientes) ahora cargan el logo oficial nítido de cada portal (p. ej. la cúpula del Ministerio de Trabajo) en lugar del ícono de respaldo dibujado a mano.
- **Direct — panel de uso (admin)**: vista en vivo dentro de la app con los accesos a portales (KPIs, por día, por usuario, por portal y por hora).
- **Direct — logos de portales**: Azul usa un logo limpio sólido y Cardnet su marca oficial (la «N» rosada) servida localmente; ONAPI e IDOPPRIL usan su ícono oficial servido localmente (su wordmark raspado era blanco/invisible o no se obtenía). Así todos se ven nítidos sin depender del sitio externo.

- **NALA — 607 igual que el 606**: copiar/pegar en la Herramienta de Envío y llenado del Excel con macro, también para el 607.
- **Direct — mejoras de accesos**: favoritos y recientes, aviso de contraseña vencida, revisión de tarjetas de códigos DGII, calendario de vencimientos, historial de entradas (admin) y permisos por empresa.
- **Relay — sesión por empresa (blindaje)**: al abrir una segunda empresa del mismo portal (p. ej. Ministerio de Trabajo o SISALRIL), su sesión ya no hereda la de la primera. Además de las cookies, el `localStorage` y el `IndexedDB` separados por empresa, los portales SPA ya no usan la cookie compartida de «último flujo» (`serp_lastflow_`) ni reenvían cookies de otra pestaña cuando una petición llega sin flujo.
- **SISALRIL — panel semi-automático**: como su login con Keycloak impide el auto-login por relay, Direct guía el acceso en 2 pasos (copia correo y contraseña con un toque).

Para el detalle técnico de cada módulo y portal, ver [`README.md`](README.md) y `docs/`.
