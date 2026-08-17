# CheckMatchLoL

Lectura estructurada y falsable de drafts de LoL competitivo, en tiempo real, sobre el feed
oficial de LoL Esports. Sitio estático, sin build ni backend: se publica tal cual en GitHub Pages.

**En vivo:** https://linuxlzlz.github.io/CHECKMATCHLOL/

Ligas incluidas: **LCK · LCK Challengers · LPL · LEC · LCS · CBLOL**.

## Qué hace

Convierte un draft en un informe con el mismo orden que el skill de predicción, de lo más duro
a lo más interpretativo:

| Sección | Qué contiene |
|---|---|
| Resumen | Probabilidad, Δ de índice, dónde se decide y qué tan completa está la lectura |
| Diagnóstico | Todo lo que el análisis **no** puede sostener, con su acción para resolverlo |
| Checkpoints | Estado del minuto 15 y 20, pedidos al minuto exacto |
| Draft | Los diez campeones por posición, mapeados por `esportsTeamId`, con suplentes marcados |
| Índice | Δ de teamfight en desviaciones estándar, banda y arquetipo primario |
| Concentración | Las una o dos posiciones donde se concentra el margen estructural |
| Segunda fuente | Ejes que publica Riot por campeón, y contraste contra la tabla propia |
| Validación | El sitio corriendo su propio test sobre el corpus que indexó |
| Qué predice de verdad | Modelos comparados fuera de muestra contra la línea base |
| Oro por rol | Dónde se concentró el oro de verdad, contrastado contra lo que predijo el draft |
| Detalle por jugador | Daño, participación en kills, visión e ítems |
| Capa de campeón | Winrate por torneo, solo con 10+ picks |
| Capa de jugador | Partidas por jugador con el campeón que juega hoy |
| Parche | Versión del feed y diff real contra el parche anterior |
| Ventana | Punto de quiebre como rango de minutos, con afirmaciones verificables |
| Lectura | Probabilidad por componentes, precio de mercado y postura de apuesta |
| Señales | Señales falsables para mirar entre el minuto 14 y el 20 |

Y un **Registro** que guarda cada predicción con fecha y calcula Brier, aciertos y un proxy de CLV.

La URL es el estado: `#/LCK/{matchId}/{gameId}`. Recargar te deja en el mismo mapa que estabas
mirando, atrás y adelante del navegador funcionan, y el link se puede compartir. Si abrís el sitio
sin hash, recupera el último partido que estabas viendo.

## Cómo está construido

Sin dependencias, sin bundler, sin `node_modules`. Módulos ES nativos.

```
index.html
assets/css/app.css
assets/js/
  app.js                  orquestador y render
  api.js                  clientes de esports-api, feed y Data Dragon
  data/tables.js          tablas CONGELADAS (150 campeones, 62 comps) + extensión (20 más)
  engine/index-score.js   port de score_draft.py, con extensión y overrides manuales
  engine/structural.js    ejes de counter, matchups, concentración y ventana
  engine/meta.js          índice de torneo: capas de campeón y jugador, rosters
  engine/outcome.js       ganador por mapa desde el frame final, verificado contra la serie
  engine/riot-profile.js  segunda fuente: ejes de campeón publicados por Riot
  engine/validation.js    el test del índice corrido sobre el corpus indexado
  engine/discovery.js     qué predice de verdad: modelos evaluados fuera de muestra
  engine/diagnostics.js   qué quedó sin diagnosticar y por qué
  engine/checkpoints.js   estado en minutos exactos, oro por rol, señales de detalle
  engine/live.js          señales de verificación en vivo
  engine/probability.js   probabilidad por componentes y postura
  engine/ledger.js        registro de predicciones, Brier y CLV
  engine/patchdiff.js     diff de campeones entre dos versiones de Data Dragon
```

### Cobertura de campeones

La tabla congelada tiene 150 campeones y Data Dragon 173, así que 23 contaban **cero en los cinco
ejes** y deprimían el índice de su lado sin que se notara. Ahora hay tres niveles, y cada campeón
muestra de cuál viene:

| Nivel | Qué es |
|---|---|
| `congelado` | La tabla del backtest. Define la escala y no se toca. |
| `extension` | 20 campeones agregados con el mismo criterio, antes de ver resultados. |
| `manual` | Lo que puntuás vos desde el panel de diagnóstico. Se guarda en tu navegador. |

