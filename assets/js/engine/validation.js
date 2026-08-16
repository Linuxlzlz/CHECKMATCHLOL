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

import { scoreDraft, band, INDEX_AXES, RAW_NARRATABLE_MIN } from './index-score.js';
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

    // Diferencia en puntos CRUDOS por eje: es la unidad en la que está escrito el
    // umbral de narrabilidad, y la única en la que tiene sentido medirlo.
    const rawDelta = {};
    const axisHit = {};
    for (const ax of INDEX_AXES) {
      const d = s.sides[0].raw[ax] - s.sides[1].raw[ax];
      rawDelta[ax] = d;
      axisHit[ax] = d === 0 ? null : (d > 0) === blueWon;
    }

    return {
      gameId: m.gameId,
      tfDelta,
      scaleDelta,
      rawDelta,
      axisHit,
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
    // Los dos que responden preguntas que el método declaraba abiertas.
    narratability: axisNarratability(rows),
    siege: siegeConfounder(rows),
    patches: [...new Set(rows.map((r) => r.patch).filter(Boolean))].sort(),
  };
}

/* ------------------------------------------------------------------ *
 * ¿a partir de cuántos puntos crudos un eje dice algo?
 * ------------------------------------------------------------------ */

/**
 * El umbral de narrabilidad era una regla de dedo: por debajo de ~1 punto crudo
 * no se narra un eje, porque un punto en una suma de cinco campeones es un
 * campeón puntuado 2 en vez de 3. Salió de un fallo concreto (15/08) y sirvió,
 * pero era un número inventado y aplicado IGUAL a los cinco ejes, cuando los
 * cinco tienen dispersiones muy distintas.
 *
 * Con corpus se puede medir: para cada eje, agrupar los mapas por la magnitud de
 * la diferencia cruda y ver si el lado favorecido gana más seguido.
 *
 * Regla de uso, y es asimétrica a propósito:
 *
 *   - Si la medición dice que hace falta MÁS de 1 punto, se endurece el umbral.
 *   - Si dice que con menos ya alcanza, NO se afloja.
 *
 * Aflojar un umbral porque un corpus chico lo permite es exactamente el error
 * que este proyecto trata de no cometer: tomar cinco observaciones consistentes
 * y convertirlas en una regla. Endurecer con evidencia floja solo te vuelve más
 * conservador, que es un error barato; aflojar te hace afirmar de más.
 */
