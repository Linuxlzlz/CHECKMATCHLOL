/**
 * structural.js — Pasos 2, 3 y 7 del skill.
 *
 * Regla de diseño: todo lo que se afirma acá sale de la tabla congelada de 7
 * ejes. Los ejes del Paso 2 que la tabla NO puede sostener (desenganche, peel,
 * waveclear, velocidad de objetivo) se declaran como no computables y quedan
 * para lectura humana, en vez de recibir un número inventado.
 *
 * "Si un dato no está, que falte ruidosamente."
 */

import { rawScores, RAW_NARRATABLE_MIN, isNarratable, profileRow } from './index-score.js';

const ROLE_ORDER = ['top', 'jungle', 'mid', 'bottom', 'support'];
export const ROLE_LABEL = {
  top: 'Top',
  jungle: 'Jungla',
  mid: 'Mid',
  bottom: 'ADC',
  support: 'Support',
};

/**
 * Perfil por campeón, para mirar campeón a campeón y no solo la suma.
 * Sale del mismo resolutor que el índice (manual → extensión → congelada), así
 * que los ejes estructurales y el índice nunca ven tablas distintas.
 */
export const profileOf = (champion) => profileRow(champion);

/** Clasificaciones derivadas de la tabla, sin agregar juicio nuevo. */
const isHardFrontline = (p) => p && p.fl >= 3;
const isHardEngage = (p) => p && p.eng >= 3;
const isPickThreat = (p) => p && p.pick >= 3;
const isAssassin = (p) => p && p.pick >= 3 && p.fl === 0;
const isSoftBody = (p) => p && p.fl === 0;
const isSplitThreat = (p) => p && p.split >= 3;
const isTankEngage = (p) => p && p.fl >= 3 && p.eng >= 3;

/**
 * Paso 2 — ejes de counter estructural.
 * Cada eje devuelve quién gana, con qué margen y en qué unidad.
 */