**La distribución de referencia se calcula solo con la tabla congelada.** De los que faltaban, solo
`Locke` aparece en las 62 comps de referencia, y por eso no se agregó: las sd siguen siendo
exactamente 3.00 / 1.91 / 1.68 / 1.38 / 1.34, y las bandas de 0.5 y 1 sd siguen significando lo
mismo que en el backtest. La extensión mejora la lectura del draft sin mover la vara que lo mide.

Quedan tres sin fila (`Locke`, `Yunara`, `Zaahen`): son campeones cuyo kit no se conoce lo
suficiente como para puntuarlo, y el panel de diagnóstico los muestra con un editor en vez de
inventarles números.

### El circuito que cierra el Paso 7

El sitio afirma antes de la partida dónde se concentra el margen, y después lo verifica: la
tarjeta de **oro por rol** compara la posición predicha contra la posición donde el oro se
concentró de verdad, y dice si coincidió. Cuando no coincide lo marca, porque son los únicos
casos que enseñan algo.

Los **checkpoints** no son "el estado cuando abriste la página": el feed responde
`window/{id}?startingTime=T` con unos 45 frames que abarcan ~10 segundos alrededor de `T`, así que
el minuto 15 se pide pidiendo el minuto 15. Quedan guardados con fecha en el registro.

### Fuentes de datos

| Qué | Endpoint | CORS |
|---|---|---|
| Calendario, partidos, standings | `esports-api.lolesports.com/persisted/gw/…` | sí |
| Draft, parche, estado en vivo | `feed.lolesports.com/livestats/v1/window/{gameId}` | sí |
| Stats por jugador | `feed.lolesports.com/livestats/v1/details/{gameId}` | sí |
| Retratos de campeón | Data Dragon | sí |
| Ejes de campeón de Riot | `raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/…` | sí |
| gol.gg | — | **no** |
| Oracle's Elixir (CSV) | — | **no** |
| Meraki Analytics | — | **no** |
| Leaguepedia (Cargo API) | `lol.fandom.com/api.php` | sí, pero con rate limit |

Probadas todas desde el navegador, no supuestas. Leaguepedia responde con CORS abierto y tendría
bans y ganador por mapa, pero devolvió `ratelimited` de forma sostenida desde este entorno, así que
no se conectó: una fuente que falla la mitad de las veces es peor que no tenerla.

`gol.gg` no manda cabeceras CORS, así que no es consultable desde el navegador. En vez de
scrapearlo, las capas de campeón y jugador se reconstruyen desde la fuente primaria: al entrar a
una liga el sitio **indexa el torneo solo** en segundo plano, recorriendo los partidos ya jugados
y acumulando picks, winrate, rol y parche por campeón y por jugador. El índice queda cacheado en
`localStorage` por 6 horas.

Cuando el torneo vigente no tiene muestra suficiente para un campeón, se puede **indexar otra
liga**: el agregado aparece como respaldo etiquetado, nunca reemplazando el dato del torneo. Otra
liga es otro meta, y el Paso 4 pide el winrate *de este torneo*.

### La segunda fuente, y qué deja de ser incomprobable

Todo lo estructural salía de **una** tabla de juicio propio, y cinco ejes del Paso 2 se declaraban
no computables. Eso era honesto pero terminal: sin otra fuente no había forma de comprobarlos nunca.

Community Dragon publica los datos del cliente de LoL, y ahí Riot expone su propia caracterización
de cada campeón: `crowdControl`, `durability`, `mobility`, `damage`, `utility` (0-3), más
`damageType` y `attackType`. Con eso:

| Eje del Paso 2 | Antes | Ahora |
|---|---|---|
| Neutral a rango | no computable | **hecho** — cuerpo a cuerpo contra distancia es un conteo |
| Peel | no computable | **proxy** — el eje de CC de Riot |
| Desenganche | no computable | **proxy** — CC más movilidad |
| Waveclear | no computable | sigue sin fuente |
| Velocidad de objetivo | no computable | sigue sin fuente |

Y aparece un eje que no existía en ninguna forma: la **mezcla de daño** físico/mágico, que decide si
el rival puede apilar una sola resistencia. Es dato puro.

Lo más importante no es sumar ejes: es que la tabla congelada por fin tiene **algo con qué
contrastarse**. El eje `fl` (juicio propio) contra `durability` (Riot) miden casi lo mismo, así que
donde se llevan 2 o más puntos hay una de dos cosas — un error en la tabla, o un campeón que cambió
de rol desde que se escribió. El sitio lo muestra y no corrige nada solo.

