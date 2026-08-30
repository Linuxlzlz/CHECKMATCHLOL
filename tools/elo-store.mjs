/**
 * elo-store.mjs — fuerza de equipo para el bot, persistida entre corridas.
 *
 * POR QUÉ EXISTE
 *
 * El sitio calcula Elo desde el corpus que guarda en el navegador; el bot no
 * tiene ese corpus, así que venía prediciendo solo con el récord del split. Eso
 * dejaba predicciones sin ninguna señal de fuerza de equipo cuando el torneo no
 * publicaba standings: cuatro de las primeras treinta y una salieron en 0.500
 * exacto, o sea sin nada adentro.
 *
 * Y la fuerza de equipo no es un componente cualquiera: es EL componente. Sobre
 * el corpus grande es lo único que le gana a la línea base, mientras los cinco
 * ejes del índice de composición dan ~50%.
 *
 * QUÉ GANA EL ELO SOBRE EL RÉCORD
 *
 * Por MAPA los dos empatan (Brier 0.2285 contra 0.2292 sobre 570 mapas). Por
 * SERIE el Elo gana: 0.2066 contra 0.2134. Y sobre todo, existe aunque el
 * torneo no publique tabla, porque se construye de los resultados.
 *
 * CÓMO SE MANTIENE
 *
 * El corpus se guarda como una lista compacta de mapas resueltos, no como los
 * ratings ya calculados. Es a propósito: `buildElo` aplica regresión mensual
 * hacia la media, así que actualizar ratings de forma incremental daría un
 * número distinto del que sale de recorrer la historia entera. Guardando los
 * mapas, cada corrida recalcula desde cero y siempre coincide con lo que
 * mostraría el sitio.
 *
 * Cada corrida solo pide lo NUEVO: por liga se guarda hasta qué fecha se leyó,
 * y se vuelve a mirar con unos días de solape por si un resultado tardó en
 * cerrarse.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(HERE, 'elo-corpus.json');

/** Días de solape al releer una liga: un mapa puede resolverse tarde. */
const SOLAPE_DIAS = 3;

export function loadCorpus() {
  try {
    const raw = fs.readFileSync(CORPUS, 'utf8');
    const v = JSON.parse(raw);
    return {
      builtAt: v.builtAt ?? null,
      hasta: v.hasta ?? {},
      maps: Array.isArray(v.maps) ? v.maps : [],
    };
  } catch {
    return { builtAt: null, hasta: {}, maps: [] };
  }
}

export function saveCorpus(c) {
  const orden = [...c.maps].sort((a, b) => String(a.d).localeCompare(String(b.d)));
  fs.writeFileSync(
    CORPUS,
    JSON.stringify({ builtAt: new Date().toISOString(), hasta: c.hasta, maps: orden }, null, 0) + '\n'
  );
}

/** Los mapas guardados, en la forma que espera buildElo(). */
export function toEloMaps(corpus) {
  return corpus.maps.map((m) => ({
    gameId: m.g,
    date: m.d,
    blueTeamId: m.b,
    redTeamId: m.r,
    winner: m.w, // 'blue' | 'red'
  }));
}

/**
 * Trae los mapas nuevos y los suma al corpus.
 *
 * @param {object} deps  módulos del sitio, inyectados para no duplicar lógica
 * @param {object} opts  { leagues, dias, log }
 * @returns {{added:number, leidas:number, sinResolver:number}}
 */
