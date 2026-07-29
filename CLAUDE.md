# CLAUDE.md — Mi Control PKU

Contexto del proyecto para Claude Code. Léelo antes de tocar cualquier archivo.

## Qué es esto

App web/PWA para que familias en Chile controlen el consumo diario de fenilalanina (FA)
de personas con fenilcetonuria (PKU). Basada en la Tabla Oficial PKU Chile 2021 y el
Recetario PKU (Verónica Cornejo y M. Jesús González, ISBN 978-956-358-345-6).

Escala objetivo: ~534 familias con personas PKU en Chile.

## Archivos principales

- `index.html` — app de familias, versión de producción única. Ya incluye el sello
  institucional INTA/Universidad de Chile (login, sección "Sello institucional INTA").
  Antes existía un archivo paralelo `index-..._con_LOGO.html` para la versión con logo,
  pero ese archivo ya no existe en el repo — ahora se trabaja **solo sobre este único
  `index.html`**, no hay que replicar cambios a ningún otro archivo de app de familias.
- `profesional.html` — login y panel para nutricionistas del INTA (modo profesional).
  **El dueño del proyecto ya editó el texto/wording de este archivo a mano — no tocar
  el texto ahí salvo que lo pida explícitamente.**
- `firestore.rules` — reglas de seguridad de Firestore. Se publica por separado del
  hosting (`firebase deploy --only firestore:rules`).
- `manifest.json` — configuración PWA. `start_url`/`scope`/`id` deben ser `"/"` (no
  `"/Control-pku/"` — eso era un resto de cuando vivía en subcarpeta de GitHub Pages).
- `.well-known/assetlinks.json` — verifica que el APK (TWA) es dueño del dominio.

## Arquitectura técnica — CRÍTICO antes de escribir código nuevo

Cada archivo `index*.html` tiene **dos bloques `<script>` con scopes de JavaScript
totalmente separados**:

1. **Script clásico** (sin `type="module"`, la mayor parte del archivo): funciones de
   UI, calendario, formularios, renderizado. NO tiene acceso a `auth`, `db`, ni a las
   funciones de Firestore (`query`, `collection`, `getDocs`, `setDoc`, etc.).
2. **`<script type="module">`**: acá viven `auth`, `db`, y todas las funciones que
   hablan con Firestore/Firebase Auth.

**Si necesitas que código del script clásico hable con Firestore, NO lo hagas directo**
(tirará `ReferenceError: auth is not defined` o similar, a veces silenciosamente
atrapado por un try/catch). Expón una función puente en `window` desde el script
module, y llámala desde el script clásico. Patrón ya usado: `window.obtenerBasePathActivo`,
`window.obtenerMensajesProfesional`, `window.guardarCitaEnFirestore`,
`window.borrarCitaDeFirestore`.

Este error de scope ya causó dos bugs reales en el proyecto (mensajes del profesional
sin cargar, y el bug real de fondo que resultó ser un desajuste de reglas). Antes de
escribir una función nueva que toque Firestore, confirma en qué bloque `<script>` la
estás poniendo.

## Sistema de sincronización con Firestore (offline-first)

Hay un patrón central: `patchGuardarConFirestore()` "envuelve" funciones específicas
del script clásico (`guardarNuevaCita`, `borrarCitaIndividual`, `calcularFA`,
`agregarAlimentoCustom`, `confirmarRegistroReceta`, `borrarComidaIndividual`, etc.) para
sincronizar con Firestore automáticamente después de que la operación local corre. Este
wrapping no es obvio a simple vista — busca `patchGuardarConFirestore` para ver la
lista completa.

**Si agregas una función nueva que hace lo mismo que una ya envuelta (ej. otra forma de
agregar una cita) pero no pasa por la función original, no se sincroniza sola.** Tienes
que llamar a `window.guardarCitaEnFirestore(...)` (o el equivalente) a mano. Esto ya
causó un bug real: `guardarCitaDesdeCalendario` no sincronizaba porque no pasaba por
`guardarNuevaCita`.

**Manejo de fallos:** `manejarFalloFirestore(tipo, datos, errorOriginal)` reintenta una
vez de inmediato: si falla otra vez, recién ahí declara `modoOffline = true`, bloquea la
edición, muestra el banner "modo solo lectura" (con el código de error real visible,
ej. `permission-denied`), y encola la operación en `colaReintentos` para reintentar al
reconectar. **Importante:** `manejarFalloFirestore` se ignora a sí misma (`return`
inmediato) si `modoOffline` ya es `true` — si necesitas encolar algo mientras ya se sabe
que está offline, empuja directo a `colaReintentos` + `_persistirCola()`, no llames a
`manejarFalloFirestore`.

