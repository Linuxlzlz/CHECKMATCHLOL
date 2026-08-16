/**
 * diagnostics.js — qué quedó sin diagnosticar y por qué.
 *
 * El sitio se niega a afirmar cosas que no puede sostener: campeones fuera de la
 * tabla, capas sin índice, ejes que la tabla no cubre, winrates con IC que cruza
 * el 50%. Eso está bien, pero repartido en ocho tarjetas se vuelve invisible, y
 * un hueco invisible se lee como "acá no hay nada que ver".
 *
 * Esto lo junta en un solo lugar, con tres niveles:
 *
 *   bloqueante — la lectura está incompleta y se puede arreglar ahora
 *   parcial    — hay dato pero no alcanza para afirmar
 *   declarado  — límite conocido del método, no se arregla con más datos
 *
 * Cada ítem dice qué falta, por qué importa y, cuando existe, qué botón lo
 * resuelve. La idea es que ningún hueco quede sin nombre.
 */

import { classificationOf } from './index-score.js';
import { NON_COMPUTABLE_AXES } from './structural.js';

const uniq = (xs) => [...new Set(xs)];

/**
 * @param {object} ctx
 * @param {object} ctx.score        salida de scoreDraft
 * @param {object[]} ctx.champions  [{champion, team}]
 * @param {object|null} ctx.metaIndex
 * @param {object[]|null} ctx.champLayers  filas de championLayer de los dos lados
 * @param {object[]|null} ctx.playerLayers filas de playerLayer de los dos lados
 * @param {object} ctx.prob         salida de buildProbability
 * @param {object} ctx.window       salida de concentrationAndWindow().window
 * @param {object|null} ctx.patchDiff
 * @param {object|null} ctx.entry   entrada del registro
 * @param {object|null} ctx.outcome resolución de la serie
 */