export function structuralAxes(sideA, sideB) {
  const prof = (s) => s.players.map((p) => ({ ...p, profile: profileOf(p.champion) }));
  const A = prof(sideA);
  const B = prof(sideB);
  const rawA = rawScores(sideA.players.map((p) => p.champion));
  const rawB = rawScores(sideB.players.map((p) => p.champion));

  const count = (arr, fn) => arr.filter((p) => fn(p.profile)).length;
  const carriers = (arr, fn) => arr.filter((p) => fn(p.profile));

  const axes = [];

  // 1. Conteo de frontline. Cero contra uno o más es asimetría estructural.
  const flA = count(A, isHardFrontline);
  const flB = count(B, isHardFrontline);
  axes.push({
    id: 'frontline',
    label: 'Conteo de frontline',
    a: flA,
    b: flB,
    unit: 'tanques duros',
    favors: flA === flB ? null : flA > flB ? sideA.team : sideB.team,
    structural: (flA === 0) !== (flB === 0),
    note:
      (flA === 0) !== (flB === 0)
        ? 'Cero tanques contra uno o más: asimetría estructural, no una diferencia de grado.'
        : null,
    carriers: [...carriers(A, isHardFrontline), ...carriers(B, isHardFrontline)].map(
      (p) => p.champion
    ),
  });

  // 2. Inicio duro. Sin eje de desenganche en la tabla, solo se reporta el conteo:
  //    la advertencia de que iniciar contra contra-inicio es un pasivo queda como
  //    lectura humana, porque la tabla no distingue desenganche.
  const engA = count(A, isHardEngage);
  const engB = count(B, isHardEngage);
  axes.push({
    id: 'engage',
    label: 'Inicio duro',
    a: engA,
    b: engB,
    unit: 'iniciadores',
    favors: engA === engB ? null : engA > engB ? sideA.team : sideB.team,
    note:
      engA === 0 || engB === 0
        ? 'Un lado no tiene inicio duro: el pulso alrededor de objetivos lo define quién puede forzar.'
        : null,
  });

  // 3. Acceso a línea trasera: asesinos contra cuerpos blandos rivales.
  //    "Un asesino contra cinco cuerpos blandos no tiene que elegir bien su objetivo."
  const asnA = count(A, isAssassin);
  const asnB = count(B, isAssassin);
  const softA = count(A, isSoftBody);
  const softB = count(B, isSoftBody);
  axes.push({
    id: 'backline',
    label: 'Acceso a línea trasera',
    a: asnA,
    b: asnB,
    unit: 'amenazas de pick sin frontline',
    detail: `${sideA.team} tiene ${asnA} contra ${softB} cuerpos blandos de ${sideB.team} · ` +
      `${sideB.team} tiene ${asnB} contra ${softA} de ${sideA.team}`,
    favors: asnA * softB === asnB * softA ? null : asnA * softB > asnB * softA ? sideA.team : sideB.team,
    note:
      Math.max(softA, softB) >= 4 && Math.max(asnA, asnB) > 0
        ? 'Cuatro o más cuerpos blandos de un lado: el asesino no tiene que elegir bien su objetivo.'
        : null,
  });

  // 4. Asedio contra inicio de área. Relación estable del Paso 3, computable.
  const tankEngA = count(A, isTankEngage);
  const tankEngB = count(B, isTankEngage);
  axes.push({
    id: 'siege-vs-engage',
    label: 'Asedio contra inicio de área',
    a: rawA.scores.siege,
    b: rawB.scores.siege,
    unit: 'puntos de poke',
    detail: `Inicio de área que lo countera: ${sideA.team} ${tankEngA} · ${sideB.team} ${tankEngB}`,
    favors:
      rawA.scores.siege === rawB.scores.siege
        ? null
        : rawA.scores.siege > rawB.scores.siege
          ? sideA.team
          : sideB.team,
    note:
      rawA.scores.siege >= 4 && tankEngB >= 1
        ? `El poke de ${sideA.team} choca contra ${tankEngB} inicio(s) de área de ${sideB.team}.`
        : rawB.scores.siege >= 4 && tankEngA >= 1
          ? `El poke de ${sideB.team} choca contra ${tankEngA} inicio(s) de área de ${sideA.team}.`
          : null,
  });

  // 5. Amenaza de split.
  const splA = count(A, isSplitThreat);
  const splB = count(B, isSplitThreat);
  axes.push({
    id: 'split',
    label: 'Amenaza de split',
    a: splA,
    b: splB,
    unit: 'splitters',
    favors: splA === splB ? null : splA > splB ? sideA.team : sideB.team,
  });

  // 6. Curvas de poder: de acá sale la ventana del Paso 7.
  axes.push({
    id: 'scaling',
    label: 'Curva de poder',
    a: rawA.scores.scaling,
    b: rawB.scores.scaling,
    unit: 'puntos de escalado',
    favors:
      rawA.scores.scaling === rawB.scores.scaling
        ? null
        : rawA.scores.scaling > rawB.scores.scaling
          ? sideA.team
          : sideB.team,
    narratable: isNarratable(rawA.scores.scaling - rawB.scores.scaling),
  });

  // 7. Coherencia interna de tempo: ¿los cinco quieren ganar en el mismo minuto?
  const spread = (arr) => {
    const xs = arr.map((p) => p.profile?.scale).filter((x) => x !== undefined && x !== null);
    return xs.length ? Math.max(...xs) - Math.min(...xs) : null;
  };
  const spA = spread(A);
  const spB = spread(B);
  axes.push({
    id: 'tempo',
    label: 'Coherencia interna de tempo',
    a: spA,
    b: spB,
    unit: 'dispersión de escalado (menor = más coherente)',
    favors: spA === spB ? null : spA < spB ? sideA.team : sideB.team,
    note:
      Math.max(spA ?? 0, spB ?? 0) >= 3
        ? 'Un lado mezcla campeones de línea temprana con escalado extremo: dos relojes en la misma comp.'
        : null,
  });

  return axes;
}