### El sitio corriendo su propio test

El índice de torneo ahora guarda el corpus por mapa: los dos drafts, el ganador y la duración. Con
eso se puede volver a correr el test del índice sobre partidos que el backtest original no vio, en
vez de citar el 74% de memoria.

**Resultado sobre las 6 ligas, 405 mapas con ganador resuelto: contradice lo declarado.** En la
banda grande y dentro del régimen limpio acertó **109 de 213 (51%), IC95 [44, 58]**.

Ese intervalo contiene el 50% y **excluye el 74%**. Con n=213 esto ya no es "falta de muestra": es
un resultado en contra de la cifra que el método viene citando.

Qué significa y qué no:

- **No es el backtest original reejecutado.** Aquel corría sobre Oracle's Elixir con su propia
  selección de partidos; esto es una reimplementación sobre otro corpus, otras ligas y otro parche.
  La diferencia puede venir de la regla, del meta o del método de selección, y estos datos no las
  separan. Pero usar la regla *como si valiera 74%* no está justificado con esto sobre la mesa.
- **Separar por régimen tiene contenido.** Fuera de régimen (las dos comps por debajo del promedio)
  el índice anda peor. La advertencia que imprime el script no es una excusa: marca una población
  real.
- **Hay un control de sanidad.** El winrate del lado azul da 57% [52, 61], que es lo esperable en
  LoL profesional. Eso no valida el índice: valida que el ganador inferido por mapa no está sesgado
  hacia un lado. Si ese número se fuera de rango, toda la validación quedaría en duda y el panel lo
  marca como bloqueante.

### Qué predice de verdad

Sabiendo que el índice no reproduce, la pregunta siguiente es qué sí. El módulo de descubrimiento
entrena candidatos con la parte **vieja** del corpus y los evalúa con la **nueva**, cronológicamente.
El corte no es aleatorio a propósito: un corte al azar deja partidas del mismo día de los dos lados
y filtra información del futuro, y el uso real es predecir mañana con lo de hasta hoy.

La línea base tampoco es 50%: es **predecir siempre al lado azul**, que es una vara mucho más
honesta y más difícil de superar.

Sobre 287 mapas de entrenamiento y **124 de evaluación que ningún modelo vio**:

| Modelo | Brier | vs base | Acierto |
|---|---|---|---|
| **Fuerza de equipo** | **0.2281** | +0.0119 | 66% [57, 74] |
| Equipo + individual | 0.2292 | +0.0108 | 62% |
| Rendimiento individual | 0.2307 | +0.0093 | 62% |
| Equipo + campeón neto | 0.2313 | +0.0087 | 64% |
| Solo el lado *(base)* | 0.2400 | — | 65% |
| Winrate de campeón | 0.2431 | **−0.0031** | 57% |
| Campeón neto de equipo | 0.2465 | **−0.0065** | 55% |

Tres respuestas, y ninguna es la que uno querría:

- **La fuerza del equipo es lo único que le gana a la base.** Confirma lo que el método venía
  diciendo por otro camino: la calidad de los equipos es casi todo el margen.
- **El rendimiento individual funciona, pero no aporta *sobre* el equipo.** "Equipo + individual"
  (0.2292) es peor que equipo solo (0.2281). El winrate por jugador es un proxy más ruidoso de lo
  mismo, no una señal nueva. Con este n, al menos.
- **Las señales a nivel campeón empeoran la predicción.** Las dos filas que quedan por debajo de la
  base son las de campeón. No es que los campeones no importen: es que con 421 mapas el winrate por
  campeón es mayormente ruido, y meterlo al modelo mete el ruido.

Ese hallazgo cambió el modelo: **el peso del componente de draft ahora lo fija la medición.** Si la
banda grande cruza el 50% con n≥60, entra en cero, y el desglose de la Lectura lo dice con el número
que lo justifica. No está clavado: vuelve solo si un corpus futuro muestra que el índice separa.
Además entró un componente nuevo, la fuerza de equipo medida por mapa en el corpus, a mitad de peso
cuando los standings ya están (los dos miden lo mismo y sumarlos enteros contaría doble).

### Qué campeones escalan de verdad, y por qué todavía no se puede decir

La tabla congelada tiene una columna `scale` que es juicio. Se puede medir: winrate de cada campeón
en partidas largas contra cortas, con el corte en la mediana. Y lo mismo para "teamfight", cortando
por kills totales en vez de por duración.

