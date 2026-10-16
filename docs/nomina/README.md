# Nómina (módulo de Direct/SERP)

Cálculo de nómina por empresa, integrado en SERP. Reutiliza el login y los
usuarios de SERP; **las empresas son propias del módulo** (`nomina_companies`):
el usuario las crea dentro de Nómina (pestaña **Empresas**) y les sube la nómina.
Es el **núcleo**: empresas → columnas dinámicas → empleados → períodos editables
con totales/neto → Excel.

## Acceso y alcance

- Permiso propio **`access_nomina`** en `direct_profiles` (como `access_nala`).
  Lo concede el administrador por usuario (formulario de usuarios en SERP).
- Las empresas de Nómina son propias del módulo y **por tenant**: cualquier
  usuario con `access_nomina` ve y gestiona las empresas que se hayan creado en
  Nómina (ya no se reutiliza `companies_direct`, que refería a clientes de
  Direct). Todo filtra por `tenant_id` en el servidor.

## Piezas

- `api/nomina.js` — único punto de entrada (una función Vercel, como NALA).
  `vercel.json` reescribe `/api/nomina/<ruta>` → `/api/nomina?route=<ruta>`.
- `lib/nomina/context.js` — autenticación (reusa `lib/auth`) y puerta `access_nomina`.
- `lib/nomina/api.js` — manejadores: empresas (crear/editar/borrar/listar),
  columnas, empleados, períodos, guardado de valores y exportación.
- `lib/nomina/formula.js` — **evaluador de fórmulas seguro** (parser propio, sin
  `eval`/`Function`): números, `+ - * /`, paréntesis, referencias a columnas por
  su clave y funciones `round/abs/min/max/floor/ceil`. Lo demás es error.
- `lib/nomina/compute.js` — cálculo del período: evalúa fórmulas en orden,
  ingresos/deducciones/neto por empleado, totales por columna y resumen.
- `lib/nomina/excel.js` — exportación a `.xlsx` (ExcelJS).
- `public/nomina/index.html` — app de una sola página (iframe, igual que NALA):
  pestañas **Empresas** / Nómina / Empleados / Columnas / Ajustes (la empresa
  activa se elige y crea desde la pestaña Empresas; se recuerda en el navegador).
  La tabla del período recalcula el
  neto en vivo con un espejo del evaluador de fórmulas. Incluye el **recibo de
  nómina** por empleado, con el formato de un recibo real firmable: la empresa
  (razón social + RNC) y la fecha arriba, el título **«RECIBO DE NÓMINA»** con el
  período, la **declaración** («Yo, _Empleado_, …, he recibido de la compañía
  _Empresa_ la suma de _monto en letras_ (RD$ _monto_), correspondiente al pago de
  _período_»), y a continuación una **tabla con el formato de declaración TSS**
  (helper `tssFields` → `payslipHTML`): las 11 columnas del Excel que usan los
  clientes —**Nombre completo, Documento, NSS, Salario SS, Salario ISR, Salario
  INFOTEP, Saldo a favor, Remuner. otros agentes, Otras remuneraciones, Ingresos
  exentos, Agente retención ISR**— con los **montos mensuales de declaración**
  (`sueldo_mensual`; una persona `exento_tss` no cotiza → SS/INFOTEP en 0). Cierra
  con el **Total a cobrar** (neto de la quincena), dos firmas **«Entregado por» /
  «Recibido por»** y al pie la marca **Casa Labs**. El monto a cobrar se escribe
  también en letras (`montoEnLetras`, con apócope correcto: «veintiún», «treinta y
  un mil»). Se genera con **🧾 Imprimir** (abre una ventana con uno o todos los
  recibos del período y lanza la impresión) y **⤓ Descargar PDF** de un clic (PDF
  vectorial **apaisado** con jsPDF cargado bajo demanda desde cdnjs, para que la
  tabla de 11 columnas quepa a lo ancho; uno por empleado o todos juntos).
- `supabase/migrations/202610160001_nomina.sql` — tablas `nomina_*`, RLS cerrada
  al navegador y la columna `access_nomina`.

## Modelo de datos (`nomina_*`, por tenant)

- **`nomina_companies`** — empresas del módulo (nombre/razón social, `rnc`,
  `active`). El usuario las crea en la pestaña Empresas. `columns`/`employees`/
  `periods` apuntan a ella por FK compuesta `(tenant_id, client_id)`. La
  migración `202610170001_nomina_companies.sql` la crea, siembra las empresas
  que ya tenían datos (conservando su id) y repunta las FKs desde
  `direct_clients`.
- **`nomina_columns`** — conceptos de cada empresa. `type`: `monto` (dinero),
  `numero` (cantidad), `texto` (nota), `formula` (se calcula). `sign` (+1 ingreso,
  −1 deducción, 0 neutro) e `include_total` definen el neto. `key` es el
  identificador usado en las fórmulas (único por empresa). FK compuesta
  `(tenant_id, client_id)` → `nomina_companies`.
- **`nomina_employees`** — empleados manuales (nombre, cédula, **NSS**, puesto, activo).
- **`nomina_periods`** — períodos (`label`, año/mes, `status` draft/closed,
  `cycle` p. ej. `2026-10-B`, `pay_date`, `novedades_locked`).
- **`nomina_entries`** — valores capturados por empleado y período (`values`
  jsonb: clave→valor). Las columnas de fórmula **no** se guardan: se calculan.

