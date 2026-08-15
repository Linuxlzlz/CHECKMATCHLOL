/**
 * probability.js — Paso 8: probabilidad por componentes y postura de apuesta.
 *
 * El número se construye sumando en log-odds y mostrando cada componente, para
 * que se pueda discutir la parte y no solo el total. Los pesos son constantes
 * explícitas y declaradas: NO están validados fuera de muestra.
 *
 * Postura por defecto: NO BET. En el backtest del usuario (21 predicciones) el
 * Brier propio fue 0.2368 contra 0.2353 del mercado, con λ*=0 — el juicio
 * propio no aportó sobre el precio. Si hay precio en vivo, ese precio es mejor
 * estimador que este número.
 */

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Pesos. Explícitos a propósito para que se puedan criticar.
 *  - La calidad de equipos suele ser casi todo el margen.
 *  - El draft aporta pocos puntos.
 *  - El estado de partida domina una vez que la partida avanzó.
 */
export const WEIGHTS = {
  teamQuality: 2.2,   // sobre (winrate_a - winrate_b), rango [-1, 1]
  draft: 0.30,        // por sd de Δ teamfight, solo si |Δ| > 0.5
  goldPerK: 0.55,     // por cada 1000 de oro de diferencia, escalado por minuto
};

/**
 * Topes. Una ventaja de 16k al minuto 30 es abrumadora, pero este modelo es
 * lineal y crudo: dejarlo llegar a 0% o 100% sería fingir una precisión que no
 * tiene. Se acota el aporte del estado y el total resultante.
 */
export const CLAMP = { stateLogOdds: 2.5, pMin: 0.04, pMax: 0.96 };

/**
 * @param {object} input
 * @param {{wins:number,losses:number}|null} input.recordA
 * @param {{wins:number,losses:number}|null} input.recordB
 * @param {number|null} input.tfDelta   Δ de índice de teamfight (A - B)
 * @param {number|null} input.goldDiff  oro A - oro B (null si no arrancó)
 * @param {number|null} input.minute
 */
