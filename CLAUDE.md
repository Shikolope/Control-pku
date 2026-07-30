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

`db` se inicializa con `initializeFirestore` + `persistentLocalCache` (cache nativo en
IndexedDB, con `persistentMultipleTabManager`), con fallback a `getFirestore(app)` si el
entorno no soporta IndexedDB (navegación privada de Safari, WebViews restringidos). Esto
significa que un `setDoc`/`deleteDoc` normal ya **no** rechaza su promesa por falta de
red — el SDK lo deja en cache local y sincroniza solo al reconectar. Si un `catch(e)`
alrededor de una escritura se dispara igual, es un error real (`permission-denied`, dato
inválido, etc.), no un corte de conexión.

**Matiz importante (validado con Playwright real, 2026-07-30, ver
`plan-migracion-offline` en memoria para el detalle):** "no rechaza" no es lo mismo que
"resuelve rápido". Si la conexión se corta *a mitad de sesión* (la app ya estaba online,
activa) justo cuando se dispara una escritura, tanto un `setDoc`/`deleteDoc` individual
como un `writeBatch().commit()` se quedan colgados **sin resolver ni rechazar**
(probado hasta 30s sin liquidar ninguno) — no es un problema exclusivo de los batches
como se pensaba antes. Sí funciona bien, en cambio, el caso más común: **abrir/recargar
la app cuando YA está offline** (confirmado: sale de la pantalla de carga en <1s con
datos de caché). El riesgo real es más angosto de lo que suena — corte de conexión en
el instante exacto de una escritura en curso — pero si escribes código nuevo que hace
`await` sobre una escritura en una función que puede correr con la app recién
reconectándose o desconectándose, tenlo en cuenta.

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

**Manejo de fallos — angostado en la Fase 2 (migración offline):** las 7 funciones que
escriben comidas/citas/config/historial (`guardarComidaEnFirestore`,
`borrarComidaDeFirestore`, `guardarCitaEnFirestore`, `borrarCitaDeFirestore`,
`guardarConfigEnFirestore`, `guardarDiaHistorialEnFirestore`,
`borrarDiaHistorialDeFirestore`) YA NO llaman a `manejarFalloFirestore` en su `catch` —
solo hacen `console.error`, porque el cache nativo ya cubre la durabilidad offline de
esos datos, y bloquear la app (`modoOffline`) para un error real no ayuda (no se arregla
reintentando). **El único llamado a `manejarFalloFirestore` que queda es en
`registrarEnLog`** (auditoría) — se mantiene ahí a propósito como red de seguridad,
porque el historial de cambios ya tuvo un bug real de pérdida silenciosa de registros.

`manejarFalloFirestore(tipo, datos, errorOriginal)` reintenta una vez de inmediato: si
falla otra vez, recién ahí declara `modoOffline = true`, bloquea la edición, muestra el
banner "modo solo lectura" (con el código de error real visible, ej.
`permission-denied`), y encola la operación en `colaReintentos` para reintentar al
reconectar. **Importante:** `manejarFalloFirestore` se ignora a sí misma (`return`
inmediato) si `modoOffline` ya es `true` — si necesitas encolar algo mientras ya se sabe
que está offline, empuja directo a `colaReintentos` + `_persistirCola()`, no llames a
`manejarFalloFirestore` (así lo hace `registrarEnLog`).

**Soft-delete (`archivarEnPapelera`) nunca se espera (`await`) antes de un borrado
real.** Bug real encontrado y arreglado en la propia Fase 2 (commit `7d10c19`): las
funciones de borrado (comida/cita/historial) hacían `await archivarEnPapelera(...)`
antes de `await deleteDoc(ref)`. Con `persistentLocalCache`, la promesa de una
escritura (incluido `batch.commit` del archivado) no resuelve mientras no hay
conexión — es comportamiento documentado del SDK de Firestore, no un bug propio
(ver `firebase/firebase-js-sdk#6515`). Si el archivado quedaba colgado offline, el
`deleteDoc` real nunca se alcanzaba a ejecutar, y si la app se cerraba antes de
reconectar, el borrado se perdía para siempre — el alimento/cita/día reaparecía. Si
escribes una función de borrado nueva, sigue el patrón ya corregido: dispara
`archivarEnPapelera(...)` SIN `await` (best-effort, en el mismo orden) y recién
después haz `await deleteDoc(...)`.

**Este mismo patrón (`await archivarEnPapelera` antes de un borrado real) reapareció
en otros 4 lugares que el fix de la Fase 2 no cubrió** — encontrados en una auditoría
de integridad/disponibilidad/confiabilidad (2026-07-30) y corregidos el mismo día:
`cerrarDiaAnteriorEnFirestoreSiCorresponde` (el más grave — corre en el camino
crítico del login, con el timeout de 5s a "modo offline" ya cancelado, así que podía
colgar la pantalla de carga entera sin salida), `sincronizarLocalAFirestore`,
y los parches de `reiniciarDiaManual` y `verificarCambioDeDiaAutomatico`. Si en el
futuro aparece código nuevo que llama a `archivarEnPapelera`, revisa TODOS los
call sites existentes (`grep -n archivarEnPapelera`), no solo las funciones de
borrado "principales" — este bug demostró que el patrón se copia a mano en varios
lugares y es fácil que alguno quede afuera de una corrección puntual.