Campos para el automático: `nomina_companies.auto_nomina` (entra a la
generación automática), `nomina_companies.pinned` (empresa fijada: sale primero
en la lista), `nomina_columns.carry` (columna **fija**: su valor se arrastra a la
próxima quincena; si es `false`, es **novedad** y arranca en 0).

## Generación automática de nómina (quincenal)

Un cron de Vercel (`/api/nomina/cron`, diario 09:00 RD) genera la nómina sola
para todas las empresas **quincenales** con `auto_nomina = true`:

- **Quincena 1** (se paga ~15): novedades abiertas hasta el **día 12**; se
  **genera el 13**.
- **Quincena 2** (se paga ~30): novedades hasta el **día 26**; se **genera el 28**.
- Al pasar el corte, la nómina en curso se **bloquea** (`novedades_locked`) y se
  abre la **siguiente** en borrador; lo que se capture después del corte cae
  automáticamente en la próxima. Al llegar el día de generación, el período
  bloqueado se **cierra** (`status = closed`).

Al abrir la nueva quincena sólo se arrastran las columnas **fijas**
(`carry = true`: por defecto `sueldo_mensual`, `cobra_entero`, `exento_tss`,
`seguro`); las demás (bono, otros ±, préstamo) arrancan vacías. La lógica
(`lib/nomina/cron.js`) es **idempotente** (índice único por `(tenant, client,
cycle)` + chequeos), así repetir o saltar un día no duplica ni rompe nada; usa
hora de RD (UTC−4). El cron se autentica por secreto de servidor
(`NOMINA_CRON_SECRET` o `CRON_SECRET`), igual que el worker de NALA. En el grid,
una nómina bloqueada se muestra en **solo lectura** con el aviso «🔒 Novedades
cerradas (corte)» y un botón **Reabrir novedades** por si hay que corregir.

## Pago de mes completo ("cobra entero") y seguro

Para empleados que cobran el **mes entero en una quincena** (socios, pagos
mensuales), una empresa puede tener una columna **`cobra_entero`** (tipo
`numero`, 0/1; en el grid se muestra como interruptor Sí/No). Las fórmulas de
ley la usan como factor `(1+cobra_entero)`: con 0 van quincenales (sin cambio),
con 1 pagan el mes completo y aplican las deducciones de mes entero. Para que el
imponible no se duplique, su fórmula divide por `(1+cobra_entero)`:
`round(sueldo_mensual-(sfs+pension)*p_div/(1+cobra_entero)+otros_mas*p_div,2)`.
La columna **`seguro`** (tipo `monto`, signo −1) es una deducción aparte (seguro
médico).

El imponible también **suma los ingresos extra** de la columna `otros_mas`
(Otros +) con `+otros_mas*p_div`, para que el ISR salga de todos los ingresos
percibidos y no solo del sueldo. Como el imponible es mensual, el extra
quincenal se anualiza con `p_div` igual que el sueldo (se trata como ingreso
recurrente); por eso un extra sube tanto el neto como su ISR correspondiente.

## Reglas de cálculo

Las tasas de ley no van fijas en las fórmulas: `paramsFromSettings` inyecta los
ajustes de la empresa al scope con prefijo `p_` (`p_div` = divisor del período
quincenal/mensual, `p_afp`, `p_sfs`, `p_tope_sfs`, `p_isr_ex/t2/t3`…), así
editar Ajustes recalcula AFP/SFS/ISR. `computeRow(columns, values, params)` y
`computePeriod(..., {settings})` los propagan; el cliente los deriva de
`S.period.settings`. `validate()` permite refs `p_*` (son parámetros, no columnas).

Por empleado: las columnas `monto`/`numero` entran como números; las de
`formula` se evalúan en orden de `position` (una fórmula puede usar otra ya
calculada). Neto = Σ(valor) de columnas `monto`/`formula` con `include_total`,
sumando las de signo + y restando las de signo −. Montos redondeados a 2
decimales. La misma lógica corre en el servidor (`compute.js`, autoritativa al
guardar/exportar) y en el navegador (para el neto en vivo).

## Ajustes de la empresa (tasas configurables)

`lib/nomina/settings.js` define las tasas por defecto RD (empleado AFP 2.87% /
SFS 3.04% con topes, escala ISR, aportes del empleador AFP 7.10% / SFS 7.09% /
SRL / INFOTEP 1%) y las guarda por empresa en `nomina_settings` (una fila por
tenant+empresa; sin fila = defaults). Endpoints `GET/PUT
/api/nomina/clients/:id/settings`; `sanitize()` valida que las tasas estén en
[0,1]. Los empleados tienen `forma_pago` (texto). Migración aditiva
`202610160002_nomina_ajustes.sql` (no toca datos existentes).

## Ficha del empleado (historial)

`GET /api/nomina/employees/:id/history` (`api.employeeHistory`) devuelve el
empleado y, por cada período en que aparece, sus ingresos/deducciones/neto ya
calculados (con `computeRow`) más los acumulados. El frontend lo muestra como
«Ficha»: datos del empleado, KPIs acumulados y la tabla de períodos (cada fila
abre su período). Préstamos, descuentos y adicionales son simples **columnas**
(tipo monto, signo − o +) que se capturan en la celda del empleado en el período.

## Pruebas

```bash
npm run test:nomina   # evaluador de fórmulas + cálculo del período
```

## Pendiente (fuera del núcleo)

Carga masiva de empleados desde Excel, perfiles de empleado con notas fechadas,
y copiar los valores del período anterior.