export function buildProbability({ recordA, recordB, tfDelta, goldDiff, minute, finished = false }) {
  const components = [];
  let x = logit(0.5); // 0

  // 1. Calidad de los equipos.
  const wr = (r) => (r && r.wins + r.losses > 0 ? r.wins / (r.wins + r.losses) : null);
  const wa = wr(recordA);
  const wb = wr(recordB);
  if (wa !== null && wb !== null) {
    const n = recordA.wins + recordA.losses + recordB.wins + recordB.losses;
    // Encoge hacia cero con muestras chicas: 4 partidas no son una temporada.
    const shrink = n / (n + 8);
    const contrib = WEIGHTS.teamQuality * (wa - wb) * shrink;
    x += contrib;
    components.push({
      id: 'quality',
      label: 'Calidad de equipos (standings)',
      detail: `${(wa * 100).toFixed(0)}% contra ${(wb * 100).toFixed(0)}% · n=${n} partidas · encogido ×${shrink.toFixed(2)}`,
      contrib,
      note: 'Suele ser casi todo el margen y el mercado ya lo tiene priceado.',
    });
  } else {
    components.push({
      id: 'quality',
      label: 'Calidad de equipos (standings)',
      detail: 'Sin récord disponible para este torneo.',
      contrib: 0,
      missing: true,
      note: 'Falta el componente que más pesa. El número de abajo vale mucho menos.',
    });
  }

  // 2. Draft. Solo entra por encima de la banda de moneda al aire.
  if (tfDelta !== null && tfDelta !== undefined) {
    if (Math.abs(tfDelta) >= 0.5) {
      const contrib = WEIGHTS.draft * tfDelta;
      x += contrib;
      components.push({
        id: 'draft',
        label: 'Draft (índice de teamfight)',
        detail: `Δ ${tfDelta >= 0 ? '+' : ''}${tfDelta.toFixed(2)} sd`,
        contrib,
        note: 'Aporta pocos puntos a propósito: la banda grande es 74%, falla una de cada cuatro.',
      });
    } else {
      components.push({
        id: 'draft',
        label: 'Draft (índice de teamfight)',
        detail: `Δ ${tfDelta >= 0 ? '+' : ''}${tfDelta.toFixed(2)} sd — por debajo de 0.5`,
        contrib: 0,
        note: 'Moneda al aire: no entra ni como desempate.',
      });
    }
  }

  // 3. Estado de la partida. En un mapa terminado no entra: el resultado ya se
  //    sabe y una "probabilidad" de 0% no es una predicción, es un marcador.
  if (finished) {
    components.push({
      id: 'state',
      label: 'Estado de la partida',
      detail: 'El mapa terminó. El estado se excluye del número.',
      contrib: 0,
      excluded: true,
      note:
        'Lo que queda abajo es la lectura PREVIA: lo que decían la calidad de equipos y el ' +
        'draft antes de jugarse. Eso es lo único que sirve para calibrar.',
    });
  } else if (goldDiff !== null && goldDiff !== undefined && minute) {
    // El mismo oro pesa más tarde que temprano.
    const ramp = Math.min(1, Math.max(0, (minute - 8) / 17));
    const raw = WEIGHTS.goldPerK * (goldDiff / 1000) * ramp;
    const contrib = Math.max(-CLAMP.stateLogOdds, Math.min(CLAMP.stateLogOdds, raw));
    x += contrib;
    components.push({
      id: 'state',
      label: 'Estado de la partida',
      detail:
        `${goldDiff >= 0 ? '+' : ''}${goldDiff.toLocaleString('es')} de oro al minuto ${minute.toFixed(0)} · ` +
        `peso por minuto ×${ramp.toFixed(2)}` +
        (contrib !== raw ? ` · acotado desde ${raw.toFixed(2)}` : ''),
      contrib,
      note:
        Math.abs(goldDiff) < 1000 && minute >= 20
          ? 'Menos de 1k al minuto 20 es empate, y el empate favorece a quien tiene mejor tardío.'
          : contrib !== raw
            ? 'Aporte acotado: el modelo es lineal y crudo, no puede afirmar certezas.'
            : null,
    });
  }

  const rawP = sigmoid(x);
  const p = Math.max(CLAMP.pMin, Math.min(CLAMP.pMax, rawP));
  return {
    p,
    rawP,
    clamped: p !== rawP,
    finished: !!finished,
    components,
    logOdds: x,
    hasQuality: wa !== null && wb !== null,
  };
}

/**
 * Postura. Por defecto NO BET, y no hay camino en el código que devuelva otra
 * cosa sin un precio de mercado que el usuario cargue a mano.
 */
export function bettingStance({ p, marketP }) {
  if (marketP == null) {
    return {
      stance: 'NO BET',
      reason:
        'Postura por defecto. Sin precio de mercado cargado no hay con qué comparar, y el ' +
        'backtest dice que el juicio propio no le gana al cierre (λ*=0, Brier 0.2368 contra 0.2353).',
    };
  }
  const edge = p - marketP;
  return {
    stance: 'NO BET',
    edge,
    reason:
      `Diferencia contra el mercado: ${(edge * 100).toFixed(1)} puntos. En el backtest, las ` +
      `value bets (donde más se discrepó del mercado) acertaron 33% con ROI −28.2%: el edge ` +
      `medido fue negativo. La métrica oficial es CLV, no aciertos. El número propio debería ` +
      `moverse hacia el precio, no al revés.`,
  };
}

/** Paso 10 — desacuerdo entre capas. Son los únicos partidos que enseñan algo. */
export function layerDisagreement(layers) {
  const voted = layers.filter((l) => l.favors);
  const sides = new Set(voted.map((l) => l.favors));
  return {
    disagreement: sides.size > 1,
    layers: voted,
    note:
      sides.size > 1
        ? 'Las capas no apuntan al mismo lado. Anotá cuál acierta: en la mayoría de los drafts ' +
          'son colineales, así que su acuerdo es redundancia, no confirmación. Solo los ' +
          'desacuerdos discriminan entre explicaciones.'
        : 'Las capas son colineales acá. Que coincidan no es confirmación independiente: las tres ' +
          'correlacionan con "este equipo drafteó mejor". No sube la confianza.',
  };
}