**Los 4 `onSnapshot` de `activarListenersTiempoReal`** (comidas/historial/citas/
config) ahora tienen callback de error (`console.error`) — antes, si un listener
fallaba a mitad de sesión (regla de Firestore mal alineada, token vencido, índice
faltante), Firestore dejaba de invocarlo sin ninguna señal visible: el dispositivo
dejaba de recibir cambios de otros dispositivos/del profesional en silencio,
indistinguible de "no hay novedades". Si agregas un `onSnapshot` nuevo, pásale
siempre un tercer argumento de error — no lo dejes con el callback de éxito solo.

El `switch` de `ejecutarOperacionFirestore` se angostó en la Fase 3 para manejar solo
el tipo `'log'` — los otros 6 casos (`comida`/`borrarComida`/`cita`/`borrarCita`/
`config`/`historial`/`borrarHistorial`) ya no los genera nadie desde la Fase 2, así que
se retiraron. Si algún resto muy viejo de esos tipos aparece igual en una cola de
`localStorage` de una instalación antigua, cae al `default` del switch y se descarta
con un `console.warn` en vez de aplicarse (ya no hay drenaje real para esos 6 tipos).

**Plan de migración offline — 3 fases** (ver commits `e0ea121`/`6aee482` para Fase 1,
`cf81320`/`7d10c19` para Fase 2):
1. ✅ Fase 1: `persistentLocalCache` activo, sistema manual viejo intacto en paralelo.
2. ✅ Fase 2: `manejarFalloFirestore`/`colaReintentos`/`modoOffline` angostado a solo
   `registrarEnLog` — las demás escrituras ya no lo usan.
3. ✅ Fase 3 (2026-07-30): se retiraron del `switch` de `ejecutarOperacionFirestore` los
   6 casos que ya no genera nadie desde la Fase 2, dejando solo `'log'`. Se publicó el
   mismo día que la Fase 2, saltándose el tiempo prudente de espera originalmente
   previsto — decisión consciente del dueño del proyecto, válida porque **la app
   todavía no se lanzó oficialmente y todas las cuentas que existen hoy son de
   prueba** (no hay usuarios reales con colas viejas de `localStorage` circulando
   por ahí todavía). Si en el futuro se retoma este patrón de "esperar antes de
   retirar código de compatibilidad", ya no aplica ese argumento una vez lanzada la
   app a las 534 familias. `colaReintentos`/`procesarColaReintentos`/
   `manejarFalloFirestore` NO se retiraron — siguen activos porque `registrarEnLog`
   (auditoría) todavía los usa a propósito como red de
   seguridad.

### Multi-sesión y multi-dispositivo

El diseño evita colisiones sobre todo porque **cada cosa tiene su propio documento**,
no por una lógica activa de resolución de conflictos:

- **Multi-pestaña (mismo navegador):** `persistentMultipleTabManager` (parte de la
  config de `persistentLocalCache`) hace que todas las pestañas compartan la misma
  caché local en vez de pisarse la cola de escrituras entre sí.
- **Multi-dispositivo (misma cuenta, celular + notebook, etc.):** cada dispositivo
  tiene su propia caché local (IndexedDB no se comparte entre dispositivos), pero se
  sincronizan por los 4 `onSnapshot` de `activarListenersTiempoReal` mientras estén
  online (cambios se reflejan en segundos), y al reconectar, por el merge de
  `sincronizarLocalAFirestore`.
- **Comidas y citas:** cada una es su propio documento con ID propio (timestamp). Dos
  dispositivos agregando al mismo tiempo generan dos documentos distintos — no hay
  pisada posible.
- **Historial (`historial/{fecha}`):** SÍ es un documento compartido para una misma
  fecha entre dispositivos, pero nunca se sobreescribe entero — siempre se lee lo
  existente, se filtran las comidas nuevas por ID, y se hace merge
  (`comidasFinal = [...(existente.comidas || []), ...nuevasNoRepetidas]`, visto en
  `cerrarDiaAnteriorEnFirestoreSiCorresponde` y `sincronizarLocalAFirestore`).
- **Config (`config/principal`: `metaDiaria`/`favoritos`/etc.):** documento
  compartido — ahí sí podría haber un last-write-wins si dos dispositivos cambian el
  límite en el mismo instante, pero casi todas las escrituras usan `{ merge: true }`,
  así que solo pisan los campos que efectivamente cambiaron.
- **Papelera y respaldos:** viven a nivel de CUENTA, no por dispositivo — algo
  borrado desde el celular es recuperable también desde la notebook.
- **Profesional:** solo puede escribir el campo `meta` (reforzado por
  `firestore.rules`), así que su única superficie de colisión con la familia es ese
  campo puntual, también con `merge: true`.

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
- Migración a persistencia offline nativa de Firestore: las 3 fases ya están hechas
  (ver sección "Sistema de sincronización con Firestore" arriba).
- Evaluar pasar de plan Spark a Blaze antes del lanzamiento a las 534 familias.

## Guía de soporte completa

Existe un documento separado (`guia-soporte-mi-control-pku.md`) con instrucciones paso
a paso para: gestión de contraseñas, recuperación desde papelera, restauración de
respaldos, tabla de códigos de error de Firestore, y checklist pre-publicación.
