# Nómina (módulo de Direct/SERP)

Cálculo de nómina por empresa, integrado en SERP. Reutiliza el login, los
usuarios y las empresas (`direct_clients`) de SERP. Es el **núcleo**: empresas →
columnas dinámicas → empleados → períodos editables con totales/neto → Excel.

## Acceso y alcance

- Permiso propio **`access_nomina`** en `direct_profiles` (como `access_nala`).
  Lo concede el administrador por usuario (formulario de usuarios en SERP).
- El alcance por empresa reutiliza `companies_direct` del perfil (null = todas),
  igual que el resto de Direct: un usuario limitado no ve ni toca la nómina de
  empresas que no le corresponden. Todo filtra por `tenant_id` en el servidor.

## Piezas

- `api/nomina.js` — único punto de entrada (una función Vercel, como NALA).
  `vercel.json` reescribe `/api/nomina/<ruta>` → `/api/nomina?route=<ruta>`.
- `lib/nomina/context.js` — autenticación (reusa `lib/auth`) y puerta `access_nomina`.
- `lib/nomina/api.js` — manejadores: empresas, columnas, empleados, períodos,
  guardado de valores y exportación.
- `lib/nomina/formula.js` — **evaluador de fórmulas seguro** (parser propio, sin
  `eval`/`Function`): números, `+ - * /`, paréntesis, referencias a columnas por
  su clave y funciones `round/abs/min/max/floor/ceil`. Lo demás es error.
- `lib/nomina/compute.js` — cálculo del período: evalúa fórmulas en orden,
  ingresos/deducciones/neto por empleado, totales por columna y resumen.
- `lib/nomina/excel.js` — exportación a `.xlsx` (ExcelJS).
- `public/nomina/index.html` — app de una sola página (iframe, igual que NALA):
  pestañas Empleados / Columnas / Períodos; la tabla del período recalcula el
  neto en vivo con un espejo del evaluador de fórmulas. Incluye el **volante de
  pago** por empleado (ingresos/deducciones/neto + firma): **🧾 Imprimir**
  (abre una ventana con uno o todos los volantes del período y lanza la
  impresión) y **⤓ Descargar PDF** de un clic (PDF vectorial generado con jsPDF
  cargado bajo demanda desde cdnjs; uno por empleado o todos juntos, con el logo).
- `supabase/migrations/202610160001_nomina.sql` — tablas `nomina_*`, RLS cerrada
  al navegador y la columna `access_nomina`.

## Modelo de datos (`nomina_*`, por tenant)

- **`nomina_columns`** — conceptos de cada empresa. `type`: `monto` (dinero),
  `numero` (cantidad), `texto` (nota), `formula` (se calcula). `sign` (+1 ingreso,
  −1 deducción, 0 neutro) e `include_total` definen el neto. `key` es el
  identificador usado en las fórmulas (único por empresa). FK compuesta
  `(tenant_id, client_id)` → `direct_clients`.
- **`nomina_employees`** — empleados manuales (nombre, cédula, puesto, activo).
- **`nomina_periods`** — períodos (`label`, año/mes, `status` draft/closed).
- **`nomina_entries`** — valores capturados por empleado y período (`values`
  jsonb: clave→valor). Las columnas de fórmula **no** se guardan: se calculan.

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
