/**
 * elo.js — fuerza de equipo que sabe contra quién jugaste.
 *
 * El récord tiene un defecto que no se arregla con más partidas: trata todas
 * las victorias igual. Un 6-2 contra los últimos de la tabla y un 6-2 contra
 * los punteros son el mismo número, y no son la misma información. Un rating
 * Elo sí los distingue, porque cada partido mueve el rating según lo que valía
 * el rival.
 *
 * CUIDADO CON LA UNIDAD, que acá ya nos costó caro dos veces.
 *
 * `buildProbability` predice UN MAPA. Una serie al mejor de tres es bastante
 * más predecible que un mapa suelto, así que los parámetros ajustados sobre
 * series salen demasiado agresivos al aplicarlos a mapas. La primera versión de
 * esto usaba escala 60, ajustada en series, y quedaba con una calibración mala
 * de verdad: donde decía 91% ganaba 78%, y donde decía 23% ganaba 34%.
 *
 * Todo lo de acá está medido POR MAPA, que es la unidad en la que se usa.
 *
 * Corte cronológico sobre 1900 mapas, hiperparámetros elegidos dentro del
 * entrenamiento y evaluados una sola vez sobre 570 mapas no vistos:
 *
 *   base 50-50   Brier 0.2500
 *   Elo          Brier 0.2285   61% [57, 65]
 *   récord       Brier 0.2292   62% [58, 66]
 *
 * O sea que por mapa los dos empatan. El Elo se usa igual, por dos razones que
 * no son el Brier: existe para cualquier liga indexada aunque el torneo no
 * publique standings, y pondera contra quién jugó cada equipo, que es
 * información que el récord no puede representar. Prediciendo SERIES, donde el
 * ruido del mapa suelto se promedia, la ventaja del Elo sí aparece (0.2066
 * contra 0.2095).
 *
 * Entran como alternativas y no como suma: el ajuste conjunto le da al récord
 * peso CERO cuando el Elo está disponible. Sumarlos contaría la misma fuerza
 * dos veces, que es exactamente el error que cometimos con la ventaja de lado.
 */

/** Hiperparámetros medidos POR MAPA. No tocar sin volver a correr la validación. */
export const ELO_PARAMS = {
  inicial: 1500,
  K: 12,        // cuánto mueve cada MAPA. Barrido 12-40; 12 fue el mejor.
  escala: 90,   // divide la diferencia antes del logit. Ajustado por mapa.
  // La regresión mensual hacia la media (por cambios de roster) salió elegida
  // en 0: con este corpus no mejora. Se deja el parámetro porque la próxima
  // pretemporada probablemente la pida.
  regresionMensual: 0,
};

const esperado = (ra, rb) => 1 / (1 + 10 ** ((rb - ra) / 400));

/**
 * Ratings a partir de una lista de mapas con ganador.
 *
 * Los mapas se procesan en orden cronológico y cada uno actualiza a los dos
 * equipos. Se usa el MAPA como unidad, no la serie: son 2066 actualizaciones
 * en vez de 867, y el rating converge bastante antes.
 *
 * @param {Array} maps mapas con {date, blueTeamId, redTeamId, winner}
 * @returns {{ratings: Map<string, number>, partidas: Map<string, number>}}
 */
export function buildElo(maps, opts = {}) {
  const { K, inicial, regresionMensual } = { ...ELO_PARAMS, ...opts };
  const ratings = new Map();
  const partidas = new Map();
  // Última fecha jugada por equipo: hace falta para medir el parón.
  const ultimo = new Map();
  const R = (id) => ratings.get(id) ?? inicial;

  const orden = maps
    .filter((m) => m?.winner && m?.date && m?.blueTeamId && m?.redTeamId)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  let mesPrevio = null;
  for (const m of orden) {
    const mes = String(m.date).slice(0, 7);
    if (regresionMensual > 0 && mesPrevio && mes !== mesPrevio) {
      for (const [k, v] of ratings) {
        ratings.set(k, inicial + (v - inicial) * (1 - regresionMensual));
      }
    }
    mesPrevio = mes;

    const A = m.blueTeamId;
    const B = m.redTeamId;
    const ganoA = m.winner === 'blue' ? 1 : 0;
    const eA = esperado(R(A), R(B));
    ratings.set(A, R(A) + K * (ganoA - eA));
    ratings.set(B, R(B) + K * ((1 - ganoA) - (1 - eA)));
    partidas.set(A, (partidas.get(A) ?? 0) + 1);
    partidas.set(B, (partidas.get(B) ?? 0) + 1);
    ultimo.set(A, m.date);
    ultimo.set(B, m.date);
  }
  return { ratings, partidas, ultimo };
}