/**
 * Ejes del Paso 2 que la tabla congelada NO puede sostener. Se listan para que
 * la ausencia sea visible y el analista los mire a mano, en vez de que el
 * sitio simule haberlos evaluado.
 */
/**
 * Ejes del Paso 2 que la tabla congelada NO puede sostener.
 *
 * Dejaron de ser una lista fija de imposibles: la segunda fuente (los ejes que
 * Riot publica por campeón, ver engine/riot-profile.js) cubre tres de los cinco,
 * dos por proxy y uno como hecho. El `status` dice en qué estado está cada uno,
 * porque "no computable" y "computable por proxy" no son lo mismo y meterlos en
 * la misma bolsa era esconder el progreso tanto como esconder el hueco.
 *
 *   sin-fuente — no hay dato en ninguna fuente accesible. Lectura humana.
 *   proxy      — se mide algo parecido, con una fuente de primera mano.
 *   resuelto   — se cuenta un hecho que no admite discusión.
 */
export const NON_COMPUTABLE_AXES = [
  ['Desenganche', 'La tabla tiene "eng" (inicio) pero no desenganche. Se aproxima con el CC y la movilidad que publica Riot: sirve para saber si hay herramientas, no si alcanzan.', 'proxy'],
  ['Peel', 'La tabla no distingue CC duro de escudos. El eje de control de masas de Riot mide cuánto CC tiene el kit, no si se usa para proteger al carry.', 'proxy'],
  ['Waveclear', 'No está en ninguna fuente accesible. Sin waveclear no hay remontada, y el sitio sigue sin verlo.', 'sin-fuente'],
  ['Velocidad de objetivo', 'No está en ninguna fuente accesible. Define quién puede tomar el trade.', 'sin-fuente'],
  ['Neutral a rango', 'Resuelto: cuerpo a cuerpo contra distancia sale del dato de Riot y es un conteo, no un juicio.', 'resuelto'],
];

/** Paso 3 — matchups directos, campeón contra campeón por posición. */
export function laneMatchups(sideA, sideB) {
  const byRole = (side) => {
    const m = {};
    for (const p of side.players) m[p.role] = p;
    return m;
  };
  const ra = byRole(sideA);
  const rb = byRole(sideB);

  return ROLE_ORDER.filter((r) => ra[r] || rb[r]).map((role) => {
    const pa = ra[role];
    const pb = rb[role];
    const fa = profileOf(pa?.champion);
    const fb = profileOf(pb?.champion);
    return {
      role,
      label: ROLE_LABEL[role] ?? role,
      a: pa ? { ...pa, profile: fa } : null,
      b: pb ? { ...pb, profile: fb } : null,
      // Diferencia de perfil, NO de poder: dice qué tan distinto es el matchup,
      // no quién gana. La dirección se lee en los ejes estructurales.
      divergence:
        fa && fb
          ? ['fl', 'aoe', 'eng', 'pick', 'poke', 'split', 'scale'].reduce(
              (acc, k) => acc + Math.abs(fa[k] - fb[k]),
              0
            )
          : null,
    };
  });
}

/** Checklist del Paso 3. Son relaciones estables entre parches, para leer a mano. */
export const MATCHUP_CHECKLIST = [
  'ADC con escape confiable resiste comps de pick.',
  'ADC de rango largo sin movilidad gana línea y pierde contra dive.',
  'Tanque con inicio de área countera líneas de asedio.',
  'Asesino escala con la cantidad de objetivos blandos rivales, no con su propio ítem.',
  'Mago de control con desplazamiento de área encadena con cualquier inicio aliado.',
  'Ulti global vale por el timing, que es lo más difícil de improvisar.',
  'Campeones que roban resistencias counterean al único tanque del mapa.',
  '¿El que gana la línea puede convertir? Kills sin ventaja de oro ni de nivel = pico gastado.',
  '¿Quién es el objetivo natural del jungla? El más inmóvil y el que empuja sin visión.',
];