**Ningún campeón sobrevive a la corrección por comparaciones múltiples** (Benjamini-Hochberg,
q=0.10), en ninguno de los dos análisis.

Sin corregir aparecían 5 "escaladores" y 6 "peleadores". Probar ~59 campeones al 95% produce **3 por
puro azar**, así que quedarse con los que cruzan el umbral sería exactamente el error que este
método existe para evitar. Dos detalles del camino que valen la pena:

- El primer intento usaba el error estándar clásico para la diferencia de proporciones y devolvió un
  intervalo `[65, 110]` — imposible. Se cambió por el método de Newcombe, que se construye sobre dos
  intervalos de Wilson y queda siempre dentro de rango.
- El mínimo por lado subió de 4 a 8 partidas: 12 partidas repartidas 8/4 no miden nada.

Para responder esto de verdad hace falta más corpus del que junta un split. Como cada índice queda
guardado, la respuesta mejora sola a medida que se indexan más torneos.

### Lo no narrable, medido

El umbral de narrabilidad era una regla de dedo — menos de 1 punto crudo no se narra — nacida de un
fallo concreto y aplicada por igual a los cinco ejes, aunque tengan dispersiones muy distintas. Con
corpus se puede medir: para cada eje, ¿a partir de cuántos puntos crudos gana más seguido el lado
favorecido?

**Ningún eje separa ganadores a ninguna magnitud.** Ni con 4 o más puntos de diferencia. Los
intervalos son estrechos (el bucket más grande tiene n=195) y todos contienen el 50%.

O sea que la pregunta "¿desde cuántos puntos se puede narrar un eje?" no tiene respuesta en estos
datos, porque ningún corte lo vuelve informativo. El umbral de 1 punto no estaba siendo demasiado
conservador: si algo, se queda corto.

La medición **solo puede endurecer** el umbral, nunca aflojarlo. Aflojar porque una muestra lo
permite es tomar cinco observaciones y convertirlas en una regla, que es el error que este método
existe para evitar; endurecer de más solo te vuelve más callado, que sale barato.

### El confusor de asedio, resuelto (y no como se esperaba)

El script declaraba una ambigüedad sin resolver: cuando hay poke en el mapa, no está descartado que
el índice mida *"el asedio está flojo en este parche"* en vez de *"el teamfight es mejor"*.

Se separa con los mapas donde los dos ejes **discrepan**, que son los únicos que discriminan — el
mismo principio del Paso 10 aplicado a ejes en vez de a capas.

| | n | Acierto del eje de teamfight |
|---|---|---|
| Los dos ejes coinciden | 148 | 50% [42, 58] |
| Los ejes discrepan | 131 | 53% [44, 61] |

**La ambigüedad se disuelve, pero no en favor de ninguna de las dos hipótesis: no hay señal que
atribuirle a ninguno de los dos ejes.** La pregunta "¿cuál de los dos mide?" presupone que alguno
mide, y eso es lo que no se sostiene.

Además la correlación entre las dos diferencias es **0.06**: los ejes son casi independientes en
este corpus, así que la premisa del confusor —que las comps de poke tienen poco daño de área e
inicio— tampoco se verifica.

## Decisiones que hacen que esto no mienta

El error dominante en este dominio no es no saber de LoL: es tomar cinco observaciones
consistentes y convertirlas en una regla. Varias defensas están puestas en el código, no en la
prosa:

- **El índice es un port exacto**, con las fórmulas congeladas y la misma desviación estándar
  poblacional. Cambiarlas después de ver un resultado invalidaría la comparación con el backtest.
- **Umbral de narrabilidad en puntos crudos.** Los z-scores amplifican los ejes de dispersión
  estrecha. Un eje con menos de 1 punto crudo de diferencia se marca *no narrable* y se atenúa,
  porque un punto en una suma de cinco campeones es un campeón puntuado 2 en vez de 3.
- **La ventana no se declara** si la brecha de escalado no supera ese umbral.
- **El z absoluto no es la brecha de matchup.** La UI muestra siempre la diferencia entre las dos
  comps y lo dice explícitamente.
- **La banda grande valía 74%**, con IC95 [57, 86], y el lenguaje estaba calibrado a eso. Sobre 405
  mapas propios da 51% [44, 58], que excluye el 74%. El sitio muestra el número medido junto al
  declarado, sin elegir el que conviene, y el panel de diagnóstico marca que el componente de draft
  de la probabilidad se apoya en una regla que su propio corpus no sostiene.
