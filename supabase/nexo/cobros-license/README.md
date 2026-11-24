# Función `cobros-license` (proyecto Nexo)

Permite que **Cobros** (Direct) suspenda y reactive una empresa de Nexo por falta de pago. Se despliega en el proyecto
Supabase de **Nexo** (no en el de Direct). Es una Edge Function sin JWT; la autorización es un secreto compartido.

1. Genera un secreto largo (mínimo 24 caracteres; recomendado 48+ aleatorios).
2. **Nexo** (Supabase → Edge Functions → Secrets): `NEXO_COBROS_SECRET = <secreto>`.
3. **Vercel** (proyecto de Direct → Environment Variables, tipo Secret): `NEXO_COBROS_SECRET = <el mismo secreto>`.
   Opcional: `NEXO_COBROS_URL` (por defecto `https://jwdwhqzviikwreemkxzh.supabase.co/functions/v1/cobros-license`).
4. Desplegar la función `cobros-license` con `--no-verify-jwt` (código en `index.ts`).
5. En Cobros → Planes → el plan: «Pasar a modo REAL» comprueba la conexión con `action: status` antes de activarse.

Acciones: `status`, `suspend`, `reactivate` y `mark_paid` (avisa a Nexo de un pago recibido en Cobros: marca el período en `payment_reminder.paid_period` para que la regla antigua no suspenda a quien ya pagó). Resuelve la empresa por id o por nombre exacto; nunca suspende «CaSa Labs»;
cada cambio queda en `license_events`. La regla antigua de Nexo (`enforce_payment_deadlines`, con `settings.payment_reminder`)
sigue activa: al pasar una empresa a Cobros hay que quitarle `payment_reminder` para no tener dos reglas.
