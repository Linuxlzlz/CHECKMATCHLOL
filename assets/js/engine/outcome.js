/**
 * outcome.js — quién ganó cada mapa.
 *
 * El problema: la API expone el marcador de la SERIE, no el ganador de cada
 * mapa. Hasta ahora eso obligaba a atribuir winrate solo en series barridas, y
 * en LCS eso dejaba 29 de 67 mapas utilizables. Con un n así, casi ningún
 * campeón llegaba al filtro de 10 picks y la capa de campeón quedaba vacía.
 *
 * La salida es pedirle al feed el frame FINAL del mapa:
 *
 *   window/{gameId}?startingTime={ahora-90s}
 *
 * devuelve los últimos frames con `gameState: "finished"` y el oro, torres e
 * inhibidores finales — y además el draft completo, así que cuesta lo mismo que
 * la llamada que ya se hacía.
 *
 * De ahí sale el ganador. Pero un heurístico suelto no alcanza, así que se
 * VERIFICA contra el marcador de la serie, que sí es dato duro: si los ganadores
 * inferidos de los mapas suman exactamente el marcador de la serie, la
 * inferencia se acepta; si no, se descarta y solo quedan los mapas que se
 * pueden deducir sin heurística.
 *
 * Medido sobre 88 series y 213 mapas de las 6 ligas (16/08/2026):
 *   - oro final:        87 de 88 series consistentes con el marcador
 *   - torres primero:   84 de 88
 * Por eso el discriminante es el oro y las torres quedan de desempate.
 *
 * La serie que no verifica no se fuerza: se cae al subconjunto determinístico y
 * el resto de sus mapas queda sin atribuir. Un mapa sin atribuir se cuenta como
 * pick igual; lo único que no recibe es resultado.
 */

/** Extrae el estado final de una respuesta de window pedida al final del mapa. */
export function finalStateOf(win) {
  const frames = win?.frames ?? [];
  if (!frames.length) return null;
  const f = frames[frames.length - 1];
  if (!f?.blueTeam || !f?.redTeam) return null;
  return {
    finished: f.gameState === 'finished',
    endTs: f.rfc460Timestamp,
    blue: {
      gold: f.blueTeam.totalGold,
      towers: f.blueTeam.towers,
      inhibitors: f.blueTeam.inhibitors,
      kills: f.blueTeam.totalKills,
      barons: f.blueTeam.barons,
      dragons: f.blueTeam.dragons ?? [],
    },
    red: {
      gold: f.redTeam.totalGold,
      towers: f.redTeam.towers,
      inhibitors: f.redTeam.inhibitors,
      kills: f.redTeam.totalKills,
      barons: f.redTeam.barons,
      dragons: f.redTeam.dragons ?? [],
    },
  };
}

/**
 * Ganador probable de UN mapa por su estado final. Oro primero, torres e
 * inhibidores de desempate. No se usa sola: siempre pasa por la verificación
 * contra el marcador de la serie.
 */
export function guessWinner(game) {
  const s = game.final;
  if (!s) return null;
  const dg = s.blue.gold - s.red.gold;
  const dt = s.blue.towers - s.red.towers;
  const di = s.blue.inhibitors - s.red.inhibitors;
  const d = dg !== 0 ? dg : dt !== 0 ? dt : di;
  if (!d) return null;
  return d > 0 ? game.blueTeamId : game.redTeamId;
}

export const METHOD_LABEL = {
  barrida: 'serie barrida: todos los mapas fueron del mismo equipo',
  cierre: 'mapa de cierre: la serie termina cuando alguien llega a N, así que el último lo ganó quien ganó la serie',
  'oro-final': 'estado final del mapa, verificado contra el marcador de la serie',
};

/**
 * Resuelve el ganador de cada mapa de una serie.
 *
 * @param {{id:string, wins:number}[]} teams  los dos equipos con su marcador de serie
 * @param {{gameId:string, number:number, blueTeamId:string, redTeamId:string, final:object|null}[]} games
 *        mapas COMPLETADOS, en orden
 * @returns {{byGame:Object, verified:boolean, reason:string, attributed:number}}
 */
export function resolveSeries(teams, games) {
  const byGame = {};
  for (const g of games) byGame[g.gameId] = { winnerTeamId: null, method: null };

  if (teams?.length !== 2 || !games.length) {
    return { byGame, verified: false, reason: 'Serie sin dos equipos o sin mapas completados.', attributed: 0 };
  }

  const wins = teams.map((t) => t.wins ?? 0);
  const total = wins[0] + wins[1];
  const seriesWinner = wins[0] === wins[1] ? null : teams[wins[0] > wins[1] ? 0 : 1].id;

  // --- 1. Lo determinístico, que no depende de ningún heurístico ---
  const sweep = seriesWinner && Math.min(...wins) === 0;
  if (sweep) {
    for (const g of games) byGame[g.gameId] = { winnerTeamId: seriesWinner, method: 'barrida' };
  } else if (seriesWinner && total === games.length) {
    // La serie se corta al clinchar: el último mapa jugado es del ganador.
    const last = games[games.length - 1];
    byGame[last.gameId] = { winnerTeamId: seriesWinner, method: 'cierre' };
  }

  // --- 2. Inferencia por estado final, aceptada solo si verifica ---
  const guesses = games.map((g) => ({ gameId: g.gameId, winner: guessWinner(g) }));
  const complete = guesses.every((x) => x.winner);
  let verified = false;
  let reason;

  if (!complete) {
    reason = 'Al menos un mapa no devolvió estado final: la inferencia no se puede verificar.';
  } else if (total !== games.length) {
    // Ej: una serie 2-0 con 3 mapas listados, o datos incompletos.
    reason = `El marcador de la serie (${wins.join('-')}) no coincide con los ${games.length} ` +
      `mapas completados que devuelve la API. Sin esa igualdad no hay contra qué verificar.`;
  } else {
    const tally = {};
    for (const x of guesses) tally[x.winner] = (tally[x.winner] ?? 0) + 1;
    const matches = teams.every((t, i) => (tally[t.id] ?? 0) === wins[i]);
    if (matches) {
      verified = true;
      for (const x of guesses) {
        // Lo determinístico manda: si el heurístico contradijera una barrida,
        // el marcador no habría cuadrado, así que acá ya coinciden.
        if (!byGame[x.gameId].winnerTeamId) {
          byGame[x.gameId] = { winnerTeamId: x.winner, method: 'oro-final' };
        }
      }
      reason = 'Los ganadores inferidos suman exactamente el marcador de la serie.';
    } else {
      reason =
        `Los ganadores inferidos por estado final suman ${teams.map((t) => tally[t.id] ?? 0).join('-')} ` +
        `y la serie terminó ${wins.join('-')}. No se acepta: quedan solo los mapas deducibles sin heurística.`;
    }
  }

  const attributed = Object.values(byGame).filter((v) => v.winnerTeamId).length;
  return { byGame, verified, reason, attributed };
}
