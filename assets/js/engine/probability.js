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

import { EVIDENCE } from '../data/evidence.js';

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
  corpusTeam: 2.2,    // sobre la diferencia de winrate medida en el corpus
};

/**
 * Peso del draft, decidido por la medición y no por juicio.
 *
 * Sobre 411 mapas de las 6 ligas, la banda grande del índice acierta 51%
 * [44, 58] y el componente de draft EMPEORA el Brier fuera de muestra. Mientras
 * el corpus diga eso, este componente entra en cero: mantenerlo en 0.30 sería
 * saber que resta y usarlo igual.
 *
 * No está clavado en cero: si un corpus futuro muestra que el índice separa
 * ganadores, el peso vuelve solo. La regla es "el peso lo fija la última
 * medición", no "el draft no sirve".
 */
/**
 * Peso del draft según la medición congelada, para quien no tenga corpus a mano
 * — el bot, por ejemplo. Mantiene al sitio y al bot diciendo lo mismo: sin esto,
 * la tarjeta podía afirmar que el índice no separa ganadores y a la vez usarlo
 * con peso completo para calcular el número que mostraba.
 */
export function draftWeightFromEvidence() {
  const tf = EVIDENCE.ejes?.teamfight;
  if (tf && tf.low <= 0.5 && tf.high >= 0.5) {
    return {
      weight: 0,
      measured: true,
      reason:
        `Medido sobre ${tf.n} mapas: el eje acierta ${Math.round(tf.p * 100)}% ` +
        `(IC95 [${Math.round(tf.low * 100)}, ${Math.round(tf.high * 100)}], cruza el 50%). ` +
        `Entra en cero.`,
    };
  }
  return { weight: WEIGHTS.draft, measured: false, reason: null };
}

export function draftWeightFrom(validation) {
  if (!validation?.usable) {
    return { weight: WEIGHTS.draft, reason: 'Sin corpus indexado: se usa el peso por defecto, que nunca fue validado fuera de muestra.', measured: false };
  }
  const strong = validation.byBand?.strong;
  if (!strong || strong.n < 60) {
    return { weight: WEIGHTS.draft, reason: `Solo ${strong?.n ?? 0} mapas de banda grande en el corpus: no alcanza para cambiar el peso.`, measured: false };
  }
  if (strong.straddles) {
    return {
      weight: 0,
      measured: true,
      reason:
        `En ${strong.n} mapas del corpus la banda grande acierta ${(strong.p * 100).toFixed(0)}% ` +
        `(IC95 [${(strong.low * 100).toFixed(0)}, ${(strong.high * 100).toFixed(0)}], cruza el 50%). ` +
        `El componente entra en CERO: usarlo sabiendo que no separa ganadores sería agregar ruido ` +
        `con cara de análisis. Vuelve solo si el corpus cambia de opinión.`,
    };
  }
  return {
    weight: WEIGHTS.draft,
    measured: true,
    reason: `La banda grande acierta ${(strong.p * 100).toFixed(0)}% en ${strong.n} mapas del corpus, sin cruzar el 50%: el peso por defecto se sostiene.`,
  };
}

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
export function buildProbability({
  recordA, recordB, tfDelta, goldDiff, minute, finished = false,
  corpusTeam = null, draftWeight = null, sideRate = null,
}) {
  const components = [];
  let x = logit(0.5); // 0

  // 0. Ventaja de lado.
  //
  // El modelo arrancaba en 50-50 e ignoraba el lado, cuando el lado resultó ser
  // el predictor MÁS FUERTE de todo el corpus: el azul gana 57% (n=414, IC95
  // [52, 62]), y le gana a los cinco ejes del índice juntos. Empezar en 50-50
  // era descartar gratis la única señal sólida que hay antes del primer minuto.
  const sr = sideRate ?? EVIDENCE.ladoAzul.p;
  if (sr && sr !== 0.5) {
    const contrib = logit(sr);
    x += contrib;
    components.push({
      id: 'side',
      label: 'Ventaja de lado azul',
      detail: sideRate
        ? `${(sr * 100).toFixed(0)}% medido en el corpus indexado`
        : `${(sr * 100).toFixed(0)}% sobre ${EVIDENCE.ladoAzul.n} mapas (medido el ${EVIDENCE.medidoEl})`,
      contrib,
      note:
        'El predictor más sólido que apareció: su intervalo no toca el 50%, cosa que ' +
        'ninguno de los cinco ejes del índice logra.',
    });
  }

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

  // 1b. Fuerza de equipo MEDIDA en el corpus indexado.
  //
  // Es el único componente que le gana a la línea base fuera de muestra: Brier
  // 0.2281 contra 0.2400 de "predecir siempre al lado azul", sobre 124 mapas que
  // el modelo no vio al entrenarse. Entra aparte de los standings porque mide
  // otra cosa — winrate por MAPA en el corpus, no por serie en la tabla — y
  // porque existe aunque el torneo no publique standings.
  if (corpusTeam && corpusTeam.a != null && corpusTeam.b != null) {
    const n = (corpusTeam.gamesA ?? 0) + (corpusTeam.gamesB ?? 0);
    const shrink = n / (n + 20);
    // Si los standings ya entraron, este componente pesa la mitad: los dos miden
    // calidad de equipo y sumarlos enteros contaría lo mismo dos veces.
    const share = wa !== null && wb !== null ? 0.5 : 1;
    const contrib = WEIGHTS.corpusTeam * (corpusTeam.a - corpusTeam.b) * shrink * share;
    x += contrib;
    components.push({
      id: 'corpus-team',
      label: 'Fuerza de equipo (corpus indexado)',
      detail:
        `${(corpusTeam.a * 100).toFixed(0)}% contra ${(corpusTeam.b * 100).toFixed(0)}% por mapa · ` +
        `n=${n} mapas · encogido ×${shrink.toFixed(2)}${share < 1 ? ' · a mitad de peso por solaparse con los standings' : ''}`,
      contrib,
      note:
        'Único componente que le gana a la línea base fuera de muestra (Brier 0.2281 contra 0.2400 ' +
        'en 124 mapas no vistos). Ver la tarjeta de validación.',
    });
  }

  // 2. Draft. Solo entra por encima de la banda de moneda al aire, y con el peso
  //    que diga la última medición.
  const dw = draftWeight ?? { weight: WEIGHTS.draft, reason: null, measured: false };
  if (tfDelta !== null && tfDelta !== undefined) {
    if (Math.abs(tfDelta) >= 0.5 && dw.weight > 0) {
      const contrib = dw.weight * tfDelta;
      x += contrib;
      components.push({
        id: 'draft',
        label: 'Draft (índice de teamfight)',
        detail: `Δ ${tfDelta >= 0 ? '+' : ''}${tfDelta.toFixed(2)} sd · peso ${dw.weight.toFixed(2)}`,
        contrib,
        note: dw.reason ?? 'Aporta pocos puntos a propósito: la banda grande falla una de cada cuatro.',
      });
    } else if (Math.abs(tfDelta) >= 0.5 && dw.weight === 0) {
      components.push({
        id: 'draft',
        label: 'Draft (índice de teamfight)',
        detail: `Δ ${tfDelta >= 0 ? '+' : ''}${tfDelta.toFixed(2)} sd · peso 0 por medición`,
        contrib: 0,
        excluded: true,
        note: dw.reason,
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
    hasQuality: (wa !== null && wb !== null) || !!(corpusTeam?.a != null && corpusTeam?.b != null),
    hasStandings: wa !== null && wb !== null,
    draftWeight: dw,
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
