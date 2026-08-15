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
| Draft | Los diez campeones por posición, mapeados por `esportsTeamId` |
| Índice | Δ de teamfight en desviaciones estándar, banda y arquetipo primario |
| Concentración | Las una o dos posiciones donde se concentra el margen estructural |
| Capa de campeón | Winrate por torneo, solo con 10+ picks |
| Capa de jugador | Partidas por jugador con el campeón que juega hoy |
| Parche | Versión del feed |
| Ventana | Punto de quiebre como rango de minutos, con afirmaciones verificables |
| Lectura | Probabilidad por componentes y postura de apuesta |
| Señales | 3-6 cosas falsables para mirar entre el minuto 14 y el 20 |

## Cómo está construido

Sin dependencias, sin bundler, sin `node_modules`. Módulos ES nativos.

```
index.html
assets/css/app.css
assets/js/
  app.js                  orquestador y render
  api.js                  clientes de esports-api, feed y Data Dragon
  data/tables.js          tablas CONGELADAS (146 campeones, 62 comps de referencia)
  engine/index-score.js   port de score_draft.py
  engine/structural.js    ejes de counter, matchups, concentración y ventana
  engine/meta.js          índice de torneo: capas de campeón y jugador
  engine/live.js          señales de verificación en vivo
  engine/probability.js   probabilidad por componentes y postura
```

### Fuentes de datos

| Qué | Endpoint | CORS |
|---|---|---|
| Calendario, partidos, standings | `esports-api.lolesports.com/persisted/gw/…` | sí |
| Draft, parche, estado en vivo | `feed.lolesports.com/livestats/v1/window/{gameId}` | sí |
| Stats por jugador | `feed.lolesports.com/livestats/v1/details/{gameId}` | sí |
| Retratos de campeón | Data Dragon | sí |
| gol.gg | — | **no** |

`gol.gg` no manda cabeceras CORS, así que no es consultable desde el navegador. En vez de
scrapearlo, las capas de campeón y jugador se reconstruyen desde la fuente primaria: el botón
**Indexar torneo** recorre los partidos ya jugados y acumula picks por campeón y por jugador
leyendo el draft de cada mapa. El índice queda cacheado en `localStorage` por 6 horas.

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

### Sobre el winrate

La API expone el marcador de la **serie**, no el ganador de cada **mapa**. Entonces los picks se
cuentan sobre todos los mapas, pero el winrate solo se atribuye en series barridas (2-0, 3-0),
donde todos los mapas fueron del mismo equipo. Ese subconjunto está sesgado hacia series
decisivas y el sitio lo dice en cada informe en vez de presentarlo como winrate del torneo.

### Postura de apuesta

**NO BET por defecto**, y no hay camino en el código que devuelva otra cosa. En el backtest de
21 predicciones, el análisis propio tuvo Brier 0.2368 contra 0.2353 del mercado, con λ\*=0: el
mercado gana. Las value bets acertaron 33% con ROI −28.2%, o sea que el edge medido fue negativo.
Esto sirve para entender partidos, no para justificar una entrada.

## Limitaciones conocidas

- El sitio **no mantiene una lista de cambios de balance**, así que reporta la versión del parche
  pero no afirma qué campeones fueron tocados.
- La probabilidad usa pesos explícitos **no validados fuera de muestra**. Están declarados como
  constantes en `engine/probability.js` para que se puedan criticar.
- El índice de torneo depende de que la liga tenga partidos terminados en el split vigente.
- Los ejes estructurales se derivan de una tabla de juicio, no de datos medidos.

## Desarrollo

No hay pasos de build. Cualquier servidor estático sirve; los módulos ES necesitan HTTP, no
`file://`.

## Licencia y créditos

Datos de Riot Games vía los feeds públicos de LoL Esports y Data Dragon. Proyecto no afiliado a
Riot Games.
