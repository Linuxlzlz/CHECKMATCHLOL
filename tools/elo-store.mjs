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
export async function updateCorpus(deps, { leagues, dias = 45, log = () => {} } = {}) {
  const { getSchedule, getEventDetails, getFinalWindow, pool, finalStateOf, resolveSeries } = deps;
  const corpus = loadCorpus();
  const yaTengo = new Set(corpus.maps.map((m) => m.g));

  let added = 0;
  let leidas = 0;
  let sinResolver = 0;

  for (const league of leagues) {
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
  return { added, leidas, sinResolver, total: corpus.maps.length };
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
    return { a, b, logOdds: eloLogOdds(a, b) };
  };
}