/**
 * Paso 7 — concentración y ventana.
 *
 * No cuenta cuántas líneas gana cada equipo. Busca dónde se concentra el margen
 * estructural y nombra la posición que lo carga.
 */
export function concentrationAndWindow(sideA, sideB, axes) {
  const edges = [];

  const push = (magnitude, side, label, carrier) => {
    if (magnitude > 0) edges.push({ magnitude, side, label, carrier });
  };

  const fl = axes.find((x) => x.id === 'frontline');
  if (fl.structural) {
    const side = fl.a > fl.b ? sideA : sideB;
    const carrier = side.players.find((p) => isHardFrontline(profileOf(p.champion)));
    push(3, side.team, 'Asimetría de frontline: un lado no tiene tanque', carrier);
  }

  const back = axes.find((x) => x.id === 'backline');
  if (back.favors) {
    const side = back.favors === sideA.team ? sideA : sideB;
    const opp = back.favors === sideA.team ? sideB : sideA;
    const softOpp = opp.players.filter((p) => isSoftBody(profileOf(p.champion))).length;
    const carrier = side.players.find((p) => isAssassin(profileOf(p.champion)));
    if (carrier && softOpp >= 3) {
      push(softOpp - 1, side.team, `Acceso a línea trasera contra ${softOpp} cuerpos blandos`, carrier);
    }
  }

  const siege = axes.find((x) => x.id === 'siege-vs-engage');
  if (Math.abs(siege.a - siege.b) >= 2) {
    const side = siege.a > siege.b ? sideA : sideB;
    const carrier = side.players
      .map((p) => ({ p, prof: profileOf(p.champion) }))
      .sort((x, y) => (y.prof?.poke ?? 0) - (x.prof?.poke ?? 0))[0]?.p;
    push(Math.abs(siege.a - siege.b), side.team, 'Ventaja de asedio/poke', carrier);
  }

  const split = axes.find((x) => x.id === 'split');
  if (Math.abs(split.a - split.b) >= 1) {
    const side = split.a > split.b ? sideA : sideB;
    const carrier = side.players.find((p) => isSplitThreat(profileOf(p.champion)));
    push(Math.abs(split.a - split.b) + 0.5, side.team, 'Amenaza de split lateral', carrier);
  }

  edges.sort((x, y) => y.magnitude - x.magnitude);

  // Ventana. Solo se declara si la brecha de escalado es narrable en puntos crudos.
  const scaling = axes.find((x) => x.id === 'scaling');
  const dScale = scaling.a - scaling.b;
  let window;
  if (!isNarratable(dScale)) {
    const n = Math.abs(dScale);
    window = {
      declared: false,
      reason:
        `La brecha de escalado es de ${n.toFixed(0)} ${n === 1 ? 'punto crudo' : 'puntos crudos'}, ` +
        `y el umbral para narrar un eje es más de ${RAW_NARRATABLE_MIN}. No hay ventana declarable: ` +
        `sobre exactamente 1 punto ya se construyó una narrativa de "ventana con fecha de ` +
        `vencimiento" el 15/08 y perdió. Un punto en una suma de cinco campeones es un campeón ` +
        `puntuado 2 en vez de 3 por juicio propio.`,
    };
  } else {
    const late = dScale > 0 ? sideA : sideB;
    const early = dScale > 0 ? sideB : sideA;
    // Cuanto mayor la brecha, antes vence la ventana del lado de tempo corto.
    const mag = Math.abs(dScale);
    const from = mag >= 4 ? 22 : mag >= 2 ? 25 : 28;
    const to = from + 6;
    window = {
      declared: true,
      lateSide: late.team,
      earlySide: early.team,
      gapRaw: mag,
      from,
      to,
      claims: [
        `${early.team} necesita convertir en objetivos o torres antes del minuto ${from}.`,
        `Si se llega al minuto ${to} en empate de oro, la partida favorece a ${late.team}.`,
      ],
    };
  }

  return { edges: edges.slice(0, 3), window };
}
