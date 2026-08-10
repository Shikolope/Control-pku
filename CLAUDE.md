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

**Los 5 `onSnapshot` de `activarListenersTiempoReal`** (comidas/historial/citas/
recetas/config — el de recetas se sumó con la feature "Mis Recetas") ahora tienen
callback de error (`console.error`) — antes, si un listener
fallaba a mitad de sesión (regla de Firestore mal alineada, token vencido, índice
faltante), Firestore dejaba de invocarlo sin ninguna señal visible: el dispositivo
dejaba de recibir cambios de otros dispositivos/del profesional en silencio,
indistinguible de "no hay novedades". Si agregas un `onSnapshot` nuevo, pásale
siempre un tercer argumento de error — no lo dejes con el callback de éxito solo.

**Indicador de sincronización pendiente (agregado 2026-08-10):** hasta ahora la app
nunca le avisaba al usuario si quedaban escrituras offline sin confirmar por el
servidor — riesgo real: si el usuario borraba el caché/historial del navegador
mientras había cambios sin sincronizar, esos datos se perdían para siempre (solo
existían en la caché local de Firestore, nunca llegaron al servidor). Arreglo:
`window.chequearSincronizacionPendiente()` (definida en el `<script type="module">`,
usa `waitForPendingWrites(db)` de la SDK de Firestore) muestra el banner
`#bannerSincronizando` ("🔄 Sincronizando cambios...") si la promesa tarda más de
400ms en resolver (heurística para no mostrarlo por la latencia normal de una
escritura online rápida), y lo oculta apenas se confirma que no queda nada
pendiente. Se dispara en 3 momentos: al cargar la página, en el evento `online` del
navegador (el más importante — es cuando arrancan a subir los cambios acumulados
offline), y desde el listener de `visibilitychange` del `<script>` clásico (mismo
lugar que ya dispara `_swRegistracion.update()`/`chequearVersionContenido`).
**Deliberadamente NO se enganchó a cada función de escritura individual**
(`guardarComidaEnFirestore` y las demás) para no tocar ese código ya sensible —
`waitForPendingWrites()` es global a nivel de todo el `Firestore` de la instancia,
así que no hace falta. Limitación conocida y aceptada: si una escritura nueva
ocurre justo mientras ya se estaba chequeando, el banner podría ocultarse un poco
antes de lo ideal hasta el próximo disparador — aceptable porque en ese caso la
escritura nueva ya se hizo con conexión activa, sincroniza casi al instante.
Validado con Playwright contra Firebase real (`context.setOffline`): banner oculto
mientras offline (sin disparador), aparece ~400ms tras reconectar, desaparece
~1.5s después una vez sincronizado de verdad.

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

### Cambio de perfil y `window.cargandoDatosPerfil`

`seleccionarPerfil` actualiza el nombre del paciente en el header de forma
**síncrona** (`actualizarIndicadorPerfil`, incluye `localStorage.setItem('pku_nombre_paciente', ...)`)
pero `historialDias`/`comidasHoy`/`citasMedicas` solo se reemplazan cuando
`cargarDesdeFirestore` termina (`aplicarDatosRestaurados`), que es `async` y se
espera *después*. Entre esos dos momentos hay una ventana real donde el header ya
muestra el paciente nuevo pero las variables de datos siguen siendo las del paciente
anterior — confirmado como bug real en el reporte PDF/Excel (2026-07-30): generarlo
en esa ventana producía un archivo con el nombre correcto pero los datos del paciente
equivocado.

Fix: `window.cargandoDatosPerfil` es `true` mientras `cargarDesdeFirestore` está en
vuelo (se pone en `true` al entrar, se limpia en un `finally`, cubre todo llamador —
login inicial, cambio de perfil, reconexión). `generarReporteNutricionista` y
`generarReporteExcel` lo chequean antes de generar nada. **Si agregas una función
nueva que lee `historialDias`/`comidasHoy`/`citasMedicas`/`metaDiaria` fuera del ciclo
normal de renderizado de pantalla** (otro export, un resumen, etc.), chequeá
`window.cargandoDatosPerfil` primero — el renderizado de pantalla normal
(`actualizarPantalla`/`renderizarComidasHoy`/etc.) no necesita este chequeo porque
corre disparado por `aplicarDatosRestaurados` mismo, siempre después de que los datos
ya están al día.

## Estructura de datos en Firestore