export async function updateCorpus(deps, { leagues, dias = 150, log = () => {}, presupuestoMs = 8 * 60_000 } = {}) {
  const { getSchedule, getEventDetails, getFinalWindow, pool, finalStateOf, resolveSeries } = deps;
  const corpus = loadCorpus();
  const yaTengo = new Set(corpus.maps.map((m) => m.g));

  // Presupuesto de tiempo por corrida.
  //
  // Con 15 ligas configuradas, la primera construcción son 150 días por liga y
  // puede comerse la ventana entera de vigilancia. Las marcas de agua por liga
  // hacen que esto sea reanudable: lo que no entra hoy se completa en la
  // próxima corrida, y mientras tanto el bot sigue prediciendo con lo que ya
  // tiene en vez de quedarse sin corpus.
  const arranque = Date.now();
  const sinTiempo = () => Date.now() - arranque > presupuestoMs;

  let added = 0;
  let leidas = 0;
  let sinResolver = 0;
  let pendientes = 0;

  for (const league of leagues) {
    // Si se acabó el tiempo, esta liga queda para la próxima: es reanudable.
    if (sinTiempo()) { pendientes++; continue; }
    const key = league.key ?? league.id;
    // Primera vez: se mira `dias` hacia atrás. Después, solo desde lo último
    // leído menos el solape.
    const marca = corpus.hasta[key];
    const desde = marca
      ? new Date(new Date(marca).getTime() - SOLAPE_DIAS * 86400_000)
      : new Date(Date.now() - dias * 86400_000);

    // Partidos terminados de esa liga, paginando hacia atrás mientras haga falta.
    const eventos = [];
    let token = null;
    for (let page = 0; page < 10; page++) {
      let data;
      try { data = await getSchedule(league.id, token); } catch { break; }
      const evs = data?.data?.schedule?.events ?? [];
      if (!evs.length) break;
      for (const e of evs) {
        if (e.state !== 'completed' || !e.match?.id) continue;
        if (new Date(e.startTime) >= desde) eventos.push(e);
      }
      const masViejo = evs[0]?.startTime ? new Date(evs[0].startTime) : null;
      token = data?.data?.schedule?.pages?.older;
      if (!token || (masViejo && masViejo < desde)) break;
    }
    if (!eventos.length) { log(`  ${key}: sin partidos nuevos`); continue; }

    // Solo las series que aportan algún mapa que todavía no tengo.
    const { results: detalles } = await pool(eventos, 5, async (e) => {
      const d = await getEventDetails(e.match.id);
      return { ev: d?.data?.event ?? null, startTime: e.startTime };
    });

    for (const item of detalles) {
      const ev = item?.ev;
      if (!ev?.match) continue;
      const teams = (ev.match.teams ?? []).map((t) => ({ id: t.id, wins: t.result?.gameWins ?? 0 }));
      const games = (ev.match.games ?? [])
        .filter((g) => g.state === 'completed')
        .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
        .map((g) => ({
          gameId: g.id,
          number: g.number,
          blueTeamId: g.teams?.find((t) => t.side === 'blue')?.id ?? null,
          redTeamId: g.teams?.find((t) => t.side === 'red')?.id ?? null,
          final: null,
        }));
      if (!games.length) continue;
      if (games.every((g) => yaTengo.has(g.gameId))) continue;

      leidas++;
      // El estado final hace falta para resolver quién ganó cada mapa: la API
      // solo publica el marcador de la SERIE.
      const { results: finales } = await pool(games, 6, async (g) => {
        const w = await getFinalWindow(g.gameId);
        if (!w?.gameMetadata) return null;
        return {
          gameId: g.gameId,
          final: finalStateOf(w),
          blueTeamId: w.gameMetadata.blueTeamMetadata?.esportsTeamId ?? g.blueTeamId,
          redTeamId: w.gameMetadata.redTeamMetadata?.esportsTeamId ?? g.redTeamId,
        };
      });
      for (const f of finales) {
        if (!f) continue;
        const g = games.find((x) => x.gameId === f.gameId);
        if (!g) continue;
        g.final = f.final;
        // El lado real lo dice el feed; el del evento es solo respaldo.
        g.blueTeamId = f.blueTeamId ?? g.blueTeamId;
        g.redTeamId = f.redTeamId ?? g.redTeamId;
      }

      const { byGame } = resolveSeries(teams, games);
      for (const g of games) {
        if (yaTengo.has(g.gameId)) continue;
        const winnerTeamId = byGame[g.gameId]?.winnerTeamId ?? null;
        if (!winnerTeamId || !g.blueTeamId || !g.redTeamId) { sinResolver++; continue; }
        corpus.maps.push({
          g: g.gameId,
          d: (item.startTime ?? '').slice(0, 10),
          n: g.number ?? null,   // número de mapa: el lado solo se sortea en el primero
          b: g.blueTeamId,
          r: g.redTeamId,
          w: winnerTeamId === g.blueTeamId ? 'blue' : 'red',
        });
        yaTengo.add(g.gameId);
        added++;
      }
    }

    const masNuevo = eventos.map((e) => e.startTime).sort().at(-1);
    if (masNuevo) corpus.hasta[key] = masNuevo;
    log(`  ${key}: ${eventos.length} series en ventana`);
  }

  if (added || Object.keys(corpus.hasta).length) saveCorpus(corpus);
  if (pendientes) {
    log('  ' + pendientes + ' liga(s) quedaron para la proxima corrida: se acabo el presupuesto.');
  }
  return { added, leidas, sinResolver, pendientes, total: corpus.maps.length };
}

/**
 * Devuelve la función que wire.js espera: dados dos teamId, el Elo de cada uno
 * y la diferencia ya convertida a log-odds. Null cuando alguno no tiene
 * historia suficiente, para que el componente no entre con un rating inventado.
 */
