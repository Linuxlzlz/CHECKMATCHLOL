/**
 * evidence.js — cuánto acierta cada cosa que el sitio afirma.
 *
 * Medido sobre el corpus indexado el 17/08/2026: 424 mapas de LCK, LCK CL, LPL,
 * LEC, LCS y CBLOL, 414 con ganador resuelto. Cada número es la tasa de acierto
 * de "gana el lado que este eje favorece", con su IC95 de Wilson.
 *
 * Existe por una razón simple: el sitio afirma cosas como "LYON escala mejor" y
 * hasta ahora las afirmaba con el mismo tono tuviera respaldo o no. Con esto,
 * cada afirmación puede llevar al lado cuánto vale.
 *
 * NO se toca a mano para que un eje "mejore". Se regenera desde la tarjeta de
 * validación del sitio cuando el corpus crece, y se copia acá con su fecha.
 */

export const EVIDENCE = {
  medidoEl: '2026-08-17',
  mapas: 414,
  ligas: ['LCK', 'LCK CL', 'LPL', 'LEC', 'LCS', 'CBLOL'],

  /**
   * La ventaja de lado azul. Es el predictor más fuerte que apareció en todo el
   * corpus, y el único cuyo intervalo no toca el 50%. Que le gane a los cinco
   * ejes del índice juntos dice bastante sobre los cinco ejes.
   */
  ladoAzul: { p: 0.570, n: 414, low: 0.522, high: 0.617, solido: true },

  /**
   * El récord de cada equipo, en prueba PROSPECTIVA: para cada mapa se calcula
   * solo con los anteriores, que es como se usaría en vivo. Es, después del
   * lado, lo único que mejora la predicción de forma clara.
   *
   * El barrido de pesos tiene mínimo entre 3 y 4, y empeora a partir de 5 — que
   * la curva tenga fondo es la señal de que el efecto es real y no un artefacto
   * de dejarlo crecer. El peso del modelo es 2.2 y queda cerca del óptimo sin
   * llegar a apostar por él.
   */
  record: {
    base: { brier: 0.2383, acierto: 0.62, n: 215 },
    conRecord: { brier: 0.2249, acierto: 0.66, peso: 2.2 },
    optimo: { peso: 3.5, brier: 0.2236 },
    porHistoria: {
      3: { n: 308, brier: 0.2310, acierto: 0.62 },
      6: { n: 215, brier: 0.2249, acierto: 0.66 },
      10: { n: 102, brier: 0.2204, acierto: 0.67 },
    },
    minimoUtil: 6,
  },

  /** Acierto de cada eje del índice, cara a cara. */
  ejes: {
    teamfight: { p: 0.50, n: 400, low: 0.45, high: 0.55 },
    pick: { p: 0.52, n: 391, low: 0.47, high: 0.57 },
    split: { p: 0.50, n: 323, low: 0.45, high: 0.56 },
    siege: { p: 0.49, n: 354, low: 0.43, high: 0.54 },
    scaling: { p: 0.54, n: 330, low: 0.49, high: 0.59 },
  },

  /**
   * El test que define si el eje de escalado mide lo que dice medir: tendría que
   * acertar MÁS en partidas largas que en cortas. Acierta igual. Eso no es "mide
   * poco", es que no está midiendo escalado.
   */
  escalado: { largas: 0.53, cortas: 0.55, nLargas: 166, nCortas: 163 },

  /**
   * Ejes que Riot publica por campeón, medidos con el mismo método. Ninguno
   * sobrevive a la corrección por comparaciones múltiples (12 pruebas), así que
   * son hipótesis a vigilar y no hallazgos. La movilidad invertida es la más
   * marcada y la más rara: el lado con más movilidad gana menos.
   */
  riot: {
    crowdControl: { p: 0.56, n: 312 },
    durability: { p: 0.53, n: 326 },
    mobility: { p: 0.43, n: 344, nota: 'invertido, no sobrevive a la corrección' },
    damage: { p: 0.47, n: 341 },
    ranged: { p: 0.47, n: 248 },
  },
};

/** Etiqueta corta para poner al lado de una afirmación de eje. */
export function axisEvidenceLabel(axis) {
  const e = EVIDENCE.ejes[axis];
  if (!e) return null;
  return `${Math.round(e.p * 100)}%`;
}

/** ¿Este eje tiene respaldo medido, o es solo la tabla? */
export const axisSupported = (axis) => {
  const e = EVIDENCE.ejes[axis];
  return !!e && e.low > 0.5;
};
