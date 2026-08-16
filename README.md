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
| gol.gg | — | **no** |

`gol.gg` no manda cabeceras CORS, así que no es consultable desde el navegador. En vez de
scrapearlo, las capas de campeón y jugador se reconstruyen desde la fuente primaria: al entrar a
una liga el sitio **indexa el torneo solo** en segundo plano, recorriendo los partidos ya jugados
y acumulando picks, winrate, rol y parche por campeón y por jugador. El índice queda cacheado en
`localStorage` por 6 horas.

Cuando el torneo vigente no tiene muestra suficiente para un campeón, se puede **indexar otra
liga**: el agregado aparece como respaldo etiquetado, nunca reemplazando el dato del torneo. Otra
liga es otro meta, y el Paso 4 pide el winrate *de este torneo*.

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
- **La banda grande vale 74%**, con IC95 [57, 86]. El lenguaje está calibrado a eso: falla una de
  cada cuatro.
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
- El índice de torneo depende de que la liga tenga partidos terminados en el split vigente.
- Los ejes estructurales se derivan de una tabla de juicio, no de datos medidos.

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