- **Lo que falta, falta ruidosamente.** Un campeón con cero picks es *sin datos*, no "pick
  sorpresa". Los ejes del Paso 2 que la tabla no puede sostener (desenganche, peel, waveclear,
  velocidad de objetivo) se listan como no computables en vez de recibir un número inventado.
- **Riesgo apilado.** Campeón sin picks + jugador sin partidas se reporta como varianza no
  estimable, no como señal negativa.
- **Colinealidad.** Cuando las capas coinciden, el sitio dice que eso es redundancia y no
  confirmación independiente. Solo los desacuerdos discriminan.

### Sobre el winrate: cómo se resuelve el ganador de cada mapa

La API expone el marcador de la **serie**, no el ganador de cada **mapa**. Atribuir solo en series
barridas dejaba 31 de 72 mapas utilizables en LCK, y con ese n casi ningún campeón llegaba al
filtro de 10 picks: la capa de campeón quedaba vacía la mayor parte del tiempo.

La salida es pedirle al feed el frame final del mapa —
`window/{gameId}?startingTime={ahora-90s}` devuelve los últimos frames con `gameState: "finished"`,
el oro y las estructuras finales **y** el draft completo, o sea al mismo costo que la llamada que
ya se hacía. De ahí sale el ganador probable, pero no se acepta suelto: se **verifica contra el
marcador de la serie**. Si los ganadores inferidos suman exactamente el marcador, se aceptan; si
no, la serie cae al subconjunto que se deduce sin heurística (barrida, y el mapa de cierre, que
siempre es del ganador porque la serie se corta al clinchar).

Medido sobre 88 series y 213 mapas de las seis ligas: el oro final es consistente con el marcador
en **87 de 88 series**; las torres primero, en 84. Por eso el discriminante es el oro. En LCK esto
llevó la atribución de **31 a 68 de 72 mapas**; en LEC, a 62 de 62.

Los mapas de una serie que no verifica siguen contando como **pick**; lo único que no reciben es
resultado, y el informe dice cuántos son.

### Postura de apuesta

**NO BET por defecto**, y no hay camino en el código que devuelva otra cosa. En el backtest de
21 predicciones, el análisis propio tuvo Brier 0.2368 contra 0.2353 del mercado, con λ\*=0: el
mercado gana. Las value bets acertaron 33% con ROI −28.2%, o sea que el edge medido fue negativo.
Esto sirve para entender partidos, no para justificar una entrada.

### Registro y calibración

Cada mapa que abrís congela su predicción con fecha, y no se reescribe si volvés a abrirlo. Si el
mapa ya estaba en curso al registrarla, se marca como **no previa** y se cuenta aparte: una
predicción hecha con la partida avanzada no es comparable con una previa. El registro calcula
Brier, aciertos y un proxy de CLV, y exporta a JSON o CSV.

El resultado **se cierra solo** cuando el mapa termina, con el ganador resuelto y verificado
contra el marcador de la serie. Un resultado cargado a mano nunca se pisa, y el registro guarda de
dónde salió cada uno. Antes había que volver a cada mapa a marcar quién ganó, y un registro que
nadie completa no calibra nada.

La comparación contra el mercado se calcula sobre el **mismo subconjunto**: los mapas que tienen
predicción, resultado y precio a la vez. El Brier propio sobre todas las predicciones y el del
mercado sobre las pocas con precio son muestras distintas y no se pueden comparar.

La referencia es Brier **0.2368 propio contra 0.2353 del mercado**. Si el tuyo no baja de eso de
forma sostenida, el número propio no aporta sobre el precio.

## Limitaciones conocidas

- El **diff de parche tiene cobertura parcial**. Data Dragon expone stats y valores de habilidades,
  no cambios de comportamiento ni de interacción. "Cambió" es un hecho; "no cambió" solo significa
  que no cambió nada de lo que Data Dragon muestra.
- El **roster para detectar suplentes es el vigente**, no el del día del partido: en partidos viejos
  puede marcar como suplente a quien entonces era titular.
- La probabilidad usa pesos explícitos **no validados fuera de muestra**. Están declarados como
  constantes en `engine/probability.js` para que se puedan criticar. El aporte del estado de
  partida está acotado a ±2.5 en log-odds y el total a [4%, 96%].