export function axisNarratability(rows) {
  const out = {};
  for (const axis of INDEX_AXES) {
    const buckets = [];
    // Los ejes viven en enteros chicos: 1, 2, 3, 4+ cubre casi todo el rango.
    for (const [lo, hi, label] of [[1, 1, '1'], [2, 2, '2'], [3, 3, '3'], [4, Infinity, '4+']]) {
      const sub = rows.filter((r) => {
        const d = Math.abs(r.rawDelta[axis]);
        return d >= lo && d <= hi;
      });
      if (!sub.length) { buckets.push({ label, n: 0 }); continue; }
      const hits = sub.filter((r) => r.axisHit[axis]).length;
      buckets.push({ label, lo, ...rateOf(hits, sub.length) });
    }

    // El umbral medido es el primer nivel a partir del cual el IC deja de cruzar
    // el 50% Y apunta al lado correcto. Si ninguno lo hace, no hay evidencia de
    // que el eje diga algo a ninguna magnitud.
    const firstClear = buckets.find((b) => b.n >= 8 && !b.straddles && b.p > 0.5);
    const measured = firstClear ? firstClear.lo : null;
    const zero = rows.filter((r) => Math.abs(r.rawDelta[axis]) === 0).length;

    // El umbral se compara con ESTRICTAMENTE MAYOR, así que para exigir `measured`
    // puntos hay que ponerlo medio punto por debajo. Y nunca por debajo del
    // congelado: la medición solo puede endurecer.
    const applied = measured != null ? Math.max(measured - 0.5, RAW_NARRATABLE_MIN) : null;

    out[axis] = {
      buckets,
      measured,
      applied,
      tightened: applied != null && applied > RAW_NARRATABLE_MIN,
      zero,
      n: rows.length,
      // "No hay evidencia" y "hay evidencia de que no" son cosas distintas, y la
      // diferencia la hace el n de los buckets grandes.
      wellPowered: buckets.some((b) => b.n >= 60),
      verdict: measured != null
        ? `A partir de ${measured} punto${measured === 1 ? '' : 's'} crudo${measured === 1 ? '' : 's'} el eje separa ganadores en este corpus.`
        : buckets.some((b) => b.n >= 60)
          ? 'A ninguna magnitud separa ganadores, y con estos n no es por falta de muestra: los intervalos son estrechos y siguen conteniendo el 50%.'
          : 'No separa ganadores a ninguna magnitud, pero los n son chicos: es falta de evidencia, no evidencia en contra.',
    };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * el confusor de asedio
 * ------------------------------------------------------------------ */

/**
 * La ambigüedad que el script declara y no resuelve: cuando hay poke en el mapa,
 * no está descartado que el índice esté midiendo "el asedio está flojo en este
 * parche" en vez de "el teamfight es mejor".
 *
 * Son dos hipótesis distintas y se pueden separar, porque las fórmulas no
 * comparten términos: teamfight = aoe + 0.5·fl + 0.5·eng, asedio = poke. Lo que
 * las confunde no es la fórmula sino las comps: las que tienen mucho poke suelen
 * tener poco aoe/fl/eng, así que los dos ejes tienden a apuntar al mismo lado.
 *
 * Entonces lo que discrimina son los mapas donde DISCREPAN. Si el teamfight
 * sigue acertando cuando el asedio apunta al rival, la señal es del teamfight.
 * Si se cae o se invierte ahí, la señal era del asedio todo el tiempo.
 *
 * Es el mismo principio que el Paso 10 aplicado a ejes en vez de a capas: el
 * acuerdo es redundancia, solo el desacuerdo informa.
 */
export function siegeConfounder(rows) {
  // Solo mapas donde los dos ejes se pronuncian y el teamfight es una señal real.
  const usable = rows.filter(
    (r) => r.rawDelta.teamfight !== 0 && r.rawDelta.siege !== 0 && Math.abs(r.tfDelta) >= 0.5
  );
  const agree = usable.filter(
    (r) => Math.sign(r.rawDelta.teamfight) === Math.sign(r.rawDelta.siege)
  );
  const disagree = usable.filter(
    (r) => Math.sign(r.rawDelta.teamfight) !== Math.sign(r.rawDelta.siege)
  );

  const tfRate = (set) => rateOf(set.filter((r) => r.axisHit.teamfight).length, set.length);
  const siegeRate = (set) => rateOf(set.filter((r) => r.axisHit.siege).length, set.length);

  const dis = tfRate(disagree);
  const agr = tfRate(agree);

  // Correlación de Pearson entre las dos diferencias, para mostrar cuánto se
  // superponen de entrada. Si fuera ~0 no habría confusor que resolver.
  const xs = rows.map((r) => r.rawDelta.teamfight);
  const ys = rows.map((r) => r.rawDelta.siege);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  const corr = dx && dy ? num / Math.sqrt(dx * dy) : null;

  const pctOf = (x) => `${(x * 100).toFixed(0)}%`;
  const ciOf = (o) => `IC95 [${pctOf(o.low)}, ${pctOf(o.high)}]`;

  let verdict;
  let resolved = false;

  if (!dis || dis.n < 10) {
    verdict =
      `Solo ${dis?.n ?? 0} mapas del corpus tienen los dos ejes apuntando a lados distintos, que ` +
      `son los únicos que discriminan. Con ese n no se puede separar una hipótesis de la otra: ` +
      `la ambigüedad sigue declarada y sin resolver.`;
  } else if (agr && dis.straddles && agr.straddles) {
    // El caso que más importa y que la formulación original no contemplaba: no
    // hay señal en ninguno de los dos conjuntos. Entonces no hay nada que
    // atribuirle ni al teamfight ni al asedio.
    resolved = true;
    verdict =
      `El teamfight acierta ${pctOf(agr.p)} cuando el asedio lo acompaña (n=${agr.n}, ${ciOf(agr)}) y ` +
      `${pctOf(dis.p)} cuando lo contradice (n=${dis.n}, ${ciOf(dis)}). Los dos intervalos cruzan el ` +
      `50%. La ambigüedad se disuelve, pero no como se esperaba: no es que la señal fuera del asedio ` +
      `en vez del teamfight, es que en este corpus no hay señal que atribuirle a ninguno de los dos. ` +
      `La pregunta "¿cuál de los dos mide?" presupone que alguno mide, y eso es lo que no se sostiene.`;
  } else if (dis.straddles) {
    verdict =
      `Cuando los dos ejes discrepan (n=${dis.n}), el de teamfight acierta ${pctOf(dis.p)}, ${ciOf(dis)}, ` +
      `y cuando coinciden acierta ${pctOf(agr.p)} (n=${agr.n}). El intervalo del desacuerdo cruza el ` +
      `50%: sin el asedio de su lado, el teamfight pierde la señal que tenía. Eso NO prueba que la ` +
      `señal sea del asedio, pero es lo que se esperaría si lo fuera.`;
  } else if (dis.p > 0.5) {
    resolved = true;
    verdict =
      `Cuando los dos ejes discrepan (n=${dis.n}), el de teamfight acierta ${pctOf(dis.p)}, ${ciOf(dis)}, ` +
      `sin cruzar el 50%. La señal se sostiene con el asedio en contra: la ambigüedad se resuelve a ` +
      `favor del teamfight en este corpus.`;
  } else {
    resolved = true;
    verdict =
      `Cuando los dos ejes discrepan (n=${dis.n}), el de teamfight acierta ${pctOf(dis.p)}, ${ciOf(dis)}: ` +
      `gana el lado con más asedio, no el de más teamfight. En este corpus la ambigüedad se resuelve ` +
      `en contra del índice, y eso es motivo para revisar la fórmula antes que para seguir usándola.`;
  }

  // La premisa del confusor era que los dos ejes se superponen. Si la correlación
  // es casi nula, esa premisa tampoco se sostiene y conviene decirlo.
  if (corr != null && Math.abs(corr) < 0.15) {
    verdict +=
      ` Aparte, la correlación entre las dos diferencias es ${corr.toFixed(2)}: los ejes son casi ` +
      `independientes en este corpus, así que la premisa del confusor — que las comps de poke ` +
      `tienen poco daño de área e inicio — tampoco se verifica acá.`;
  }

  return {
    n: usable.length,
    corr,
    agree: { n: agree.length, tf: agr, siege: siegeRate(agree) },
    disagree: { n: disagree.length, tf: dis, siege: siegeRate(disagree) },
    resolved,
    verdict,
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
    // El 74% declarado tiene IC [57, 86]. Si el intervalo medido lo excluye, esto
    // dejó de ser "no alcanza la muestra" y pasó a ser un resultado en contra.
    const excludesClaim = strong.high < 0.74;
    const touchesClaim = strong.high >= 0.57;
    return {
      verdict: excludesClaim ? 'contradice lo declarado' : 'no reproduce',
      text:
        `${base} El intervalo cruza el 50%, así que en este corpus la regla no se distingue de ` +
        `tirar una moneda. ` +
        (excludesClaim
          ? `Y con este n el 74% declarado queda FUERA del intervalo medido` +
            (touchesClaim
              ? `, aunque los dos intervalos todavía se rozan por abajo.`
              : `, sin siquiera rozarse con el [57, 86] original.`) +
            ` Esto ya no es falta de muestra: es un resultado que contradice la cifra que el ` +
            `método viene citando. Antes de tirar la regla conviene mirar de dónde viene la ` +
            `diferencia — otro corpus, otra liga, otro parche y otro método de selección — pero ` +
            `usarla como si valiera 74% no está justificado con esto sobre la mesa.`
          : `No la refuta: el IC todavía se toca con el [57, 86] del backtest original y los n son ` +
            `chicos. Pero esta muestra no la sostiene, y el sitio no va a decir que sí.`),
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
