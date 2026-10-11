# Play Store — «Seguridad de los datos» (guía para el formulario)

Guía para llenar la sección **Seguridad de los datos** (Data safety) de Google
Play Console para la app **SERP**. Refleja lo que la app realmente hace a la
fecha. La Política de Privacidad pública que exige Play está en:

- **URL de la política:** `https://app.casalabs.com.do/privacidad.html`

> Antes de enviar: confirma el nombre legal del responsable y el correo de
> contacto en `public/privacidad.html` (marcados «por confirmar»).

## Respuestas generales

- **¿Tu app recopila o comparte datos de usuario?** → **Sí**.
- **¿Todos los datos están cifrados en tránsito?** → **Sí** (HTTPS/HSTS).
- **¿Ofreces una forma de solicitar la eliminación de datos?** → **Sí**
  (por correo de contacto; además la bóveda cifrada puede borrarse).
- **Recolección exclusiva para seguridad/anti-fraude (IP, logs):** se puede
  declarar como uso para **seguridad** y, si es efímero, marcarse así.

## Tipos de datos a declarar

Para cada tipo: **Recopilado = Sí**. «Compartido» = Sí solo si se envía a un
tercero que lo usa por su cuenta; nuestros proveedores son **encargados**
(procesan por nosotros), que Google trata como «recopilado», no necesariamente
«compartido». OpenAI recibe los documentos de NALA para procesarlos → márcalo
según cómo Google clasifique tu caso (procesamiento por encargado).

| Categoría Google | Tipo de dato | Recopilado | Propósito | Opcional/Obligatorio |
|---|---|---|---|---|
| **Info personal** | Nombre (razón social de empresas clientes) | Sí | Funcionalidad de la app | Obligatorio para el módulo Clientes |
| **Info personal** | Correo electrónico (de empresas clientes) | Sí | Funcionalidad de la app | Opcional |
| **Info personal** | Teléfono (de empresas clientes) | Sí | Funcionalidad de la app | Opcional |
| **Info personal** | Otros IDs (RNC / cédula de clientes) | Sí | Funcionalidad de la app | Opcional |
| **Info financiera** | Otra info financiera (facturas/comprobantes 606-607 que se cargan en NALA) | Sí | Funcionalidad de la app | Opcional (solo si usas NALA) |
| **ID de usuario** | Nombre de usuario de la cuenta | Sí | Funcionalidad, gestión de la cuenta | Obligatorio |
| **Actividad en la app** | Interacciones dentro de la app (qué portal/módulo se abre, inicios de sesión, uso del buscador — sin el texto) | Sí | **Analítica** y funcionalidad | Obligatorio |
| **App info y rendimiento** | Logs / diagnóstico (IP y registros del servidor) | Sí | Seguridad / anti-fraude | Obligatorio |

### Credenciales de la bóveda (contraseñas de portales)

- Se almacenan **cifradas de extremo a extremo**; el servidor no las ve en
  claro. Google pide declarar si se recopilan credenciales:
  **«Info personal → Otros»** o el campo de credenciales según la versión del
  formulario, indicando que **están cifradas en tránsito** y **cifradas en
  reposo del lado del cliente** (el servidor no puede descifrarlas).
- Igual criterio para el **nombre de empresa** de la bóveda (cifrado).

## Qué NO recopilamos (para marcar «No»)

- Ubicación, contactos del teléfono, SMS, fotos/vídeos del dispositivo,
  micrófono, salud, mensajes personales.
- **Historial de búsqueda**: NO (no guardamos el texto de las búsquedas, solo
  que se usó el buscador y cuántos resultados).
- Publicidad / IDs de publicidad: NO. No hay anuncios ni rastreadores de
  terceros.

## Prácticas de seguridad (sección «Security practices»)

- **Cifrado en tránsito**: Sí.
- **Mecanismo de eliminación de datos**: Sí (solicitud por correo; la bóveda
  cifrada puede eliminarse).
- **Cifrado en reposo del lado del cliente** para las credenciales y nombres de
  empresa (E2E): menciónalo en la política; en el formulario refuérzalo donde
  se pueda.

## Notas de coherencia

- La analítica es **por usuario con nombre** → debe estar declarada como
  recopilación de «Actividad en la app» con propósito «Analítica» (ya está
  arriba) y descrita en la política (sección 3.e). Mantener ambos alineados.
- Si en el futuro se agrega publicidad, pagos in-app, ubicación u otro dato,
  **actualizar esta guía, la política y el formulario** en el mismo cambio.