Todas las escrituras importantes (comidas, citas, historial, config, log) pasan por
este sistema. Si agregas un tipo de escritura nuevo, agrégalo también al `switch` de
`ejecutarOperacionFirestore`.

## Estructura de datos en Firestore

```
usuarios/{uid}/
  perfiles/{perfilId}/
    config/principal   → metaDiaria, ultimoDia, nombrePaciente, codigoPerfil
    comidas/{comidaId} → id, nombre, gramos, fa, unidad, categoria
    historial/{fecha}  → fecha, consumido, meta, comidas[]  (fecha = "YYYY-MM-DD")
    citas/{citaId}     → id, texto, fechaTexto, rawDateTime
    log/{logId}        → auditoría append-only (comidas del dueño + cambios de límite
                          del profesional). No tiene pantalla propia para los cambios
                          de límite — decisión consciente, ver más abajo.
    notificaciones/{id}→ mensajes del profesional a la familia
  papelera/{itemId}     → soft-delete, a nivel de CUENTA (no por perfil), write-only
                          desde la app (allow read: if false)
  respaldos/{fecha}     → un documento POR DÍA (se sobrescribe con merge), solo con
                          comidasHoy/citas/config del día en curso — nunca duplica
                          historial completo
  meta/migracion        → control de versión de esquema

codigosPerfil/{codigo}  → mapeo PK-1234 → ruta del perfil (para búsqueda en modo profesional)
profesionales/{uid}     → cuentas de nutricionistas INTA (creadas a mano en consola)
```

`fechaHoyLocal()` se usa en todo el código para fechas — nunca uses `Date` crudo para
comparar días, evita bugs de huso horario (Chile es UTC-3/UTC-4).

## Reglas de seguridad (firestore.rules)

- Cada familia solo lee/escribe sus propios datos.
- Un profesional (documento en `profesionales/{uid}`) puede LEER cualquier perfil
  (para buscar pacientes), pero solo ESCRIBIR el campo `meta`/`metaDiaria`.
- **Antes de agregar un campo nuevo a cualquier documento, verifica que el nombre
  coincida exactamente con lo que exige la regla correspondiente.** Un desajuste aquí
  produce `permission-denied` silencioso — así estuvo roto el guardado de citas desde
  que se implementaron por primera vez, sin que nadie lo notara, porque las reglas
  pedían `descripcion`/`fecha` y el código guardaba `texto`/`rawDateTime`.
- El comentario-header al inicio de `firestore.rules` documenta el esquema esperado —
  mantenlo actualizado si cambias campos, para no repetir ese bug.

## Flujo de publicación

Dos destinos activos, independientes:
- **`pku-control.web.app`** (Firebase Hosting) — única URL de producción activa.
- **`shikolope.github.io`** — desactivado a propósito (Settings→Pages→None), pero el
  repo sigue intacto. El APK (TWA) apunta a `pku-control.web.app` ahora.

```bash
git add .
git commit -m "..."
git push                          # historial en GitHub, como siempre
firebase deploy --only hosting    # publica index.html/profesional.html/etc.
firebase deploy --only firestore:rules   # publica firestore.rules (aparte)
```

## Decisiones de producto a respetar

- El modo profesional NO se menciona en ningún texto visible para las familias
  (disclaimer incluido) — reduce superficie de ataque si se compromete una contraseña
  de nutricionista.
- Los cambios de límite que hace un profesional no aparecen en "Historial de cambios"
  (esa pantalla es solo para altas/bajas de comida) — la familia ya se entera por el
  banner y el ícono de mensajes ✉️, sería redundante mostrarlo dos veces. El registro
  en Firestore sigue existiendo igual, solo sin pantalla propia.
- Registro de perfil nuevo exige nombre completo: mínimo 3 palabras (nombre + 2
  apellidos), ideal 4 (2 nombres + 2 apellidos).
- Header: campana 🔔 = solo "Novedades de la app"; sobre ✉️ = solo mensajes del
  profesional. Son dos sistemas separados a propósito, no los fusiones.

## Pendientes conocidos

- Subir el APK nuevo a Play Store (ya generado, apuntando a pku-control.web.app).
- Migrar a persistencia offline nativa de Firestore (`persistentLocalCache`) —
  pospuesto a propósito hasta después del lanzamiento.
- Evaluar pasar de plan Spark a Blaze antes del lanzamiento a las 534 familias.

## Guía de soporte completa

Existe un documento separado (`guia-soporte-mi-control-pku.md`) con instrucciones paso
a paso para: gestión de contraseñas, recuperación desde papelera, restauración de
respaldos, tabla de códigos de error de Firestore, y checklist pre-publicación.