- El **ganador por mapa es inferido**, no leído: sale del estado final y se verifica contra el
  marcador de la serie. Las series que no verifican quedan sin atribuir, pero una serie puede
  verificar por casualidad con dos mapas invertidos. Es mucho mejor que 43% de cobertura, no es
  verdad revelada.
- Las 20 filas de la **tabla de extensión son juicio propio**, igual que la congelada, pero sin el
  respaldo del backtest. Se pueden corregir desde el editor.
- Los ejes de Riot **son de Riot**: describen el kit del campeón, no cómo se juega en profesional.
  `crowdControl` alto no distingue CC de peel de CC de inicio, y por eso peel y desenganche se
  marcan como *proxy* y no como medidos.
- La **validación mide la regla, no la tabla**: las dos usan el mismo juicio sobre qué es cada
  campeón, así que un fallo del índice no dice cuál de las dos cosas está mal.
- El índice de torneo depende de que la liga tenga partidos terminados en el split vigente.
- Los ejes estructurales se derivan de una tabla de juicio, no de datos medidos.

## Wire — la función oculta

Ruta `#/wire`. No está enlazada desde ninguna parte del sitio: se llega escribiéndola.

Vigila las 6 ligas pegada al poll que ya existe y encola una publicación en cada transición:

- **Arranca un mapa** → tweet con la probabilidad de cada equipo, la lectura del draft, el
  enfrentamiento clave, los logos de los dos equipos y los hashtags de liga y de equipo.
- **Termina el mapa** → tweet con el resultado, la clave del mapa, y el **MVP** con su foto oficial,
  KDA, participación en daño y oro, y una calificación.

La cola vive en `localStorage` y es idempotente: un mapa que ya generó su tweet no lo vuelve a
generar aunque el poll pase cien veces.

### Fotos y logos: no hacen falta scrapers

El endpoint `getTeams` del feed oficial **ya trae la foto de cada jugador y el logo de cada equipo**,
con nombre y apellido. Leaguepedia no se usa: además de ser una segunda fuente que mantener,
responde con `ratelimited` de forma sostenida desde este entorno.

### La calificación del MVP es un número inventado, y se dice

Se construye por componentes —participación en el daño, en kills y en el oro, más KDA, menos una
penalización por muertes— con los pesos declarados en `engine/tweet.js`. **No están validados contra
nada.** La diferencia con el resto del sitio es que este número es una etiqueta editorial: no entra
en ninguna probabilidad ni se registra para calibrar. La escala se divide por el máximo alcanzable,
así que un MVP típico cae entre 6.5 y 8.5 y el 10 es prácticamente inalcanzable.

### Por qué el sitio no publica solo

**Un sitio estático no puede postear en X.** La API pide OAuth con secretos de servidor, y cualquier
credencial embarcada en el bundle la lee quien abra el código — GitHub Pages sirve el fuente tal
cual. El wire deja cada tweet listo con su texto y las URLs de sus imágenes, y el último paso es un
click en "Abrir en X", que abre el compositor con el texto ya puesto.

Para que sea automático de punta a punta hace falta un proceso con credenciales, fuera del
navegador: `.github/workflows/wire.yml` + `tools/wire-bot.mjs`, que corre cada 10 minutos en GitHub
Actions y **reutiliza el mismo motor** — importa `engine/wire.js` tal cual, con un `localStorage` de
mentira apoyado en un archivo, para que no existan dos versiones del análisis que se desincronicen.

### Secrets y variables

En *Settings → Secrets and variables → Actions*. Los cuatro **secrets** salen del portal de
desarrolladores de X, en *Keys and tokens* de tu app:

| Secret | De dónde sale |
|---|---|
| `X_API_KEY` | Consumer Keys → API Key |
| `X_API_SECRET` | Consumer Keys → API Key Secret |
| `X_ACCESS_TOKEN` | Authentication Tokens → Access Token |
| `X_ACCESS_TOKEN_SECRET` | Authentication Tokens → Access Token Secret |

**La trampa que hace perder más tiempo:** la app tiene que estar en *Read and Write*, y el Access
Token hay que **regenerarlo después** de cambiar ese permiso. Un token generado antes queda de solo
lectura para siempre y falla con 403 sin explicar por qué.

Las **variables** (no son secretos, se ven en claro) controlan el comportamiento:

