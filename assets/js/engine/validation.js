/**
 * validation.js — el sitio midiéndose a sí mismo.
 *
 * Hasta acá había una sola afirmación cuantitativa sostenida por evidencia: la
 * banda grande del índice vale 74%, con IC95 [57, 86], sobre un backtest de 31
 * partidos. Todo lo demás era juicio declarado. Y esa cifra venía de afuera: el
 * sitio la citaba sin poder reproducirla.
 *
 * Desde que el índice de torneo resuelve el ganador de cada mapa, hay corpus
 * local: drafts completos + resultado + duración + parche. Con eso se puede
 * volver a correr el test sobre datos que el backtest original no vio.
 *
 * Tres controles, en orden de importancia:
 *
 *  1. ¿La banda del índice predice? Es la única afirmación con número del sitio.
 *  2. ¿El eje de escalado predice las partidas largas? Es lo que sostiene la
 *     tarjeta de Ventana, que hasta ahora era heurística pura.
 *  3. ¿El winrate por lado da algo razonable? Esto NO valida el índice: valida el
 *     resolutor de ganadores. Si el lado azul apareciera con 85%, la inferencia
 *     estaría rota y todo lo de arriba sería basura. Es el control de sanidad.
 *
 * Advertencia que va en la UI y no se puede omitir: la muestra es nueva pero la
 * TABLA es la misma. Esto testea si la regla se sostiene, no si la tabla es
 * correcta; los dos usan el mismo juicio sobre qué es cada campeón.
 */

import { scoreDraft, band } from './index-score.js';
import { wilson } from './meta.js';

/** Mínimo para decir cualquier cosa. Por debajo, se reporta el n y nada más. */
export const MIN_SAMPLE = 12;

function rateOf(hits, n) {
  if (!n) return null;
  const ci = wilson(hits, n);
  return {
    hits, n, p: ci.p, low: ci.low, high: ci.high,
    // Un IC que cruza el 50% no distingue la regla de tirar una moneda.
    straddles: ci.low <= 0.5 && ci.high >= 0.5,
  };
}

/**
 * @param {object} index índice de torneo con `maps`
 * @returns validación o `{usable:false, reason}` si no hay corpus
 */
export function validateIndex(index) {
  const maps = (index?.maps ?? []).filter(
    (m) => m.winner && m.blue?.length === 5 && m.red?.length === 5
  );
  if (maps.length < 4) {
    return {
      usable: false,
      n: maps.length,
      reason:
        `El corpus indexado tiene ${maps.length} mapas con draft completo y ganador resuelto. ` +
        `No alcanza para medir nada; indexá el torneo (o más ligas) y volvé.`,
    };
  }

  // --- puntuar cada mapa con las fórmulas congeladas ---
  const rows = maps.map((m) => {
    const s = scoreDraft(
      { team: 'blue', champions: m.blue },
      { team: 'red', champions: m.red }
    );
    const tfDelta = s.tfDelta;               // + favorece al azul
    const scaleDelta = s.sides[0].raw.scaling - s.sides[1].raw.scaling;
    const blueWon = m.winner === 'blue';
    return {
      gameId: m.gameId,
      tfDelta,
      scaleDelta,
      duration: m.duration ?? null,
      patch: m.patch ?? null,
      blueWon,
      // ¿acertó el índice? Con delta 0 no hay predicción que evaluar.
      tfHit: tfDelta === 0 ? null : (tfDelta > 0) === blueWon,
      scaleHit: scaleDelta === 0 ? null : (scaleDelta > 0) === blueWon,
      bandTier: band(tfDelta).tier,
      // El propio script avisa que si las DOS comps están por debajo del promedio
      // de la referencia, el mapa cae fuera de la zona donde el hallazgo es limpio.
      // Medir sin separar por régimen mezcla dos poblaciones distintas.
      belowRegime: s.belowAverageRegime,
    };
  });

  const clean = rows.filter((r) => !r.belowRegime);
  const dirty = rows.filter((r) => r.belowRegime);

  // --- 1. banda del índice, dentro del régimen limpio ---
  const bandsOf = (set) => {
    const out = {};
    for (const tier of ['coin', 'weak', 'strong']) {
      const sub = set.filter((r) => r.bandTier === tier && r.tfHit !== null);
      out[tier] = rateOf(sub.filter((r) => r.tfHit).length, sub.length);
    }
    return out;
  };
  const byBand = bandsOf(clean);
  const byBandDirty = bandsOf(dirty);
  const allTf = clean.filter((r) => r.tfHit !== null);
  const overall = rateOf(allTf.filter((r) => r.tfHit).length, allTf.length);
  const allRows = rows.filter((r) => r.tfHit !== null);
  const overallAll = rateOf(allRows.filter((r) => r.tfHit).length, allRows.length);

  // --- 2. escalado en partidas largas ---
  const withDur = rows.filter((r) => r.duration != null && r.scaleHit !== null);
  let longGames = null;
  let shortGames = null;
  if (withDur.length >= 6) {
    const sorted = [...withDur].sort((a, b) => a.duration - b.duration);
    const median = sorted[Math.floor(sorted.length / 2)].duration;
    const longs = withDur.filter((r) => r.duration >= median);
    const shorts = withDur.filter((r) => r.duration < median);
    longGames = { ...rateOf(longs.filter((r) => r.scaleHit).length, longs.length), median };
    shortGames = rateOf(shorts.filter((r) => r.scaleHit).length, shorts.length);
  }

  // --- 3. control de sanidad: winrate por lado ---
  const blueWins = maps.filter((m) => m.winner === 'blue').length;
  const side = rateOf(blueWins, maps.length);
  // En LoL profesional el lado azul suele quedar entre 50% y 58%. Muy afuera de
  // ahí significa que el resolutor de ganadores está sesgado, no que el meta lo esté.
  const sideSane = side ? side.low <= 0.62 && side.high >= 0.42 : null;

  return {
    usable: true,
    n: maps.length,
    nClean: clean.length,
    nDirty: dirty.length,
    tournament: index.tournamentSlug ?? null,
    enough: maps.length >= MIN_SAMPLE,
    overall,
    overallAll,
    byBand,
    byBandDirty,
    longGames,
    shortGames,
    side,
    sideSane,
    patches: [...new Set(rows.map((r) => r.patch).filter(Boolean))].sort(),
  };
}

