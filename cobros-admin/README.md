# Panel de cobros

Panel web de administración (todo en español) para una pequeña empresa de República Dominicana que cobra servicios:
clientes, cobros, recordatorios de pago y promociones por correo y WhatsApp.

**Stack:** Next.js 14 (App Router) · TypeScript · Tailwind CSS · Supabase (Postgres + Auth + RLS, `@supabase/ssr`) ·
Resend (correo) y Twilio (WhatsApp) por `fetch`, sin SDKs · Vercel con un cron diario.

## Funciones

| Sección | Qué hace |
|---|---|
| Login | Correo + contraseña (se normaliza con trim y minúsculas). Distingue «credenciales incorrectas» de «error de conexión». El middleware protege todo salvo `/login` y `/api/cron/*`. |
| Resumen | Por cobrar, vencido y cobrado del mes **separados por moneda** (RD$ y US$, nunca sumados), número de clientes y últimos mensajes. |
| Clientes | Alta y baja, etiquetas separadas por coma, consentimiento por canal (`opt_in_email`, `opt_in_whatsapp`) y botón de **baja** por canal. |
| Cobros | Crear (moneda DOP por defecto o USD), aviso opcional al crear, recordatorio manual y marcar pagado. Montos con `Intl` `es-DO`. |
| Promociones | Campaña por correo, WhatsApp o ambos, a todos o a una etiqueta; variables `{{nombre}}` `{{empresa}}` `{{negocio}}`. Respeta siempre `opt_in_*`. |
| Historial | Todos los envíos con su estado y el error si falló. |
| Cron | `/api/cron/reminders` (diario): marca vencidos y recuerda 3 días antes, 1 día antes, el día del vencimiento y cada 3 días en mora; máximo un aviso por día por cobro. |

Reglas de diseño: toda escritura usa Server Actions (la única API route es el cron); cada acción verifica la sesión;
la clave `service role` solo se usa en el cron (`src/lib/supabase/admin.ts`, marcado `server-only`); cada envío, también el fallido,
queda en `message_log` con su error; si falta una credencial de Resend o Twilio el envío falla de forma controlada y se registra.
Los recordatorios también respetan `opt_in_*` y la existencia del correo/teléfono.

## Puesta en marcha

### 1. Supabase
1. Crea un proyecto en <https://supabase.com>.
2. Aplica las migraciones de `supabase/migrations/` (SQL Editor, o `supabase db push` con la CLI).
3. **Authentication → Users → Add user**: crea el usuario administrador (correo y contraseña, marca «Auto Confirm User»).
4. **Authentication → Sign In / Providers → Email**: desactiva **Allow new users to sign up** (registro libre). Sin esto cualquiera
   podría crear una cuenta y, al estar autenticado, leer todas las tablas.
5. En **Project Settings → API** copia la URL, la `anon key` y la `service_role key`.

### 2. Variables de entorno
Copia `.env.example` a `.env.local` y complétalo (en Vercel van en *Settings → Environment Variables*):

| Variable | Uso |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Cliente web/servidor con sesión del usuario |
| `SUPABASE_SERVICE_ROLE_KEY` | **Solo el cron.** Nunca con prefijo `NEXT_PUBLIC_` |
| `CRON_SECRET` | Vercel lo envía como `Authorization: Bearer …` al cron |
| `RESEND_API_KEY`, `RESEND_FROM` | Correo (el dominio del remitente debe estar verificado en Resend) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` | WhatsApp, ej. `whatsapp:+14155238886` |
| `BUSINESS_NAME` | Valor de `{{negocio}}` y firma de los mensajes |

### 3. Desarrollo local
```bash
cd cobros-admin
npm install
npm run dev          # http://localhost:3000
npm run typecheck    # tsc --noEmit
npm run build        # next build
```

### 4. Despliegue en Vercel
1. Importa el repositorio y en **Root Directory** elige `cobros-admin`.
2. Carga las variables de entorno de arriba.
3. Despliega. `vercel.json` registra el cron diario (`0 12 * * *` UTC = 8:00 a. m. en RD). Los cron de Vercel solo corren en producción.
4. Prueba el cron a mano:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://TU-APP.vercel.app/api/cron/reminders
   ```

## Limitaciones (léelas antes de usar en producción)

- **WhatsApp:** fuera de la ventana de 24 h desde el último mensaje del cliente, Meta exige **plantillas aprobadas**. Los mensajes
  libres de recordatorios y promociones solo llegan si el cliente escribió en las últimas 24 h; para el resto hay que registrar
  plantillas en Twilio y enviarlas con `ContentSid` (no incluido). Los fallos quedan en el historial con el error de Twilio.
- **Pagos:** el cobro ocurre en el enlace de pago externo (Azul, CardNET, Fygaro, PayPal). El sistema registra y recuerda,
  **no procesa pagos** ni concilia: hay que marcar «pagado» manualmente.
- **Envíos masivos:** el envío es síncrono dentro de una Server Action (lotes de 5, máximo 150 destinatarios por campaña, 60 s en Vercel).
  Para listas grandes hace falta una cola (Supabase Queues, Inngest, QStash…).
- **Baja:** cada promoción añade «responde BAJA» y exige confirmar el consentimiento. Como no hay API pública, la baja es manual:
  cuando el cliente responde BAJA se pulsa «baja» en *Clientes*, lo que apaga el canal. Antes de envíos masivos serios conviene un enlace
  de baja con token firmado (requeriría una ruta pública).
- Las fechas de vencimiento y el «hoy» del cron usan la zona `America/Santo_Domingo`.