| Variable | Default | Para qué |
|---|---|---|
| `WIRE_VERIFY` | — | En `true` solo valida las credenciales contra `users/me` y termina. **Empezá por acá.** |
| `WIRE_LIVE` | `false` | Mientras no sea `true`, imprime lo que publicaría y no publica. |
| `WIRE_LEAGUES` | *(vacío = todas)* | Lista separada por comas: `LCK,LEC`. Es el freno principal. También acepta `todas`. |
| `WIRE_MAX_PER_RUN` | `4` | Tope de publicaciones por corrida. |
| `WIRE_MEDIA` | `true` | Si adjunta logos y foto del MVP. |

Y tres más que existen **solo para probar**. En operación normal el vigilante mira únicamente lo que
está en vivo, así que en cuanto un partido sale del feed en vivo queda fuera de alcance: sin esto no
hay forma de ensayar con un partido concreto.

| Variable | Ejemplo | Para qué |
|---|---|---|
| `WIRE_BACKFILL` | `24` | Horas hacia atrás a rastrear, además de lo que esté en vivo. |
| `WIRE_MATCH` | `115564797163821194` | Fuerza uno o más partidos por id, ignorando todo lo demás. |
| `WIRE_ONLY` | `post` | Genera solo los tweets de cierre (`post`) o solo los de arranque (`pre`). |

Borralas cuando termines de probar: dejar `WIRE_BACKFILL` puesto hace que cada corrida vuelva a
recorrer el calendario entero sin necesidad.

Se recomienda este orden: `WIRE_VERIFY=true` una corrida → `WIRE_VERIFY=false` y mirar dos o tres
simulacros en los logs → recién ahí `WIRE_LIVE=true`.

### El límite de la API es el que define el alcance

El tier gratuito de X permite del orden de **17 publicaciones por día**. Con 6 ligas y dos tweets
por mapa, un día cargado de LPL solo ya lo supera. Las opciones son acotar con `WIRE_LEAGUES` a una
o dos ligas, o pagar un tier superior. Conviene decidirlo antes de encenderlo, porque el bot no sabe
cuánto le queda de cuota: solo va a ver errores 429 y dejar las publicaciones sin marcar.

### Los hashtags de equipo son una tabla a mano

`TEAM_TAGS` en `engine/tweet.js`. Los hashtags oficiales cambian cada split y **ninguna API los
expone**, así que están curados a mano y conviene revisarlos al empezar cada temporada. Los que no
figuran caen al código del equipo (`#T1`, `#GEN`).

## Marca

El logo es la marca de verificación dibujada como una **barra de error**: el check es el trazo, y
debajo va la línea del intervalo con sus dos topes y el punto estimado corrido del centro. Es la
firma del proyecto — nada se afirma sin su intervalo, y el punto casi nunca cae donde uno querría.

La estética es la del cliente de League, que ya comparte paleta con la página: tinta azulada, oro
Hextech con bisel, rombos y esquinas cortadas, y el punto estimado como hexágono en el azul de
acento.

| Archivo | Uso |
|---|---|
| `checkmatch-logo-*.jpg` | Favicon, apple-touch-icon y `og:image`. Con marco. |
| `checkmatch-avatar-*.jpg` | **Avatar de Twitter.** Sin marco, porque ahí el recorte es circular y las esquinas del marco caen fuera. |
| `checkmatch-banner-1500x500.jpg` | **Encabezado de Twitter.** |

Todo se genera con `tools/logo.ps1` y `tools/banner.ps1` (System.Drawing, sin dependencias) y con
semilla fija, así que el grano es reproducible byte a byte.

Las dos restricciones del formato que definen las composiciones, las dos verificadas con un mock
compuesto y no a ojo:

- El **avatar tapa la esquina inferior izquierda del banner**, así que el trazo arranca recién en
  x=344 y el bloque de texto en x=650.
- El avatar se recorta en **círculo**: en la variante de avatar el punto más lejano queda a r=468 de
  un radio de 512. A escala 1.16 quedaba en 503, rozando el borde.

## Desarrollo

No hay pasos de build. Cualquier servidor estático sirve; los módulos ES necesitan HTTP, no
`file://`. Si no tenés Node ni Python a mano, el repo trae un servidor mínimo que solo usa
componentes de Windows:

```powershell
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

Después abrí http://localhost:8100/.

## Licencia y créditos

Datos de Riot Games vía los feeds públicos de LoL Esports y Data Dragon. Proyecto no afiliado a
Riot Games.