```
usuarios/{uid}/
  perfiles/{perfilId}/
    config/principal   → metaDiaria, ultimoDia, nombrePaciente, codigoPerfil
    comidas/{comidaId} → id, nombre, gramos, fa, unidad, categoria
    historial/{fecha}  → fecha, consumido, meta, comidas[]  (fecha = "YYYY-MM-DD")
    citas/{citaId}     → id, texto, fechaTexto, rawDateTime
    recetas/{recetaId} → id, nombre, categoria, porciones, modoFa, ingredientes[], faTotal
                          ("Mis Recetas" — recetas propias de la familia, combinan varios
                          alimentos de la Tabla PKU; no confundir con el Recetario oficial
                          INTA, que es estático y vive embebido en index.html, no en
                          Firestore. Incluye el modo "Ya sé el FA total" para recetas de
                          la comunidad PKU — ej. Corporación PKU Chile — donde ya se conoce
                          el valor total sin desglosar ingredientes; el botón "Recetario
                          Comunidad PKU Chile" del buscador usa esta misma colección, no
                          una estructura aparte)
    planSemanal/actual → { dias: { lunes: {...6 bloques}, martes: {...}, ... } }
                          (menú de referencia RECURRENTE, no atado a fecha calendario —
                          documento único que se sobreescribe entero. Se lee UNA sola vez
                          al iniciar sesión, sin onSnapshot, a propósito para no sumar
                          cuota de lecturas. El cliente escribe con merge:true apuntando
                          solo al día/bloque tocado, desde el fix de integridad
                          2026-08-10, para no pisar cambios de otro dispositivo; sigue
                          aceptando también un setDoc del documento completo)
    log/{logId}        → auditoría append-only (comidas del dueño + cambios de límite
                          del profesional). No tiene pantalla propia para los cambios
                          de límite — decisión consciente, ver más abajo.
                          **`cargarYRenderizarHistorialCambios` (pantalla "Historial
                          de cambios") lee esta colección con
                          `orderBy('fechaHoraEvento', 'desc').limit(100)`. NO le
                          quites el `orderBy`** — sin él, `limit(100)` no trae "los
                          últimos 100", trae 100 en un orden no garantizado
                          (en la práctica, ascendente por ID = los más VIEJOS
                          primero, porque el ID empieza con `Date.now()`). Bug real
                          encontrado el 2026-07-30 en una cuenta con 145 eventos
                          acumulados: los 45 más recientes — incluido literalmente
                          todo el día de hoy — nunca se descargaban, y la pantalla
                          mostraba "Sin cambios este día" pese a que el registro sí
                          se había guardado bien en Firestore. `orderBy` sobre un solo
                          campo (`fechaHoraEvento`, un string ISO plano, no
                          `serverTimestamp()`) no necesita índice compuesto — el
                          comentario original que evitaba el `orderBy` "para no
                          requerir índice" partía de una premisa equivocada.
    notificaciones/{id}→ mensajes del profesional a la familia. Campos: mensaje,
                          leida, vistaEn, _ts, profesionalUid, nombrePaciente (los
                          últimos dos, agregados 2026-07-31 para el feed "Actividad
                          reciente" de profesional.html — ver más abajo).
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
  (para buscar pacientes), CREAR notificaciones para la familia, y LEER las
  notificaciones que él mismo creó (para ver el estado "Visto"/"Aún no visto" en
  `profesional.html`) — pero solo ESCRIBIR el campo `meta`/`metaDiaria` de un perfil.
- **Antes de agregar un campo nuevo a cualquier documento, verifica que el nombre
  coincida exactamente con lo que exige la regla correspondiente.** Un desajuste aquí
  produce `permission-denied` silencioso — así estuvo roto el guardado de citas desde
  que se implementaron por primera vez, sin que nadie lo notara, porque las reglas
  pedían `descripcion`/`fecha` y el código guardaba `texto`/`rawDateTime`. El mismo
  patrón volvió a pasar el 2026-07-30 con `notificaciones`: el profesional podía
  CREARLAS pero la regla nunca le dio permiso de LEERLAS de vuelta —
  `cargarHistorialMensajes` en `profesional.html` fallaba con `permission-denied` en
  cada carga de paciente, y como el `catch` solo ocultaba la tarjeta
  (`tarjeta.style.display = 'none'`) sin ningún aviso, nadie lo notó hasta probar en
  vivo con una cuenta profesional real (ver `firestore.rules` línea ~192, arreglado
  en el commit `02bab37`). **Antes de escribir una regla de `allow read`/`allow
  write` nueva, revisa TODOS los caminos que necesitan acceder a esos datos — no solo
  el que estás implementando en ese momento —** un rol que puede crear un documento
  casi siempre también necesita poder leerlo de vuelta.
- El comentario-header al inicio de `firestore.rules` documenta el esquema esperado —
  mantenlo actualizado si cambias campos, para no repetir ese bug.
- **2026-07-31 — feed "Actividad reciente" en `profesional.html`:** antes, el
  profesional solo se enteraba de que una familia vio su mensaje si volvía a buscar a
  ese paciente puntual y abría su ficha (`cargarHistorialMensajes`). Ahora la pantalla
  de búsqueda tiene un panel en vivo (`onSnapshot` sobre
  `collectionGroup(db, 'notificaciones')`, filtrado por `profesionalUid` propio y
  `leida == true`, ordenado por `vistaEn`) que se actualiza solo, más una notificación
  nativa del navegador (`Notification` API, mismo patrón que ya usaba `index.html`
  para recordatorios de citas) cuando llega un "visto" nuevo. Requirió agregar
  `profesionalUid`/`nombrePaciente` (denormalizado) a los documentos de
  `notificaciones` al crearlos, y — **igual que le pasó una vez a
  `collectionGroup('perfiles')`** — la regla anidada de `notificaciones` no alcanzaba
  para autorizar la consulta `collectionGroup` nueva, así que se agregó una regla
  aparte a nivel raíz con sintaxis `{path=**}` (mismo patrón ya usado para `perfiles`,
  ver `firestore.rules`). El acceso de lectura sigue siendo amplio a nivel de regla
  (cualquier profesional puede leer el collection-group de cualquier paciente); lo que
  acota el feed a "mis propios mensajes enviados" es el filtro `profesionalUid` en la
  consulta, no la regla. Requiere un índice compuesto (`profesionalUid` Asc, `leida`
  Asc, `vistaEn` Desc, scope Collection group) — no hay `firestore.indexes.json` en
  este repo, se crea con el enlace automático que muestra la consola la primera vez
  que la consulta corre en producción, mismo mecanismo ya usado para el buscador de
  pacientes por nombre. Deliberadamente fuera de alcance: push real con el navegador
  cerrado (requeriría Cloud Functions + FCM + plan Blaze) — la notificación del
  navegador de esta versión solo funciona mientras la pestaña de `profesional.html`
  sigue abierta.
- **2026-07-31 — firma del profesional en el mensaje adicional:** cuando el
  profesional escribe texto libre para la familia (`inputMensajeFamilia`), ahora se le
  agrega automáticamente `· Atte: {nombre}` al final, leyendo `profesionales/{uid}.nombre`
  (campo opcional, se agrega a mano en la consola de Firebase junto con el resto de la
  cuenta — no hay pantalla para que el profesional lo edite él mismo). Si el campo no
  está completado, se omite la firma en silencio (nunca "Atte: undefined"). El mensaje
  automático de cambio de límite (sin texto adicional) NO lleva firma — solo se firma lo
  que el profesional efectivamente escribió a mano.
- **2026-07-31 — buscador de pacientes insensible a mayúsculas y tildes:** el buscador
  por nombre de `profesional.html` (`buscarPacientes`) antes comparaba contra `nombre`
  tal cual está guardado (case-sensitive, por cómo Firestore ordena strings) — buscar
  "maria" no encontraba a "María". Ahora compara contra un campo nuevo, `nombreLower`,
  guardado por `index.html` en los 5 lugares donde se escribe `nombre` en un perfil
  (`guardarNuevoPerfil`, el flujo de completar/renombrar nombre, el registro de
  pacientes adicionales, `migrarLocalStorageAFirestore` y `migrarUsuarioAMultiperfil`).
  El valor no es solo `.toLowerCase()` — pasa por `normalizarNombreBusqueda(nombre)`
  (definida igual en ambos archivos: `nombre.normalize('NFD').replace(/[\u0300-\u036f]/g,
  '').toLowerCase()`), que además saca tildes/diéresis, para que buscar "nino" encuentre
  "Niño" y "jose" encuentre "José". **Si algún día se toca esta función, hay que
  actualizarla en los dos archivos a la vez** — no comparten scope de JS, así que quedó
  duplicada a propósito; si se desalinean, el buscador deja de encontrar nombres con
  tilde/ñ en silencio (mismo tipo de bug de "dos lados que deben coincidir exactamente"
  que ya pasó antes con los campos de `firestore.rules`). **Decisión consciente: no se
  hizo backfill** de los perfiles ya existentes (a esa fecha todavía eran solo perfiles
  de prueba, confirmado con el dueño del proyecto) — un perfil creado antes de este
  cambio no aparece en el buscador por nombre hasta que la familia vuelva a guardar su
  nombre una vez, o se le agregue `nombreLower` a mano en la consola (el profesional
  igual puede encontrarlo por código PK-1234 mientras tanto). Requiere además una
  **exención (field override)** en Firestore — Índices → Exenciones — para
  `perfiles.nombreLower` con "Alcance del grupo de colecciones" → Ascendente habilitado
  (mismo mecanismo ya usado para `perfiles.nombre` antes de este cambio, que queda
  obsoleta y se puede borrar). Si en el futuro hace falta indexar perfiles reales
  viejos, hay que escribir ese backfill aparte — no asumir que ya corrió.

## Flujo de publicación

Dos destinos activos, independientes:
- **`pku-control.web.app`** (Firebase Hosting) — única URL de producción activa.
- **`shikolope.github.io`** — desactivado a propósito (Settings→Pages→None), pero el
  repo sigue intacto. El APK (TWA) apunta a `pku-control.web.app` ahora.

```bash
git add .
git commit -m "..."
git push                          # historial en GitHub, como siempre
date -u +"%Y-%m-%dT%H:%M:%SZ" | sed 's/.*/{"version":"&"}/' > version.json  # ver nota abajo
firebase deploy --only hosting    # publica index.html/profesional.html/etc.
firebase deploy --only firestore:rules   # publica firestore.rules (aparte)
```

**`version.json` (raíz del repo) hay que regenerarlo ANTES de cada `firebase deploy
--only hosting`**, con un timestamp UTC fresco (comando de arriba, o a mano con el
mismo formato `{"version":"2026-08-10T07:40:08Z"}`). Es el mecanismo que detecta
cambios de CONTENIDO (a diferencia del banner viejo, que solo detecta cambios en
`sw.js` — ver más abajo, sección del banner de nueva versión). Si te olvidas de
regenerarlo, el deploy sale bien igual, pero el banner de actualización no se entera
de que hubo cambios — no rompe nada, simplemente no avisa.

**`sw.js` se sirve con `Cache-Control: no-cache`** (config en `firebase.json` →
`hosting.headers`, agregado 2026-07-30). Sin esto, Firebase Hosting lo servía con su
default (`max-age=3600`), y el navegador podía tardar hasta 1 hora en darse cuenta de
que había una versión nueva del Service Worker tras un deploy — retrasando el banner
"🆕 Hay una nueva versión disponible" justo el tiempo que ese mecanismo existe para
evitar. `index.html`/`manifest.json`/etc. se dejaron con el default de Firebase
(`max-age=3600`) a propósito — el propio `sw.js` ya sirve esos archivos con estrategia
network-first una vez instalado, así que ese cache HTTP normal no los deja
"pegados"; `sw.js` es el único archivo cuya frescura HTTP es crítica porque es el
mecanismo mismo que detecta actualizaciones. Si agregas headers nuevos a
`firebase.json`, no le saques el `no-cache` a `/sw.js` sin una razón fuerte.

**El TWA (APK) instalado en Android no dispara el chequeo automático de
actualización del navegador** (2026-08-10, bug real reportado por el dueño del
proyecto probando en su celular): al reabrir la app desde el ícono, Android retoma
el WebView existente en vez de hacer una navegación/reload real, así que el chequeo
que Chrome hace normalmente "al navegar a una página controlada por un SW" casi
nunca se dispara ahí — el banner de nueva versión podía quedar sin aparecer
indefinidamente en el TWA aunque sí funcionara bien en un navegador normal. Arreglo:
el listener de `visibilitychange` que ya existía (`index.html`, usado para
`verificarCitasProximas`/`revisarYAplicarCambioDeDia`) ahora también llama
`_swRegistracion.update()` cada vez que la app vuelve a primer plano, forzando el
chequeo manualmente en vez de depender del automático del navegador. Validado con
Playwright: 0 llamadas a `update()` al cargar, 1 llamada exacta al simular que la
app vuelve a foreground. `_swRegistracion` guarda la referencia del
`register('sw.js').then(reg => ...)` para que el handler de `visibilitychange`
(declarado más abajo en el archivo) pueda acceder a ella.

**Ese fix de `_swRegistracion.update()` NO alcanzaba** (mismo día, el dueño del
proyecto probó de nuevo y seguía sin aparecerle el banner): ese mecanismo solo
detecta cambios en el ARCHIVO `sw.js`, pero la enorme mayoría de los deploys reales
(features, textos, fixes) solo tocan `index.html` sin tocar `sw.js` para nada — no
había NINGÚN mecanismo que detectara ese caso, mucho más común. Arreglo real:
`version.json` (archivo nuevo en la raíz del repo, `{"version":"<timestamp UTC>"}`,
**hay que regenerarlo en cada deploy de hosting** — ver comando en "Flujo de
publicación" arriba) se chequea con `fetch('/version.json', {cache:'no-store'})` al
cargar la página (`_versionContenidoInicial`) y de nuevo en cada `visibilitychange`;
si cambió, se muestra el mismo banner/botón "Actualizar ahora" — `aplicarNuevaVersion()`
ya caía a `window.location.reload()` cuando no había `_swEsperando` pendiente, que es
justo la navegación real que hace falta forzar. Validado con Playwright (aislando la
interferencia del propio Service Worker sobre el mock de red, que no se puede
interceptar de forma confiable con `page.route` una vez que el SW controla la
página): banner oculto con la misma versión, banner visible al simular una versión
distinta. **Si en el futuro el banner de nueva versión sigue sin aparecer en el TWA
pese a estos dos mecanismos, sospechar primero de que `version.json` no se
regeneró en el último deploy** — es el punto de falla más probable, no un bug de
lógica nuevo.

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
- **"Citas Médicas" es un recordatorio personal, NO un sistema de agendamiento real.**
  La app no reserva ni agenda horas con el INTA ni ningún centro de salud — solo
  guarda una nota + fecha/hora que el usuario ya sabe de antemano (porque la agendó
  por otro medio) para no olvidarla. Aclarado 2026-08-10 con un subtítulo bajo
  "📅 Próximas Citas Médicas" en `index.html` y una entrada nueva en el FAQ (in-app y
  en las 2 guías PDF). Si se agrega texto nuevo sobre esta sección en cualquier
  lugar (guías, novedades, disclaimer), no dar a entender que agenda horas de
  verdad — es la misma clase de confusión que ya se evitó a propósito con el modo
  profesional oculto para familias.

## Pendientes conocidos

- Subir el APK nuevo a Play Store (ya generado, apuntando a pku-control.web.app).
  **Mientras el APK no esté publicado, las 534 familias usan la app exclusivamente
  vía la URL `pku-control.web.app`, tanto desde PC como desde celular** — no asumir
  que hay una app instalada de por medio en ningún texto/guía/feature nueva
  (instrucciones de "abre la app" deben leerse como "abre la URL en el navegador").
- Migración a persistencia offline nativa de Firestore: las 3 fases ya están hechas
  (ver sección "Sistema de sincronización con Firestore" arriba).
- Evaluar pasar de plan Spark a Blaze antes del lanzamiento a las 534 familias.
- Agrupar "Comidas de Hoy" en los mismos 6 bloques que ya usa Plan Semanal
  (Desayuno/Colación mañana/Almuerzo/Colación tarde/Cena/Otros). Se armó un plan
  completo (2026-08-09) — agregar campo `bloque` a cada comida, preguntado con chips
  (default por hora del día) en `calcularFA`/`agregarAlimentoCustom`/
  `confirmarRegistroReceta`/`registrarRecetaComoComida`, auto-etiquetado sin
  preguntar en los registros que vienen de Plan Semanal, sin requerir cambios en
  `firestore.rules`. **Se descartó por decisión de producto, no técnica**: el dueño
  del proyecto sintió que agregar un paso al flujo de registro más usado de la app
  (el buscador principal, `calcularFA`) es un riesgo de UX que no vale la pena para
  534 familias reales, aunque el cambio estuviera bien acotado técnicamente. Si se
  retoma, evaluar una versión que NO le pida nada al usuario en el flujo de agregar
  (ver `feedback_flujos_core` en memoria del agente para el detalle de esta decisión).

## Guía de soporte completa

Existe un documento separado (`guia-soporte-mi-control-pku.md`) con instrucciones paso
a paso para: gestión de contraseñas, recuperación desde papelera, restauración de
respaldos, tabla de códigos de error de Firestore, y checklist pre-publicación.