export function makeEloFor({ buildElo, eloFor, eloLogOdds, MIN_PARTIDAS_ELO }, corpus) {
  const maps = toEloMaps(corpus);
  if (!maps.length) return null;
  const tabla = buildElo(maps);

  return (teamIdA, teamIdB) => {
    if (!teamIdA || !teamIdB) return null;
    const a = eloFor(tabla, teamIdA);
    const b = eloFor(tabla, teamIdB);
    if (!a || !b) return null;
    if ((a.partidas ?? 0) < MIN_PARTIDAS_ELO || (b.partidas ?? 0) < MIN_PARTIDAS_ELO) return null;

    // Días sin jugar del equipo MÁS oxidado de los dos. Después de un parón
    // largo el rating describe a un equipo que puede haber cambiado de roster,
    // de parche y de meta: medido, a partir de 45 días el modelo acierta 38%.
    const dias = (() => {
      const f = (x) => (x?.ultimo ? (Date.now() - new Date(x.ultimo).getTime()) / 86400_000 : null);
      const da = f(a), db = f(b);
      return da == null || db == null ? null : Math.max(da, db);
    })();

    const logOdds = eloLogOdds(a, b, { dias });
    if (logOdds === null) return null;
    return { a, b, logOdds, dias };
  };
}

/**
 * Tasa de victoria del lado azul medida en el corpus propio.
 *
 * `buildProbability` ya tenía un componente de lado, pero el bot nunca le
 * pasaba nada, así que caía al valor congelado de EVIDENCE (51.7%, medido sobre
 * 867 primeros mapas de un corpus de tres splits). El sitio sí lo pasa medido.
 * Es el mismo hueco que tenía el Elo: la capacidad estaba y el bot no la usaba.
 *
 * Medido camino adelante sobre 152 mapas que el ajuste no vio, comparando qué
 * tasa usar junto al Elo:
 *
 *   congelada 51.7%                Brier 0.2406   59% [51,67]
 *   solo primeros mapas, encogida  Brier 0.2407   59% [51,67]
 *   todos los mapas, encogida      Brier 0.2375   61% [53,68]
 *
 * TENSIÓN DECLARADA, porque acá es fácil engañarse. El comentario de
 * probability.js advierte que la ventaja de lado global mezcla el sorteo del
 * mapa 2, donde el azul es el ganador del mapa anterior el 85-88% de las veces,
 * y que contarla sería sumar fuerza de equipo por tercera vez. Ese razonamiento
 * sigue siendo correcto como CAUSA. Lo que dice la medición de arriba es otra
 * cosa: que el Elo de un corpus joven no alcanza a capturar ese efecto, así que
 * mientras tanto la tasa global predice mejor.
 *
 * Por eso: se encoge hacia 50% por tamaño de muestra, se acota, y se guarda el
 * número de mapa para poder rehacer esta comparación cuando el corpus madure.
 * Si el Elo termina absorbiendo el efecto, esta tasa debería volver sola hacia
 * el 51.7% y el componente dejará de aportar.
 */
export const SIDE = { minMapas: 100, K: 200, piso: 0.50, techo: 0.62 };

export function sideRateFrom(corpus) {
  const maps = corpus?.maps ?? [];

  // SOLO primeros mapas.
  //
  // Del mapa 2 en adelante el lado no se sortea: lo elige el perdedor del mapa
  // anterior, y elige azul el 88% de las veces. Un winrate de azul medido sobre
  // TODOS los mapas mide "gana el que venía ganando", que es fuerza de equipo
  // —lo que el modelo ya cuenta en Elo y en récord—, no ventaja de lado.
  //
  // Esto estaba midiendo sobre todos los mapas y devolvía 54.9%, que el modelo
  // usaba en lugar del 51.7% honesto medido sobre 867 primeros mapas. La
  // diferencia no es cosmética: logit(0.549)=0.197 contra logit(0.517)=0.068,
  // casi el triple, aplicado a TODAS las predicciones y siempre hacia azul. En
  // el registro en vivo el modelo eligió azul en 24 de 35 mapas.
  //
  // El campo `n` se guarda desde hace tiempo justo para esto ("el lado solo se
  // sortea en el primero", más arriba) y nunca se había usado. Si todavía no
  // hay bastantes primeros mapas identificables, se devuelve null y el modelo
  // cae a la medición honesta que ya tiene, que es lo correcto.
  const primeros = maps.filter((m) => m.n === 1);
  if (primeros.length < SIDE.minMapas) return null;

  const azul = primeros.filter((m) => m.w === 'blue').length;
  const cruda = azul / primeros.length;
  // Encoge hacia 50%: un corpus chico no puede afirmar una ventaja grande.
  const encogida = 0.5 + (cruda - 0.5) * (primeros.length / (primeros.length + SIDE.K));
  const acotada = Math.min(SIDE.techo, Math.max(SIDE.piso, encogida));
  return { p: acotada, cruda, n: primeros.length, deTodos: maps.length };
}