/** Junta el corpus de varios torneos indexados para ganar muestra. */
export function validateAcross(indices) {
  const merged = { tournamentSlug: `${indices.length} torneos`, maps: [] };
  for (const i of indices) merged.maps.push(...(i.maps ?? []));
  const v = validateIndex(merged);
  if (v.usable) {
    v.sources = indices.map((i) => ({ slug: i.tournamentSlug, n: (i.maps ?? []).length }));
  }
  return v;
}

/**
 * Lectura en palabras del resultado, calibrada al número.
 *
 * La regla acá es la misma que en todo el proyecto: si el IC cruza el 50%, la
 * conclusión es "no distingue", no "tiende a". Después de una racha de aciertos
 * la tentación de inflar el lenguaje es máxima y por eso el texto lo genera el
 * código y no el que mira el resultado.
 */
export function readValidation(v) {
  if (!v.usable) return { verdict: 'sin corpus', text: v.reason };

  const strong = v.byBand.strong;
  if (!v.enough) {
    return {
      verdict: 'muestra insuficiente',
      text:
        `${v.n} mapas con draft y ganador. Por debajo de ${MIN_SAMPLE} no se reporta ninguna ` +
        `conclusión: con ese n, cualquier porcentaje tiene un intervalo que abarca casi todo. ` +
        `Indexá más ligas para juntar corpus.`,
    };
  }
  if (!strong || strong.n < 6) {
    return {
      verdict: 'sin casos de banda grande',
      text:
        `Hay ${v.n} mapas (${v.nClean} en régimen limpio), pero solo ${strong?.n ?? 0} caen en la ` +
        `banda grande (|Δ| > 1 sd), que es la única con respaldo declarado. El resto son drafts ` +
        `parejos, donde el propio método dice que no hay que usar el índice como señal.`,
    };
  }

  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const ci = `IC95 [${pct(strong.low)}, ${pct(strong.high)}]`;
  const base =
    `Banda grande, régimen limpio: acertó ${strong.hits} de ${strong.n} (${pct(strong.p)}), ${ci}.`;

  if (strong.straddles) {
    return {
      verdict: 'no reproduce',
      text:
        `${base} El intervalo cruza el 50%, así que en este corpus la regla no se distingue de ` +
        `tirar una moneda. No la refuta: el IC todavía se toca con el [57, 86] del backtest ` +
        `original, y los dos n son chicos. Pero esta muestra no la sostiene, y el sitio no va a ` +
        `decir que sí.`,
    };
  }
  return {
    verdict: strong.p >= 0.5 ? 'se sostiene' : 'apunta al lado contrario',
    text:
      `${base} No cruza el 50%. ` +
      (strong.p >= 0.5
        ? `Es consistente con el 74% declarado (IC [57, 86]) sobre una muestra que el backtest original no vio.`
        : `Va en la dirección OPUESTA a la declarada. Si se sostiene al crecer el n, la regla está ` +
          `mal orientada y no habría que usarla hasta revisarla.`),
  };
}