/**
 * Lo que el Elo aporta en log-odds, listo para sumar en buildProbability.
 *
 * Devuelve null —y no cero— cuando alguno de los dos equipos no tiene historia
 * suficiente. La diferencia importa: cero es "los dos son igual de fuertes" y
 * null es "no sé", y el modelo tiene que poder distinguirlos para decir cuándo
 * se quedó sin insumos.
 */
export const MIN_PARTIDAS_ELO = 5;

/**
 * Cuánto vale un rating después de un parón.
 *
 * El Elo no envejece: `regresionMensual` está en 0 porque medido sobre el
 * corpus anterior no mejoraba. Pero eso se midió sobre partidos seguidos, y
 * entre splits hay parones de seis semanas donde cambian rosters, parche y
 * meta. El rating entra intacto igual, y ahí es donde el modelo se rompe.
 *
 * Medido sobre 1736 mapas evaluados camino adelante, partiendo por los días que
 * el equipo MÁS oxidado de los dos llevaba sin jugar:
 *
 *   días sin jugar   acierto            n      Brier
 *      0-4           62% [59, 64]      1271    0.2316
 *      4-10          64% [59, 69]       348    0.2212
 *     10-21          54% [40, 67]        48    0.2474
 *     21-45          54% [35, 72]        24    0.2555
 *     45+            38% [25, 52]        45    0.2656
 *
 * A partir de 45 días el modelo no solo deja de acertar: acierta MENOS que una
 * moneda, y con la misma confianza media que en un partido normal. Eso es lo
 * peor que puede pasar — seguridad plena sobre información vencida. El
 * intervalo del tramo largo ni toca el del tramo normal.
 *
 * La corrección encoge la diferencia de rating hacia cero según el parón.
 * Elegida por Brier fuera de muestra sobre la mitad que no se usó para
 * ajustarla (868 mapas, 31 con parón largo):
 *
 *   sin ajuste                    Brier 0.2726   48% en el tramo de 45+
 *   corte duro a 0                      0.2611   42%
 *   decaimiento exponencial             0.2579   55%
 *   escalones 0.5 / 0.25                0.2563   55%   <- elegida
 *
 * El efecto global es chico porque son pocos partidos (31 de 868). No es un
 * ajuste para subir el número general: es para dejar de afirmar con seguridad
 * justo cuando no se sabe.
 */
export const STALENESS = [
  { dias: 45, factor: 0.25 },
  { dias: 21, factor: 0.50 },
];

/** Factor por el que se multiplica la diferencia de Elo según el parón. */
export function stalenessFactor(dias) {
  if (dias == null || !Number.isFinite(dias)) return 1;
  for (const t of STALENESS) if (dias >= t.dias) return t.factor;
  return 1;
}

/**
 * @param {number|null} dias  días sin jugar del equipo más oxidado de los dos.
 *   Si no se pasa, el comportamiento es el de siempre.
 */
export function eloLogOdds(a, b, { escala = ELO_PARAMS.escala, dias = null } = {}) {
  if (a?.rating == null || b?.rating == null) return null;
  if ((a.partidas ?? 0) < MIN_PARTIDAS_ELO || (b.partidas ?? 0) < MIN_PARTIDAS_ELO) return null;
  return ((a.rating - b.rating) / escala) * stalenessFactor(dias);
}

/** Busca a un equipo en la tabla, devolviendo también cuántos mapas lo sostienen. */
export function eloFor(tabla, teamId) {
  if (!tabla || teamId == null) return null;
  const rating = tabla.ratings?.get(teamId);
  if (rating == null) return null;
  return {
    rating,
    partidas: tabla.partidas?.get(teamId) ?? 0,
    ultimo: tabla.ultimo?.get(teamId) ?? null,
  };
}