export function collectDiagnostics(ctx) {
  const out = [];
  const add = (severity, id, title, detail, action = null) =>
    out.push({ severity, id, title, detail, action });

  /* --- campeones fuera de la tabla --------------------------------- */
  const unclassified = uniq(
    (ctx.champions ?? []).filter((c) => classificationOf(c.champion) === null).map((c) => c.champion)
  );
  if (unclassified.length) {
    add(
      'bloqueante',
      'campeones-sin-clasificar',
      `${unclassified.length} campeón${unclassified.length === 1 ? '' : 'es'} sin clasificar: ${unclassified.join(', ')}`,
      'No están en la tabla de arquetipos, así que suman cero en los cinco ejes y deprimen el ' +
        'índice de su lado. Ese lado hay que leerlo como incertidumbre, no como debilidad. ' +
        'Puntuarlos a mano lo resuelve y la clasificación queda guardada en este navegador.',
      { id: 'abrir-editor', label: 'Puntuar a mano' }
    );
  }

  const manual = uniq(
    (ctx.champions ?? []).filter((c) => classificationOf(c.champion) === 'manual').map((c) => c.champion)
  );
  if (manual.length) {
    add(
      'declarado',
      'campeones-manuales',
      `Clasificación manual en juego: ${manual.join(', ')}`,
      'Estos campeones usan puntajes que cargaste vos, no la tabla congelada ni la extensión. ' +
        'El índice de ese lado depende de ese juicio; si el resultado sorprende, revisá primero acá.',
      { id: 'abrir-editor', label: 'Revisar puntajes' }
    );
  }

  const extended = uniq(
    (ctx.champions ?? []).filter((c) => classificationOf(c.champion) === 'extension').map((c) => c.champion)
  );
  if (extended.length) {
    add(
      'declarado',
      'campeones-extension',
      `Clasificados por extensión: ${extended.join(', ')}`,
      'No están en la tabla congelada del backtest: sus puntajes se agregaron después, con el ' +
        'mismo criterio y antes de ver resultados, para que no contaran cero. La escala de ' +
        'referencia no los usa, así que las bandas de 0.5 y 1 sd siguen significando lo mismo.',
      { id: 'abrir-editor', label: 'Ver o corregir' }
    );
  }

  /* --- capas de campeón y jugador ---------------------------------- */
  if (!ctx.metaIndex && ctx.metaBuilding) {
    // "Ausente" y "todavía no llegó" no son lo mismo, y el botón de indexar no
    // hace nada mientras hay una construcción en curso: era un botón muerto.
    const p = ctx.metaProgress;
    add(
      'parcial',
      'indice-en-curso',
      'Las capas de campeón y de jugador se están construyendo',
      (p?.label ? `${p.label} ${p.done ?? 0}${p.total ? ` de ${p.total}` : ''}. ` : '') +
        'El informe se rearma solo cuando termine. Hasta entonces el veredicto de arriba está ' +
        'construido sin los pasos 4 y 5.'
    );
  } else if (!ctx.metaIndex) {
    add(
      'bloqueante',
      'sin-indice',
      'Las capas de campeón y de jugador están ausentes',
      'Sin el índice del torneo no hay winrate de campeón ni partidas por jugador, y los pasos 4 ' +
        'y 5 del método quedan afuera del análisis. Ausente no es cero: el veredicto de arriba ' +
        'se construyó sin ellas.',
      { id: 'indexar', label: 'Indexar torneo' }
    );
  } else {
    const rows = [...(ctx.champLayers ?? [])];
    const noData = rows.filter((c) => c.status === 'sin-datos');
    const thin = rows.filter((c) => c.status === 'excluido');
    const straddle = rows.filter((c) => c.admits && c.straddles);

    if (noData.length) {
      add(
        'parcial',
        'campeones-sin-picks',
        `Sin picks en el torneo: ${uniq(noData.map((c) => c.champion)).join(', ')}`,
        'Cero picks es SIN DATOS, no "pick sorpresa". Ni vos ni el equipo rival pueden estimar ' +
          'cómo rinde acá.' +
          (noData.some((c) => c.fallback)
            ? ' Algunos sí tienen muestra en otros torneos ya indexados: eso aparece como respaldo, etiquetado.'
            : ' Indexar otra liga puede darles muestra.'),
        { id: 'indexar-mas', label: 'Indexar otra liga' }
      );
    }
    if (thin.length) {
      add(
        'parcial',
        'campeones-pocos-picks',
        `Con muestra insuficiente: ${thin.map((c) => `${c.champion} (${c.picks})`).join(', ')}`,
        'Por debajo de 10 picks el winrate es ruido y el filtro del método lo excluye. Se muestran ' +
          'los picks porque son dato limpio; lo que no entra es el winrate.',
        { id: 'indexar-mas', label: 'Indexar otra liga' }
      );
    }
    if (straddle.length) {
      add(
        'parcial',
        'ic-cruza-50',
        `Winrate no distinguible de una moneda: ${straddle.map((c) => c.champion).join(', ')}`,
        'Tienen muestra suficiente, pero el IC95 cruza el 50%. Un 40% sobre 15 partidas no predice ' +
          'nada, y tratarlo como señal es el error que este filtro existe para evitar.'
      );
    }

    const noPlayer = (ctx.playerLayers ?? []).filter((p) => p.status === 'sin-datos');
    if (noPlayer.length) {
      add(
        'parcial',
        'jugadores-sin-registro',
        `Sin partidas en el índice: ${noPlayer.map((p) => p.name).join(', ')}`,
        'Puede ser un debut, un suplente o alguien que venía del split anterior. El índice de este ' +
          'torneo no los distingue, así que su cero no se puede leer en ninguna dirección.'
      );
    }

    if (ctx.metaIndex.failures?.any) {
      const f = ctx.metaIndex.failures;
      add(
        'parcial',
        'indice-incompleto',
        `El índice se leyó incompleto: ${ctx.metaIndex.gamesCounted} de ${ctx.metaIndex.gamesTotal} mapas`,
        [
          f.games ? `${f.games} mapas fallaron al descargar.` : '',
          f.emptyDrafts ? `${f.emptyDrafts} volvieron sin draft.` : '',
          f.matches ? `${f.matches} series no se pudieron leer.` : '',
          'Los n de abajo son menores de lo que deberían y eso ensancha todos los intervalos.',
        ].filter(Boolean).join(' '),
        { id: 'reindexar', label: 'Reindexar' }
      );
    }

    const unattributed = (ctx.metaIndex.gamesCounted ?? 0) - (ctx.metaIndex.gamesAttributable ?? 0);
    if (unattributed > 0) {
      add(
        'declarado',
        'mapas-sin-resultado',
        `${unattributed} mapas cuentan como pick pero no como resultado`,
        'La API no expone el ganador de cada mapa. El sitio lo resuelve leyendo el estado final y ' +
          'verificándolo contra el marcador de la serie; cuando una serie no verifica, sus mapas ' +
          'ambiguos quedan sin atribuir en vez de forzarlos. Los picks sí se cuentan.'
      );
    }
  }

  /* --- probabilidad y postura -------------------------------------- */
  if (ctx.prob && !ctx.prob.hasQuality) {
    add(
      'bloqueante',
      'sin-calidad',
      'Falta el componente de calidad de equipos',
      'Es el que suele explicar casi todo el margen. Sin standings del torneo, el número de la ' +
        'lectura queda apoyado casi solo en el draft, que aporta poco a propósito. Vale mucho ' +
        'menos de lo que aparenta.'
    );
  }

  if (!(ctx.entry?.market?.length)) {
    add(
      'declarado',
      'sin-precio',
      'Sin precio de mercado cargado',
      'La métrica oficial es CLV, no aciertos, y sin precio no hay con qué comparar: la postura ' +
        'NO BET no se puede evaluar, solo sostener por defecto.',
      { id: 'cargar-precio', label: 'Cargar cuota' }
    );
  }

  /* --- parche ------------------------------------------------------- */
  if (!ctx.patchDiff && ctx.patchDiffBusy) {
    add(
      'parcial',
      'parche-en-curso',
      'Comparando el parche con el anterior',
      'Se están bajando las fichas de los diez campeones en las dos versiones de Data Dragon.'
    );
  } else if (!ctx.patchDiff) {
    add(
      'parcial',
      'parche-sin-comparar',
      'No se comparó el parche con el anterior',
      'Sin la comparación, el sitio reporta la versión y no puede decir si alguno de los diez ' +
        'campeones cambió. "No sé" y "no cambió" no son lo mismo.',
      { id: 'comparar-parche', label: 'Comparar parche' }
    );
  }

  /* --- segunda fuente ----------------------------------------------- */
  if (ctx.riot && !ctx.riot.available) {
    add(
      'parcial',
      'sin-segunda-fuente',
      'La segunda fuente de campeones no cargó',
      'Sin los datos que Riot publica por campeón (Community Dragon), vuelven a quedar sin medir ' +
        'el neutral a rango, el peel, el desenganche y la mezcla de daño, y la tabla propia se ' +
        'queda otra vez sin nada contra qué contrastarse.'
    );
  } else if (ctx.riot?.cross?.disagreements?.length) {
    const d = ctx.riot.cross.disagreements;
    add(
      'parcial',
      'discrepancia-fuentes',
      `Las dos fuentes discrepan en ${d.length} campeón${d.length === 1 ? '' : 'es'}: ${d.map((r) => r.champion).join(', ')}`,
      'El eje de frontline de la tabla propia y el de durabilidad de Riot se llevan 2 o más puntos. ' +
        'O la tabla tiene un error, o el campeón cambió de rol desde que se escribió. Mientras no ' +
        'se resuelva, los ejes estructurales de esos campeones son la parte más floja del análisis.',
      { id: 'abrir-editor', label: 'Revisar la tabla' }
    );
  }

  /* --- validación del propio método --------------------------------- */
  if (ctx.validation?.usable && ctx.validation.enough) {
    const v = ctx.validation;
    if (v.sideSane === false) {
      add(
        'bloqueante',
        'resolutor-sesgado',
        'El winrate por lado del corpus está fuera de lo esperable',
        `El lado azul aparece con ${(v.side.p * 100).toFixed(0)}% en ${v.side.n} mapas. En LoL ` +
          'profesional debería estar cerca del 50-58%. Un valor tan corrido apunta a que el ganador ' +
          'inferido de cada mapa tiene un sesgo por lado, y si es así el winrate de campeón y la ' +
          'validación del índice quedan los dos en duda.',
        { id: 'reindexar', label: 'Reindexar' }
      );
    }
    const strong = v.byBand?.strong;
    // Con muestra suficiente para excluir el 74%, el componente de draft de la
    // probabilidad se apoya en una regla que el propio corpus no sostiene.
    if (strong?.n >= 60 && strong.straddles && strong.high < 0.74) {
      add(
        'parcial',
        'indice-no-reproduce',
        `El índice no reproduce el 74% declarado: ${(strong.p * 100).toFixed(0)}% en ${strong.n} mapas`,
        `IC95 [${(strong.low * 100).toFixed(0)}, ${(strong.high * 100).toFixed(0)}], que excluye el ` +
          '74% y contiene el 50%. Con este n ya no es falta de muestra. El componente de draft de la ' +
          'probabilidad de arriba se apoya en esa regla, así que hay que leerlo como la parte más ' +
          'floja del número — y la postura NO BET, como la más justificada.'
      );
    }
    if (strong?.n >= 6 && !strong.straddles && strong.p < 0.5) {
      add(
        'bloqueante',
        'indice-invertido',
        'En este corpus el índice apunta al lado contrario',
        `La banda grande acertó ${strong.hits} de ${strong.n} (${(strong.p * 100).toFixed(0)}%), con ` +
          'el IC sin cruzar el 50%. Si esto se sostiene al crecer la muestra, la regla está mal ' +
          'orientada y no habría que usarla hasta revisarla.'
      );
    }
  } else if (ctx.metaIndex && ctx.validation?.usable && !ctx.validation.enough) {
    add(
      'parcial',
      'validacion-sin-muestra',
      `El corpus tiene ${ctx.validation.n} mapas: no alcanza para validar el índice`,
      'El 74% de la banda grande sigue siendo una cita del backtest original, sin poder ' +
        'reproducirse acá. Indexar más ligas junta corpus y lo vuelve testeable.',
      { id: 'indexar-mas', label: 'Indexar otra liga' }
    );
  }

  /* --- ventana ------------------------------------------------------ */
  if (ctx.window && !ctx.window.declared) {
    add(
      'declarado',
      'sin-ventana',
      'No hay ventana declarable',
      'La brecha de escalado no supera el umbral de narrabilidad en puntos crudos. Declararla ' +
        'igual sería repetir el error del 15/08: una narrativa entera de "ventana con fecha de ' +
        'vencimiento" sobre exactamente 1 punto.'
    );
  }

  /* --- límites del método ------------------------------------------- */
  const sinFuente = NON_COMPUTABLE_AXES.filter(([, , s]) => s === 'sin-fuente');
  const porProxy = NON_COMPUTABLE_AXES.filter(([, , s]) => s === 'proxy');
  const resueltos = NON_COMPUTABLE_AXES.filter(([, , s]) => s === 'resuelto');
  add(
    'declarado',
    'ejes-no-computables',
    `${sinFuente.length} ejes del Paso 2 siguen sin ninguna fuente`,
    `${sinFuente.map(([n]) => n).join(' · ')}. No hay dato accesible: quedan para lectura humana y ` +
      `el sitio no les inventa un número. ` +
      (porProxy.length || resueltos.length
        ? `De los otros: ${resueltos.map(([n]) => n).join(', ')} pasó a medirse como hecho y ` +
          `${porProxy.map(([n]) => n).join(', ')} se mide${porProxy.length === 1 ? '' : 'n'} por proxy ` +
          `con los datos que publica Riot. Proxy no es identidad y la tarjeta lo aclara.`
        : '')
  );

  const order = { bloqueante: 0, parcial: 1, declarado: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    items: out,
    counts: {
      bloqueante: out.filter((x) => x.severity === 'bloqueante').length,
      parcial: out.filter((x) => x.severity === 'parcial').length,
      declarado: out.filter((x) => x.severity === 'declarado').length,
    },
  };
}
