/**
 * app.js — orquestador de la UI.
 *
 * El informe se arma en el mismo orden que el formato de salida del skill, de
 * lo más duro a lo más interpretativo: draft, índice, concentración, capa de
 * campeón, capa de jugador, parche, ventana, lectura, señales.
 */

import {
  LEAGUES, getSchedule, getLive, getEventDetails, getStandings, getCurrentTournament,
  getWindow, getDetails, feedTimestamp, initDDragon, championIcon, championName, secure,
  getRosterIndex, itemIcon,
} from './api.js';
import {
  CHECKPOINTS, stateAtMinute, mergePlayers, roleGoldDiff, goldConcentration, detailSignals,
} from './engine/checkpoints.js';
import * as ledger from './engine/ledger.js';
import { diffChampions } from './engine/patchdiff.js';
import { scoreDraft, isClassified } from './engine/index-score.js';
import {
  structuralAxes, laneMatchups, concentrationAndWindow, NON_COMPUTABLE_AXES,
  MATCHUP_CHECKLIST, ROLE_LABEL,
} from './engine/structural.js';
import { readState, liveSignals, gameMinute, snapshotLabel } from './engine/live.js';
import { buildProbability, bettingStance, layerDisagreement } from './engine/probability.js';
import {
  buildTournamentIndex, championLayer, playerLayer, stackedRisk, clearIndexCache, rosterCheck,
} from './engine/meta.js';

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const AXIS_LABEL = {
  teamfight: 'Teamfight', pick: 'Pick', split: 'Split', siege: 'Asedio', scaling: 'Escalado',
};

const state = {
  league: LEAGUES[0],
  tournament: null,
  events: [],
  liveIds: new Set(),
  matchId: null,
  gameId: null,
  detail: null,
  standings: null,
  metaIndex: null,
  metaBuilding: false,
  rosters: null,
  patchDiff: null,
  patchDiffBusy: false,
  timer: null,
};

/* ------------------------------------------------------------------ *
 * arranque
 * ------------------------------------------------------------------ */

async function init() {
  renderLeagues();
  $('#refresh').addEventListener('click', () => {
    if (state.matchId) openMatch(state.matchId, { force: true });
    else loadLeague(state.league);
  });
  $('#open-ledger').addEventListener('click', () => {
    state.matchId = null;
    renderMatchList();
    renderLedger();
  });
  await initDDragon();
  await loadLeague(state.league);
  pollLive();
  setInterval(pollLive, 20_000);
}

function renderLeagues() {
  $('#leagues').innerHTML = LEAGUES.map(
    (l) => `<button class="league-btn${l.key === state.league.key ? ' active' : ''}"
              data-key="${l.key}">${esc(l.name)}<span class="reg">${esc(l.region)}</span></button>`
  ).join('');
  $('#leagues').querySelectorAll('.league-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.league = LEAGUES.find((l) => l.key === b.dataset.key);
      state.matchId = null;
      state.metaIndex = null;
      renderLeagues();
      loadLeague(state.league);
      $('#content').innerHTML = emptyState();
    })
  );
}

const emptyState = () => `
  <div class="empty-state">
    <div class="empty-mark">🎯</div>
    <h2>Elegí un partido de ${esc(state.league.name)}</h2>
    <p>El análisis se arma con el draft real del feed oficial.</p>
  </div>`;

/* ------------------------------------------------------------------ *
 * liga y lista de partidos
 * ------------------------------------------------------------------ */

async function loadLeague(league) {
  $('#league-title').textContent = league.name;
  $('#tournament-label').textContent = 'cargando…';
  $('#match-list').innerHTML = `<div class="skeleton-list"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;

  try {
    const [sched, tournament] = await Promise.all([
      getSchedule(league.id),
      getCurrentTournament(league.id).catch(() => null),
    ]);
    state.tournament = tournament;
    state.events = sched?.data?.schedule?.events ?? [];
    $('#tournament-label').textContent = tournament?.slug
      ? tournament.slug.replace(/_/g, ' ')
      : 'torneo no identificado';

    state.standings = null;
    if (tournament?.id) {
      getStandings(tournament.id)
        .then((s) => { state.standings = s; })
        .catch(() => { state.standings = null; });
    }
    renderMatchList();
  } catch (e) {
    $('#match-list').innerHTML = `<div class="card-body"><div class="err">No se pudo cargar el calendario: ${esc(e.message)}</div></div>`;
  }
}

function renderMatchList() {
  const evs = state.events.filter((e) => e.match?.teams?.length === 2);
  const live = [], upcoming = [], done = [];
  for (const e of evs) {
    if (e.state === 'inProgress' || state.liveIds.has(e.match.id)) live.push(e);
    else if (e.state === 'completed') done.push(e);
    else upcoming.push(e);
  }
  done.reverse();

  const groups = [
    ['En vivo', live],
    ['Próximos', upcoming.slice(0, 12)],
    ['Terminados', done.slice(0, 25)],
  ].filter(([, arr]) => arr.length);

  if (!groups.length) {
    $('#match-list').innerHTML = `<div class="card-body"><p class="muted-xs">Sin partidos en el calendario de esta liga.</p></div>`;
    return;
  }

  $('#match-list').innerHTML = groups
    .map(([label, arr]) => `
      <div class="group-label">${label}</div>
      ${arr.map((e) => matchItem(e, label === 'En vivo')).join('')}`)
    .join('');

  $('#match-list').querySelectorAll('.match-item').forEach((b) =>
    b.addEventListener('click', () => openMatch(b.dataset.id))
  );
}

function matchItem(e, isLive) {
  const [t1, t2] = e.match.teams;
  // Un partido sin empezar trae result {gameWins:0}; mostrar "0-0" ahí es ruido.
  const played = e.state === 'completed' || isLive;
  const score = played
    ? `<span class="score">${t1.result?.gameWins ?? 0}-${t2.result?.gameWins ?? 0}</span>` : '';
  const when = new Date(e.startTime).toLocaleString('es', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  return `
    <button class="match-item${state.matchId === e.match.id ? ' active' : ''}" data-id="${e.match.id}">
      <div class="match-teams">
        <span>${esc(t1.code)}</span><span class="vs">vs</span><span>${esc(t2.code)}</span>
      </div>
      <div class="match-meta">
        ${isLive ? '<span class="tag-live">● EN VIVO</span>' : `<span>${esc(when)}</span>`}
        ${score}
        <span>${esc(e.blockName ?? '')}</span>
      </div>
    </button>`;
}

async function pollLive() {
  try {
    const data = await getLive();
    const evs = data?.data?.schedule?.events ?? [];
    state.liveIds = new Set(evs.filter((e) => e.match?.id).map((e) => e.match.id));
    const mine = evs.filter((e) => e.league?.id === state.league.id);
    const pill = $('#live-pill');
    if (evs.length) {
      pill.hidden = false;
      pill.className = mine.length ? 'pill pill-live' : 'pill pill-idle';
      pill.textContent = mine.length
        ? `${mine.length} en vivo en ${state.league.name}`
        : `${evs.length} en vivo en otras ligas`;
    } else {
      pill.hidden = false;
      pill.className = 'pill pill-idle';
      pill.textContent = 'sin partidos en vivo';
    }
    renderMatchList();
    // Si el partido abierto está en vivo, refrescamos su estado.
    if (state.matchId && state.liveIds.has(state.matchId)) openMatch(state.matchId, { quiet: true });
  } catch { /* el poll no debe romper la vista */ }
}

/* ------------------------------------------------------------------ *
 * partido
 * ------------------------------------------------------------------ */

async function openMatch(matchId, { quiet = false, force = false, gameId = null } = {}) {
  const changed = state.matchId !== matchId;
  state.matchId = matchId;
  if (changed) { state.gameId = null; renderMatchList(); }
  if (gameId) state.gameId = gameId;

  const btn = $('#refresh');
  if (!quiet) btn.classList.add('spinning');
  if (!quiet && changed) {
    $('#content').innerHTML = `<div class="card"><div class="card-body"><p class="muted">Cargando partido…</p></div></div>`;
  }

  try {
    const det = await getEventDetails(matchId);
    const ev = det?.data?.event;
    if (!ev) throw new Error('El partido no devolvió detalles.');
    state.detail = ev;

    const games = ev.match?.games ?? [];
    if (!state.gameId || !games.some((g) => g.id === state.gameId)) {
      const inProgress = games.find((g) => g.state === 'inProgress');
      const lastDone = [...games].reverse().find((g) => g.state === 'completed');
      state.gameId = (inProgress ?? lastDone ?? games[0])?.id ?? null;
    }
    await renderMatch(ev, force);
  } catch (e) {
    $('#content').innerHTML = `<div class="card"><div class="card-body"><div class="err">${esc(e.message)}</div></div></div>`;
  } finally {
    btn.classList.remove('spinning');
  }
}

async function renderMatch(ev, force) {
  const games = ev.match?.games ?? [];
  const game = games.find((g) => g.id === state.gameId);
  const teams = ev.match?.teams ?? [];

  // Draft desde el feed. Sin startingTime = frame de inicio, que es lo que
  // trae el draft y el parche.
  let win = null;
  try { win = await getWindow(state.gameId); } catch { win = null; }

  if (!win?.gameMetadata) {
    $('#content').innerHTML =
      matchHeader(ev, game, games) +
      `<div class="card"><div class="card-body">
         <p class="muted">El feed no devuelve datos para este mapa todavía.</p>
         <div class="note">Una respuesta vacía significa que <strong>el mapa no arrancó</strong>.
           No es un error: es un "todavía no". El draft aparece cuando empieza la partida.</div>
       </div></div>`;
    bindGameTabs();
    return;
  }

  const meta = win.gameMetadata;

  // Mapeo equipo ↔ lado por esportsTeamId. NO por posición en el HUD:
  // asumir que la izquierda es lado azul ya produjo un análisis entero con
  // los números atribuidos al equipo equivocado.
  const teamById = Object.fromEntries(teams.map((t) => [t.id, t]));
  const mkSide = (metaSide, side) => {
    const t = teamById[metaSide.esportsTeamId];
    return {
      side,
      teamId: metaSide.esportsTeamId,
      team: t?.code ?? (side === 'blue' ? 'AZUL' : 'ROJO'),
      name: t?.name ?? '',
      image: secure(t?.image),
      record: t?.record ?? null,
      players: (metaSide.participantMetadata ?? []).map((p) => ({
        participantId: p.participantId,
        playerId: p.esportsPlayerId,
        name: p.summonerName,
        champion: p.championId,
        role: p.role,
      })),
    };
  };
  const blue = mkSide(meta.blueTeamMetadata, 'blue');
  const red = mkSide(meta.redTeamMetadata, 'red');
  const sides = { a: blue, b: red };

  // Estado en vivo / final: hace falta startingTime, si no el feed devuelve ceros.
  let liveFrame = null, startTs = null, detailsFrame = null;
  startTs = win.frames?.[0]?.rfc460Timestamp ?? null;
  if (game?.state === 'inProgress' || game?.state === 'completed') {
    const ts = game.state === 'inProgress' ? feedTimestamp(90) : lateTimestamp(startTs);
    try {
      const [w2, d2] = await Promise.all([
        getWindow(state.gameId, ts),
        getDetails(state.gameId, ts).catch(() => null),
      ]);
      liveFrame = w2?.frames?.slice(-1)[0] ?? null;
      detailsFrame = d2?.frames?.slice(-1)[0] ?? null;
    } catch { /* el análisis de draft sigue funcionando sin estado */ }
  }

  const minute = liveFrame ? gameMinute(startTs, liveFrame.rfc460Timestamp) : null;
  const st = liveFrame ? readState(liveFrame, sides, minute) : null;

  // Vista por jugador uniendo window (oro, nivel, KDA, CS) con details
  // (damage share, participación en kills, wards, ítems).
  const merged = liveFrame ? mergePlayers(liveFrame, detailsFrame, sides) : null;
  const roleGold = merged ? roleGoldDiff(merged, sides) : null;
  const goldConc = roleGold ? goldConcentration(roleGold) : null;
  const dSignals = merged ? detailSignals(merged, sides, minute ?? 0) : [];

  // Checkpoints exactos del minuto 15 y 20, pedidos al minuto y no "cuando toqué".
  const checkpoints = [];
  if (startTs && minute) {
    for (const cp of CHECKPOINTS) {
      if (minute < cp) continue;
      const snap = await stateAtMinute(state.gameId, startTs, cp);
      if (!snap) continue;
      const cpMerged = mergePlayers(snap.frame, snap.detailsFrame, sides);
      const cpState = readState(snap.frame, sides, cp);
      checkpoints.push({
        minute: cp,
        state: cpState,
        roleGold: roleGoldDiff(cpMerged, sides),
        goldDiff: cpState ? cpState.a.gold - cpState.b.gold : null,
      });
    }
  }

  // Roster: separar suplente de pick raro.
  if (!state.rosters) state.rosters = await getRosterIndex().catch(() => ({}));
  const rosterA = rosterCheck(state.rosters, blue);
  const rosterB = rosterCheck(state.rosters, red);

  // --- análisis ---
  const score = scoreDraft(
    { team: blue.team, champions: blue.players.map((p) => p.champion) },
    { team: red.team, champions: red.players.map((p) => p.champion) }
  );
  const axes = structuralAxes(blue, red);
  const lanes = laneMatchups(blue, red);
  const { edges, window: win7 } = concentrationAndWindow(blue, red, axes);

  const recA = findRecord(blue) ?? blue.record;
  const recB = findRecord(red) ?? red.record;
  const prob = buildProbability({
    recordA: recA, recordB: recB,
    tfDelta: score.tfDelta,
    goldDiff: st ? st.a.gold - st.b.gold : null,
    minute,
    finished: game?.state === 'completed',
  });
  const stance = bettingStance({ p: prob.p, marketP: null });

  const chLayerA = state.metaIndex ? championLayer(state.metaIndex, blue.players.map((p) => p.champion)) : null;
  const chLayerB = state.metaIndex ? championLayer(state.metaIndex, red.players.map((p) => p.champion)) : null;
  const plLayerA = state.metaIndex ? playerLayer(state.metaIndex, blue.players) : null;
  const plLayerB = state.metaIndex ? playerLayer(state.metaIndex, red.players) : null;

  const disagreement = layerDisagreement([
    { name: 'Índice de composición', favors: Math.abs(score.tfDelta) >= 0.5 ? score.tfFavors : null },
    { name: 'Calidad de equipos (standings)', favors: qualityFavors(recA, recB, blue, red) },
    { name: 'Estado de la partida', favors: st ? (Math.abs(st.a.gold - st.b.gold) >= 1000 ? (st.a.gold > st.b.gold ? blue.team : red.team) : null) : null },
    { name: 'Capa de campeón', favors: championLayerFavors(chLayerA, chLayerB, blue, red) },
  ]);

  // Congelar la predicción la primera vez que se ve este mapa. Idempotente:
  // reabrirlo no la reescribe aunque el modelo ahora diga otra cosa.
  const entry = ledger.recordPrediction(state.gameId, {
    matchId: state.matchId,
    league: ev.league?.name,
    tournament: state.tournament?.slug,
    teamA: blue.team, teamB: red.team, sideA: 'blue',
    gameNumber: game?.number,
    gameState: game?.state,
    startedBefore: !!minute && minute > 2,
    p: prob.p, tfDelta: score.tfDelta, band: score.tfBand.label,
    hadQuality: prob.hasQuality,
    layers: disagreement.layers.map((l) => `${l.name}: ${l.favors}`),
  });
  for (const cp of checkpoints) {
    ledger.recordSnapshot(state.gameId, cp.minute, {
      goldDiff: cp.goldDiff,
      kills: cp.state ? `${cp.state.a.kills}-${cp.state.b.kills}` : null,
      towers: cp.state ? `${cp.state.a.towers}-${cp.state.b.towers}` : null,
    });
  }

  $('#content').innerHTML = [
    matchHeader(ev, game, games),
    st ? cardLiveState(st, minute, game) : '',
    checkpoints.length ? cardCheckpoints(checkpoints, blue, red) : '',
    cardDraft(blue, red, lanes, rosterA, rosterB),
    cardIndex(score),
    cardConcentration(edges, axes, blue, red),
    roleGold ? cardRoleGold(roleGold, goldConc, edges, blue, red, minute) : '',
    merged ? cardPlayerDetail(merged, blue, red) : '',
    cardChampionLayer(chLayerA, chLayerB, blue, red),
    cardPlayerLayer(plLayerA, plLayerB, blue, red, chLayerA, chLayerB, rosterA, rosterB),
    cardPatch(meta.patchVersion, blue, red),
    cardWindow(win7),
    cardReading(score, prob, stance, blue, red, disagreement, entry),
    st ? cardSignals(st, minute, dSignals) : cardSignalsPreview(),
    cardMatchupChecklist(),
  ].join('');

  bindGameTabs();
  bindMetaButton();
  bindPatchDiff(blue, red, meta.patchVersion);
  bindMarketAndResult(blue, red);
}

/** Para un mapa terminado pedimos un frame bien tardío para agarrar el estado final. */
function lateTimestamp(startTs) {
  if (!startTs) return feedTimestamp(0);
  const end = new Date(startTs).getTime() + 60 * 60 * 1000;
  return feedTimestamp(0, Math.min(end, Date.now() - 90_000));
}

function findRecord(side) {
  const stg = state.standings?.data?.standings?.[0]?.stages ?? [];
  for (const stage of stg) {
    for (const sec of stage.sections ?? []) {
      for (const rank of sec.rankings ?? []) {
        for (const t of rank.teams ?? []) {
          if (t.id === side.teamId || t.code === side.team) return t.record ?? null;
        }
      }
    }
  }
  return null;
}

function qualityFavors(a, b, blue, red) {
  const wr = (r) => (r && r.wins + r.losses > 0 ? r.wins / (r.wins + r.losses) : null);
  const x = wr(a), y = wr(b);
  if (x === null || y === null || x === y) return null;
  return x > y ? blue.team : red.team;
}

function championLayerFavors(la, lb, blue, red) {
  if (!la || !lb) return null;
  const avg = (l) => {
    const ok = l.filter((c) => c.admits && c.wr !== null);
    return ok.length ? ok.reduce((s, c) => s + c.wr, 0) / ok.length : null;
  };
  const x = avg(la), y = avg(lb);
  if (x === null || y === null || Math.abs(x - y) < 0.03) return null;
  return x > y ? blue.team : red.team;
}

/* ------------------------------------------------------------------ *
 * tarjetas
 * ------------------------------------------------------------------ */

function matchHeader(ev, game, games) {
  const [t1, t2] = ev.match?.teams ?? [];
  const tabs = games.map((g) => {
    const label = `Mapa ${g.number}`;
    const dis = g.state === 'unstarted' ? 'disabled' : '';
    const dot = g.state === 'inProgress' ? ' ●' : '';
    return `<button class="game-tab${g.id === state.gameId ? ' active' : ''}" data-game="${g.id}" ${dis}>${label}${dot}</button>`;
  }).join('');

  return `
  <div class="card">
    <div class="match-head">
      <div class="match-head-top">
        <div class="team-block">
          ${t1?.image ? `<img src="${esc(secure(t1.image))}" alt="">` : ''}
          <div><div class="team-name">${esc(t1?.code ?? '')}</div>
               <div class="muted-xs">${esc(t1?.name ?? '')}</div></div>
        </div>
        <div class="scoreline">${t1?.result?.gameWins ?? 0} — ${t2?.result?.gameWins ?? 0}</div>
        <div class="team-block">
          <div style="text-align:right"><div class="team-name">${esc(t2?.code ?? '')}</div>
               <div class="muted-xs">${esc(t2?.name ?? '')}</div></div>
          ${t2?.image ? `<img src="${esc(secure(t2.image))}" alt="">` : ''}
        </div>
      </div>
      <div class="game-tabs">${tabs}</div>
      <div class="muted-xs">${[
        ev.league?.name,
        ev.match?.strategy?.type === 'bestOf' ? `Bo${ev.match.strategy.count}` : null,
        ev.blockName,
      ].filter(Boolean).map(esc).join(' · ')}</div>
    </div>
  </div>`;
}

function championCell(p, subLabel) {
  const icon = championIcon(p.champion);
  const unk = isClassified(p.champion) ? '' : `<div class="unclassified">sin clasificar en la tabla</div>`;
  return `<div class="champ">
      ${icon ? `<img src="${esc(icon)}" alt="" loading="lazy">` : '<div class="champ-img-ph"></div>'}
      <div class="champ-txt">
        <div class="champ-name">${esc(championName(p.champion))}</div>
        <div class="champ-player">${esc(p.name)}${subLabel ? ` <span class="badge badge-warn">${esc(subLabel)}</span>` : ''}</div>
        ${unk}
      </div>
    </div>`;
}

function cardDraft(blue, red, lanes, rosterA, rosterB) {
  const subOf = (roster, player) => {
    if (!roster?.known) return null;
    const row = roster.rows.find((r) => r.participantId === player.participantId);
    if (!row) return null;
    if (!row.starter) return 'suplente';
    if (row.offRole) return `titular de ${ROLE_LABEL[row.offRole] ?? row.offRole}`;
    return null;
  };
  const rows = lanes.map((l) => `
    <tr>
      <td>${l.a ? championCell(l.a, subOf(rosterA, l.a)) : '<span class="muted-xs">—</span>'}</td>
      <td class="role" style="text-align:center">${esc(l.label)}</td>
      <td>${l.b ? championCell(l.b, subOf(rosterB, l.b)) : '<span class="muted-xs">—</span>'}</td>
    </tr>`).join('');
  const subsNote = [
    ...(rosterA?.subs ?? []).map((s) => `${s.name} (${blue.team})`),
    ...(rosterB?.subs ?? []).map((s) => `${s.name} (${red.team})`),
  ];

  return `
  <div class="card">
    <div class="card-head"><h3>Draft</h3>
      <span class="muted-xs">mapeo por esportsTeamId, no por posición en el HUD</span></div>
    <div class="card-body">
      <table class="draft-table">
        <thead><tr>
          <th><span class="side-blue">● ${esc(blue.team)}</span> <span class="team-side side-blue">lado azul</span></th>
          <th style="text-align:center">Posición</th>
          <th><span class="side-red">● ${esc(red.team)}</span> <span class="team-side side-red">lado rojo</span></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${subsNote.length ? `<div class="note note-warn">Fuera del roster listado: ${esc(subsNote.join(' · '))}.
        Un suplente y un pick raro se ven igual en la capa de jugador y no son lo mismo.
        El roster que devuelve la API es el vigente, no el del día del partido.</div>` : ''}
    </div>
  </div>`;
}

function cardCheckpoints(checkpoints, blue, red) {
  const cols = checkpoints.map((cp) => {
    const dg = cp.goldDiff;
    const lead = dg == null ? null : dg > 0 ? blue.team : red.team;
    const read = dg == null ? '—'
      : Math.abs(dg) < 1000
        ? `Menos de 1k: empate. El empate favorece a quien tiene mejor tardío.`
        : `Ventaja de ${esc(lead)}.`;
    return `
      <div class="stat">
        <div class="stat-k">Minuto ${cp.minute} · oro</div>
        <div class="stat-v">${dg == null ? '—' : (dg >= 0 ? '+' : '') + dg.toLocaleString('es')}</div>
        <div class="muted-xs">${read}</div>
        ${cp.state ? `<div class="muted-xs">kills ${cp.state.a.kills}-${cp.state.b.kills} ·
          torres ${cp.state.a.towers}-${cp.state.b.towers}</div>` : ''}
      </div>`;
  }).join('');

  return `
  <div class="card">
    <div class="card-head"><h3>Checkpoints</h3>
      <span class="muted-xs">pedidos al minuto exacto, no cuando se abrió la página</span></div>
    <div class="card-body">
      <div class="live-grid">${cols}</div>
      <div class="note note-ok">Guardado en el registro con fecha. Es lo único que después
        permite calibrar: el estado anotado antes de saber el resultado.</div>
    </div>
  </div>`;
}

function cardRoleGold(roleGold, conc, edges, blue, red, minute) {
  const max = Math.max(1, ...roleGold.map((r) => Math.abs(r.diff ?? 0)));
  const rows = roleGold.map((r) => {
    const d = r.diff;
    const pct = d == null ? 0 : (d / max) * 50;
    const w = Math.abs(pct);
    const left = pct >= 0 ? 50 : 50 - w;
    return `
      <div class="axis-row">
        <div class="axis-name">${esc(ROLE_LABEL[r.role] ?? r.role)}</div>
        <div class="axis-bar"><div class="mid"></div>
          <div class="fill" style="left:${left}%;width:${w}%;background:${pct >= 0 ? 'var(--blue)' : 'var(--red)'}"></div>
        </div>
        <div class="axis-val">${d == null ? '—' : (d >= 0 ? '+' : '') + d.toLocaleString('es')}
          <div class="muted-xs">${esc(r.a?.champion ?? '—')} / ${esc(r.b?.champion ?? '—')}</div>
        </div>
      </div>`;
  }).join('');

  // Contraste entre lo que el draft predijo y dónde se concentró el oro.
  const predicted = edges[0]?.carrier?.role ?? null;
  const actual = conc?.top?.[0]?.role ?? null;
  let verdict = '';
  if (predicted && actual) {
    const hit = predicted === actual;
    verdict = `<div class="note ${hit ? 'note-ok' : 'note-warn'}">
      El draft decía que el margen se concentraba en <strong>${esc(ROLE_LABEL[predicted] ?? predicted)}</strong>
      (${esc(edges[0].side)}). El oro se concentró en <strong>${esc(ROLE_LABEL[actual] ?? actual)}</strong>.
      ${hit ? 'La afirmación del Paso 7 se cumplió en este mapa.'
            : 'No coincide. Anotalo: los desacuerdos son los únicos casos que enseñan algo.'}
    </div>`;
  } else if (!predicted) {
    verdict = `<div class="note">El draft no nombró una posición de concentración, así que no hay
      nada que verificar acá.</div>`;
  }

  return `
  <div class="card">
    <div class="card-head"><h3>Oro por rol</h3>
      <span class="muted-xs">${minute ? `minuto ${minute.toFixed(0)}` : ''} · verifica la concentración predicha</span></div>
    <div class="card-body">
      ${rows}
      ${conc?.share != null ? `<div class="row"><span class="row-label">Concentración</span>
        <span class="row-val">${(conc.share * 100).toFixed(0)}% del desequilibrio vive en 2 posiciones</span></div>` : ''}
      ${verdict}
    </div>
  </div>`;
}

function cardPlayerDetail(merged, blue, red) {
  const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
  const itemRow = (items) =>
    (items ?? []).slice(0, 6).map((id) => {
      const src = itemIcon(id);
      return src ? `<img class="item" src="${esc(src)}" alt="" loading="lazy">` : '';
    }).join('');

  const side = (players, team) => `
    <div class="muted-xs" style="margin:10px 0 4px">${esc(team)}</div>
    <table class="detail-table">
      <thead><tr><th>Jugador</th><th>KDA</th><th>Oro</th><th>Daño</th><th>KP</th><th>Wards</th><th>Ítems</th></tr></thead>
      <tbody>
      ${players.map((p) => `
        <tr>
          <td><strong>${esc(championName(p.champion))}</strong><div class="champ-player">${esc(p.name)}</div></td>
          <td class="num">${p.kills}/${p.deaths}/${p.assists}</td>
          <td class="num">${p.gold == null ? '—' : p.gold.toLocaleString('es')}</td>
          <td class="num">${pct(p.damageShare)}</td>
          <td class="num">${pct(p.killParticipation)}</td>
          <td class="num">${p.wardsPlaced == null ? '—' : `${p.wardsPlaced}/${p.wardsDestroyed ?? 0}`}</td>
          <td><div class="items">${itemRow(p.items)}</div></td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  const anyDetails = [...merged.a, ...merged.b].some((p) => p.hasDetails);

  return `
  <div class="card">
    <div class="card-head"><h3>Detalle por jugador</h3>
      <span class="muted-xs">daño, participación en kills, visión e ítems</span></div>
    <div class="card-body">
      ${anyDetails ? '' : `<div class="note note-warn">El feed de detalle no devolvió datos para este
        frame. Las columnas de daño, KP y wards quedan vacías: faltan, no son cero.</div>`}
      ${side(merged.a, blue.team)}
      ${side(merged.b, red.team)}
    </div>
  </div>`;
}

function cardIndex(score) {
  const [A, B] = score.sides;
  const d = score.tfDelta;
  const tierClass = { strong: 'band-strong', weak: 'band-weak', coin: 'band-coin' }[score.tfBand.tier];

  const axisRows = score.perAxis.map((ax) => {
    const pct = Math.max(-1, Math.min(1, ax.dz / 3));
    const w = Math.abs(pct) * 50;
    const left = pct >= 0 ? 50 : 50 - w;
    return `
      <div class="axis-row${ax.narratable ? '' : ' dim'}">
        <div class="axis-name">${AXIS_LABEL[ax.axis]}</div>
        <div class="axis-bar"><div class="mid"></div>
          <div class="fill" style="left:${left}%;width:${w}%;background:${pct >= 0 ? 'var(--blue)' : 'var(--red)'}"></div>
        </div>
        <div class="axis-val">
          ${ax.dz >= 0 ? '+' : ''}${ax.dz.toFixed(2)} sd · ${ax.dRaw >= 0 ? '+' : ''}${ax.dRaw.toFixed(1)} pts
          ${ax.narratable ? '' : '<div class="axis-flag">no narrable</div>'}
        </div>
      </div>`;
  }).join('');

  const warns = score.warnings.map((w) => `<div class="note note-warn">${esc(w)}</div>`).join('');

  return `
  <div class="card">
    <div class="card-head"><h3>Índice</h3>
      <span class="muted-xs">referencia: 62 comps · fórmulas congeladas</span></div>
    <div class="card-body">
      <div class="delta-hero">
        <div class="delta-num ${tierClass}">${d >= 0 ? '+' : ''}${d.toFixed(2)}<span style="font-size:15px"> sd</span></div>
        <div class="delta-meta">
          <div><strong>Δ teamfight favorece a ${esc(score.tfFavors)}</strong></div>
          <div class="muted-xs">Banda ${esc(score.tfBand.label)} — ${esc(score.tfBand.meaning)}</div>
        </div>
      </div>

      <div class="row"><span class="row-label">Arquetipo primario</span>
        <span class="row-val">${esc(A.team)}: ${AXIS_LABEL[A.primary]} · ${esc(B.team)}: ${AXIS_LABEL[B.primary]}</span></div>

      <div style="margin-top:14px">
        <div class="muted-xs" style="margin-bottom:8px">
          Diferencia por eje (${esc(A.team)} respecto de ${esc(B.team)}). Los ejes con menos de
          1 punto crudo de diferencia se marcan como no narrables: los z-scores amplifican los
          ejes de dispersión estrecha.
        </div>
        ${axisRows}
      </div>

      <div class="note">
        Solo importa la <strong>diferencia</strong> entre las dos comps. El z-score absoluto de un
        lado se mide contra la media de la referencia, no contra el rival: leerlo como brecha de
        matchup es el error registrado el 15/08.
      </div>
      ${warns}
    </div>
  </div>`;
}

function cardConcentration(edges, axes, blue, red) {
  const edgeHtml = edges.length
    ? edges.map((e) => `
        <div class="edge-item">
          <div class="edge-title">${esc(e.label)} — <span class="accent">${esc(e.side)}</span></div>
          ${e.carrier ? `<div class="edge-carrier">Lo carga ${esc(championName(e.carrier.champion))} (${esc(ROLE_LABEL[e.carrier.role] ?? e.carrier.role)}, ${esc(e.carrier.name)})</div>` : ''}
        </div>`).join('')
    : `<p class="muted">Ningún eje estructural concentra margen suficiente para nombrarlo. Mapa parejo en estructura.</p>`;

  const axisRows = axes.map((ax) => `
    <div class="row">
      <span class="row-label">${esc(ax.label)}${ax.favors ? ` <span class="badge badge-blue">${esc(ax.favors)}</span>` : ''}</span>
      <span class="row-val">${esc(blue.team)} ${fmt(ax.a)} · ${esc(red.team)} ${fmt(ax.b)}<br>
        <span class="muted-xs">${esc(ax.unit)}</span></span>
    </div>
    ${ax.detail ? `<div class="muted-xs" style="padding-bottom:6px">${esc(ax.detail)}</div>` : ''}
    ${ax.note ? `<div class="note ${ax.structural ? 'note-warn' : ''}">${esc(ax.note)}</div>` : ''}
  `).join('');

  return `
  <div class="card">
    <div class="card-head"><h3>Dónde se concentra la ventaja</h3>
      <span class="muted-xs">un margen grande en dos posiciones vale más que ventajas chicas en cuatro</span></div>
    <div class="card-body">
      ${edgeHtml}
      <div style="margin-top:16px"><div class="muted-xs" style="margin-bottom:6px">Ejes de counter estructural</div>${axisRows}</div>
      <div class="note">
        <strong>No computable desde la tabla congelada:</strong>
        ${NON_COMPUTABLE_AXES.map(([n]) => esc(n)).join(' · ')}.
        Estos ejes quedan para lectura humana; el sitio no les inventa un número.
      </div>
    </div>
  </div>`;
}

const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(1)) : v);

function cardChampionLayer(la, lb, blue, red) {
  if (!la) {
    return `
    <div class="card">
      <div class="card-head"><h3>Capa de campeón</h3></div>
      <div class="card-body">
        <p class="muted">Requiere indexar el torneo. gol.gg no es accesible desde el navegador,
          así que esta capa se reconstruye leyendo los drafts de los partidos ya jugados desde
          el feed oficial.</p>
        <div style="margin-top:12px"><button class="btn" id="build-meta">Indexar torneo</button></div>
        <div id="meta-progress"></div>
        <div class="note">Sin el índice, esta capa está <strong>ausente</strong>, no en cero.
          El análisis de arriba no la incluye.</div>
      </div>
    </div>`;
  }

  const side = (l, s) => l.map((c) => `
    <div class="layer-row">
      <div>
        <div><strong>${esc(championName(c.champion))}</strong>
          <span class="badge ${c.admits ? 'badge-ok' : c.status === 'sin-datos' ? 'badge-warn' : 'badge-no'}">
            ${c.admits ? 'admitido' : c.status === 'sin-datos' ? 'sin datos' : 'excluido'}</span></div>
        <div class="layer-reason">${esc(c.reason)}</div>
      </div>
      <div class="row-val">${c.picks} picks</div>
    </div>`).join('');

  return `
  <div class="card">
    <div class="card-head"><h3>Capa de campeón</h3>
      <span class="muted-xs">solo winrates con 10+ picks</span></div>
    <div class="card-body">
      <div class="note">
        Winrate calculado sobre <strong>${state.metaIndex.gamesAttributable} de ${state.metaIndex.gamesCounted}</strong>
        mapas: la API expone el marcador de la serie, no el ganador de cada mapa, así que solo se
        atribuye resultado en series barridas. Ese subconjunto está sesgado hacia series decisivas.
        Los <strong>picks</strong> sí se cuentan sobre todos los mapas.
      </div>
      ${state.metaIndex.failures?.any ? `<div class="note note-warn">
        Lectura incompleta: de ${state.metaIndex.gamesTotal ?? '?'} mapas del torneo se leyeron
        ${state.metaIndex.gamesCounted}.
        ${state.metaIndex.failures.games ? `${state.metaIndex.failures.games} fallaron al descargar. ` : ''}
        ${state.metaIndex.failures.emptyDrafts ? `${state.metaIndex.failures.emptyDrafts} volvieron sin draft. ` : ''}
        ${state.metaIndex.failures.matches ? `${state.metaIndex.failures.matches} series no se pudieron leer. ` : ''}
        El n de abajo es menor de lo que debería y eso cambia los intervalos.
      </div>` : ''}
      <div style="margin-top:12px"><div class="muted-xs">${esc(blue.team)}</div>${side(la)}</div>
      <div style="margin-top:14px"><div class="muted-xs">${esc(red.team)}</div>${side(lb)}</div>
      <div style="margin-top:12px"><button class="btn btn-sm btn-outline" id="rebuild-meta">Reindexar</button></div>
    </div>
  </div>`;
}

function cardPlayerLayer(pa, pb, blue, red, ca, cb, rosterA, rosterB) {
  if (!pa) {
    return `<div class="card">
      <div class="card-head"><h3>Capa de jugador</h3></div>
      <div class="card-body"><p class="muted">Requiere indexar el torneo (botón en la capa de campeón).</p></div>
    </div>`;
  }
  const risks = [...stackedRisk(ca, pa), ...stackedRisk(cb, pb)];

  const isSub = (roster, p) =>
    roster?.known && roster.rows.find((r) => r.participantId === p.participantId)?.starter === false;

  const side = (l, roster) => l.map((p) => `
    <div class="layer-row">
      <div>
        <div><strong>${esc(p.name)}</strong> <span class="muted-xs">${esc(championName(p.champion))}</span>
          <span class="badge ${p.admits ? 'badge-ok' : p.status === 'observacion' ? 'badge-blue' : 'badge-no'}">
            ${p.admits ? 'entra' : p.status === 'observacion' ? 'observación' : 'sin datos'}</span>
          ${isSub(roster, p) ? '<span class="badge badge-warn">suplente</span>' : ''}</div>
        <div class="layer-reason">${esc(p.reason)}${isSub(roster, p)
          ? ' Está fuera del roster listado: sus pocas partidas se explican por eso, no por un pick raro.' : ''}</div>
      </div>
      <div class="row-val">${p.champGames}/${p.seasonGames}</div>
    </div>`).join('');

  return `
  <div class="card">
    <div class="card-head"><h3>Capa de jugador</h3>
      <span class="muted-xs">partidas con el campeón / totales en el torneo</span></div>
    <div class="card-body">
      <div style="margin-top:2px"><div class="muted-xs">${esc(blue.team)}</div>${side(pa, rosterA)}</div>
      <div style="margin-top:14px"><div class="muted-xs">${esc(red.team)}</div>${side(pb, rosterB)}</div>
      ${risks.map((r) => `<div class="note note-warn">${esc(r)}</div>`).join('')}
      <div class="note">
        El <strong>conteo de partidas</strong> es observación, no regla: acertó 5 veces seguidas y
        después falló en las dos direcciones el mismo día. El winrate solo entra con n≥10 y con el
        IC95 sin cruzar el 50%.
      </div>
    </div>
  </div>`;
}

function cardPatch(patch, blue, red) {
  const short = patch ? patch.split('.').slice(0, 2).join('.') : null;
  const d = state.patchDiff;

  let body;
  if (!d) {
    body = `
      <div style="margin-top:12px"><button class="btn" id="patch-diff">Comparar con el parche anterior</button></div>
      <div id="patch-progress"></div>
      <div class="note">Compara los datos de Data Dragon de los diez campeones entre esta versión y
        la anterior. Es un hecho verificable, no un changelog interpretado.</div>`;
  } else if (!d.versions) {
    body = `<div class="note note-warn">No se pudieron resolver dos versiones de Data Dragon para
      comparar contra ${esc(short ?? 'este parche')}.</div>`;
  } else {
    const changed = d.rows.filter((r) => r.changes.length);
    const unchanged = d.rows.filter((r) => !r.changes.length && !r.missing);
    body = `
      <div class="row"><span class="row-label">Comparación</span>
        <span class="row-val">${esc(d.versions.previous)} → ${esc(d.versions.current)}</span></div>
      ${!d.versions.matchedFeedPatch ? `<div class="note note-warn">Data Dragon no tiene una versión
        que coincida con ${esc(short)}; se usó la más reciente disponible. La comparación puede no
        ser la del parche que se está jugando.</div>` : ''}

      ${changed.length ? changed.map((r) => `
        <div class="edge-item">
          <div class="edge-title">${esc(championName(r.id))}
            <span class="badge badge-warn">${r.changes.length} cambio${r.changes.length === 1 ? '' : 's'}</span></div>
          ${r.changes.slice(0, 8).map((c) => `<div class="muted-xs">${esc(c.field)}: ${esc(c.from)} → ${esc(c.to)}</div>`).join('')}
          ${r.changes.length > 8 ? `<div class="muted-xs">…y ${r.changes.length - 8} más</div>` : ''}
        </div>`).join('')
        : `<p class="muted" style="margin-top:10px">Ninguno de los diez campeones cambió en los
             campos que Data Dragon expone.</p>`}

      ${unchanged.length ? `<div class="muted-xs" style="margin-top:10px">Sin cambios visibles:
        ${esc(unchanged.map((r) => championName(r.id)).join(', '))}</div>` : ''}
      ${d.unresolved.length ? `<div class="note note-warn">Sin resolver en Data Dragon:
        ${esc(d.unresolved.join(', '))}.</div>` : ''}
      ${d.failures ? `<div class="note note-warn">${d.failures} campeón(es) fallaron al descargar.
        La comparación está incompleta.</div>` : ''}

      <div class="note">
        <strong>Cobertura parcial, y hay que leerlo así.</strong> Data Dragon expone stats base,
        crecimiento por nivel y valores numéricos de habilidades. No expone cambios de
        comportamiento, interacción ni hitbox. Entonces "cambió" es un hecho, pero "no cambió"
        solo significa que no cambió nada de lo que Data Dragon muestra.
        Un rework reciente es incertidumbre, no ventaja ni desventaja.
      </div>`;
  }

  return `
  <div class="card">
    <div class="card-head"><h3>Parche</h3><span class="muted-xs">del feed, nunca de gol.gg</span></div>
    <div class="card-body">
      <div class="row"><span class="row-label">Versión del feed</span>
        <span class="row-val">${esc(patch ?? 'no disponible')}${short ? ` · lo que importa es <strong>${esc(short)}</strong>` : ''}</span></div>
      ${body}
    </div>
  </div>`;
}

function cardWindow(w) {
  if (!w.declared) {
    return `
    <div class="card">
      <div class="card-head"><h3>Ventana</h3></div>
      <div class="card-body">
        <p class="muted">Sin ventana declarada.</p>
        <div class="note note-warn">${esc(w.reason)}</div>
      </div>
    </div>`;
  }
  return `
  <div class="card">
    <div class="card-head"><h3>Ventana</h3><span class="muted-xs">punto de quiebre como rango</span></div>
    <div class="card-body">
      <div class="delta-hero">
        <div class="delta-num">${w.from}–${w.to}<span style="font-size:15px"> min</span></div>
        <div class="delta-meta">
          <div><strong>${esc(w.earlySide)}</strong> tiene la ventana corta · <strong>${esc(w.lateSide)}</strong> escala</div>
          <div class="muted-xs">Brecha de escalado: ${w.gapRaw} ${w.gapRaw === 1 ? 'punto crudo' : 'puntos crudos'}</div>
        </div>
      </div>
      <ul class="checklist">${w.claims.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <div class="note">El rango sale de la brecha de escalado de la tabla congelada. Es una
        heurística declarada, no una medición.</div>
    </div>
  </div>`;
}

function marketBlock(blue, red, entry) {
  const obs = entry?.market ?? [];
  const open = obs[0]?.p ?? null;
  const close = obs.length > 1 ? obs[obs.length - 1].p : null;
  const move = open != null && close != null ? close - open : null;

  return `
  <div class="market">
    <div class="muted-xs" style="margin-bottom:6px"><strong>Precio de mercado</strong> — la métrica
      oficial es CLV, no aciertos. Sin precio, la postura no se puede evaluar.</div>
    <div class="market-row">
      <label class="muted-xs">Cuota decimal de ${esc(blue.team)}
        <input type="number" step="0.01" min="1.01" id="odds-a" placeholder="1.85">
      </label>
      <label class="muted-xs">o probabilidad %
        <input type="number" step="1" min="1" max="99" id="pct-a" placeholder="54">
      </label>
      <button class="btn btn-sm" id="save-market">Registrar precio</button>
    </div>
    ${obs.length ? `
      <div class="row"><span class="row-label">Observaciones</span>
        <span class="row-val">${obs.length} · apertura ${(open * 100).toFixed(1)}%
          ${close != null ? ` · última ${(close * 100).toFixed(1)}%` : ''}</span></div>
      ${move != null ? `<div class="muted-xs">Movimiento del precio: ${move >= 0 ? '+' : ''}${(move * 100).toFixed(1)} puntos
        hacia ${move >= 0 ? esc(blue.team) : esc(red.team)}.</div>` : ''}
    ` : '<div class="muted-xs">Todavía sin precio registrado para este mapa.</div>'}
    <div class="market-row" style="margin-top:10px">
      <span class="muted-xs">Resultado del mapa:</span>
      <button class="btn btn-sm btn-outline" data-result="A">Ganó ${esc(blue.team)}</button>
      <button class="btn btn-sm btn-outline" data-result="B">Ganó ${esc(red.team)}</button>
      ${entry?.result ? `<span class="badge badge-ok">registrado: ${entry.result === 'A' ? esc(blue.team) : esc(red.team)}</span>` : ''}
    </div>
  </div>`;
}

function cardReading(score, prob, stance, blue, red, dis, entry) {
  const pa = prob.p, pb = 1 - pa;
  const comps = prob.components.map((c) => `
    <div class="comp-row">
      <div>
        <div><strong>${esc(c.label)}</strong>${c.missing ? ' <span class="badge badge-warn">ausente</span>' : ''}</div>
        <div class="muted-xs">${esc(c.detail)}</div>
        ${c.note ? `<div class="muted-xs" style="margin-top:3px">${esc(c.note)}</div>` : ''}
      </div>
      <div class="comp-contrib ${c.excluded ? 'zero' : c.contrib > 0 ? 'pos' : c.contrib < 0 ? 'neg' : 'zero'}">
        ${c.excluded ? '—' : `${c.contrib >= 0 ? '+' : ''}${c.contrib.toFixed(3)}`}
      </div>
    </div>`).join('');

  return `
  <div class="card">
    <div class="card-head"><h3>Lectura</h3>
      <span class="muted-xs">${prob.finished ? 'lectura previa, retrospectiva' : 'probabilidad construida por componentes'}</span></div>
    <div class="card-body">
      ${prob.finished ? `<div class="note">Este mapa ya terminó. El número de abajo es lo que decían
        <strong>la calidad de equipos y el draft antes de jugarse</strong>, no una predicción del
        resultado que ya conocés. El estado final está en la tarjeta de arriba.</div>` : ''}
      <div class="prob-hero" style="margin-top:${prob.finished ? '12px' : '0'}">
        <div class="prob-num">${(pa * 100).toFixed(0)}%</div>
        <div class="prob-bar">
          <span class="pa" style="width:${pa * 100}%">${esc(blue.team)}</span>
          <span class="pb" style="width:${pb * 100}%">${esc(red.team)}</span>
        </div>
      </div>
      ${prob.clamped ? `<div class="note note-warn">Número acotado a la banda [4%, 96%]: el modelo es
        lineal y crudo, y dejarlo llegar a los extremos sería fingir precisión.</div>` : ''}
      ${!prob.hasQuality ? `<div class="note note-warn">Falta el componente de calidad de equipos, que suele ser casi todo el margen. Este número vale mucho menos de lo que aparenta.</div>` : ''}
      <div style="margin-top:10px">${comps}</div>

      <div class="note ${dis.disagreement ? 'note-warn' : ''}" style="margin-top:14px">
        <strong>${dis.disagreement ? 'Desacuerdo entre capas' : 'Capas colineales'}.</strong> ${esc(dis.note)}
        <div class="muted-xs" style="margin-top:6px">
          ${dis.layers.map((l) => `${esc(l.name)} → ${esc(l.favors)}`).join(' · ') || 'Ninguna capa se pronuncia.'}
        </div>
      </div>

      ${marketBlock(blue, red, entry)}

      <div class="stance">
        <div class="stance-tag">${esc(stance.stance)}</div>
        <div class="muted-xs" style="margin-top:5px">${esc(stance.reason)}</div>
      </div>

      <div class="note ${entry?.prediction?.preGame ? 'note-ok' : 'note-warn'}" style="margin-top:12px">
        ${entry?.prediction
          ? `Predicción congelada el ${esc(new Date(entry.createdAt).toLocaleString('es'))} en
             <strong>${(entry.prediction.p * 100).toFixed(0)}%</strong>.
             ${entry.prediction.preGame
               ? 'Se registró antes de que el mapa avanzara, así que cuenta como predicción previa.'
               : 'El mapa ya estaba en curso al registrarla: NO cuenta como predicción previa limpia y se marca aparte en el registro.'}`
          : 'Sin registrar.'}
        Distinguí predicción <em>correcta</em> de predicción <em>informativa</em>: elegir al 8-2
        contra el 0-8 es correcto y no informa nada.
      </div>
    </div>
  </div>`;
}

function cardLiveState(st, minute, game) {
  const dg = st.a.gold - st.b.gold;
  const snap = snapshotLabel(minute);
  return `
  <div class="card">
    <div class="card-head">
      <h3>${game?.state === 'inProgress' ? 'Estado en vivo' : 'Estado final del mapa'}</h3>
      <span class="muted-xs">${minute ? `minuto ${minute.toFixed(0)}` : ''} · ${esc(st.state)}</span>
    </div>
    <div class="card-body">
      ${snap ? `<div class="note note-ok">${esc(snap)}: anotá el estado ahora, antes de saber el resultado.</div>` : ''}
      <div class="live-grid" style="margin-top:${snap ? '12px' : '0'}">
        <div class="stat"><div class="stat-k">Oro</div>
          <div class="stat-v">${st.a.gold.toLocaleString('es')} — ${st.b.gold.toLocaleString('es')}</div>
          <div class="muted-xs">Δ ${dg >= 0 ? '+' : ''}${dg.toLocaleString('es')} para ${esc(dg >= 0 ? st.a.team : st.b.team)}</div></div>
        <div class="stat"><div class="stat-k">Kills</div><div class="stat-v">${st.a.kills} — ${st.b.kills}</div></div>
        <div class="stat"><div class="stat-k">Torres</div><div class="stat-v">${st.a.towers} — ${st.b.towers}</div></div>
        <div class="stat"><div class="stat-k">Dragones / Barones</div>
          <div class="stat-v">${st.a.dragons.length}·${st.a.barons} — ${st.b.dragons.length}·${st.b.barons}</div></div>
      </div>
    </div>
  </div>`;
}

function cardSignals(st, minute, extra = []) {
  const sig = [...liveSignals(st), ...extra];
  return `
  <div class="card">
    <div class="card-head"><h3>Señales a verificar</h3>
      <span class="muted-xs">falsables, del minuto 14 al 20</span></div>
    <div class="card-body">
      ${sig.map((s) => `
        <div class="signal">
          <div class="signal-head">
            <span class="signal-label">${esc(s.label)}</span>
            <span class="signal-val">${esc(s.value)}</span>
          </div>
          <div class="signal-read">${esc(s.reading)}</div>
        </div>`).join('')}
    </div>
  </div>`;
}

function cardSignalsPreview() {
  const items = [
    'Diferencia de oro al minuto 20: menos de ~1k es empate, y el empate favorece a quien tiene mejor tardío.',
    'Kills sin ventaja de oro ni de nivel: pico gastado sin convertir.',
    'Nivel del ADC contra el ADC: un nivel en el tramo 15-20 pesa más que dos kills.',
    'CS alto con asistencias bajas: ese jugador farmea fuera de las peleas que deciden.',
    'Primer dragón y ritmo de alma.',
  ];
  return `
  <div class="card">
    <div class="card-head"><h3>Señales a verificar</h3><span class="muted-xs">cuando arranque el mapa</span></div>
    <div class="card-body"><ul class="checklist">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>
  </div>`;
}

function cardMatchupChecklist() {
  return `
  <div class="card">
    <div class="card-head"><h3>Checklist de matchup</h3><span class="muted-xs">relaciones estables entre parches</span></div>
    <div class="card-body">
      <ul class="checklist">${MATCHUP_CHECKLIST.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ *
 * interacción
 * ------------------------------------------------------------------ */

function bindGameTabs() {
  document.querySelectorAll('.game-tab').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.disabled) return;
      openMatch(state.matchId, { gameId: b.dataset.game });
    })
  );
}

function bindMetaButton() {
  const build = document.getElementById('build-meta');
  const rebuild = document.getElementById('rebuild-meta');
  if (build) build.addEventListener('click', () => runMetaIndex(build));
  if (rebuild) rebuild.addEventListener('click', () => {
    if (state.tournament?.id) clearIndexCache(state.tournament.id);
    state.metaIndex = null;
    runMetaIndex(rebuild);
  });
}

function bindPatchDiff(blue, red, patchVersion) {
  const btn = document.getElementById('patch-diff');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (state.patchDiffBusy) return;
    state.patchDiffBusy = true;
    btn.disabled = true;
    btn.textContent = 'Comparando…';
    const box = document.getElementById('patch-progress');
    const champs = [...blue.players, ...red.players].map((p) => p.champion);
    try {
      state.patchDiff = await diffChampions(champs, patchVersion, (done, total) => {
        if (box) {
          box.innerHTML = `<div class="muted-xs" style="margin-top:8px">Descargando ${done}/${total}</div>
            <div class="progress"><i style="width:${(done / total) * 100}%"></i></div>`;
        }
      });
      await openMatch(state.matchId, { force: true });
    } catch (e) {
      if (box) box.innerHTML = `<div class="err" style="margin-top:10px">No se pudo comparar: ${esc(e.message)}</div>`;
    } finally {
      state.patchDiffBusy = false;
      if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Comparar con el parche anterior'; }
    }
  });
}

function bindMarketAndResult(blue, red) {
  const save = document.getElementById('save-market');
  if (save) {
    save.addEventListener('click', () => {
      const odds = parseFloat(document.getElementById('odds-a')?.value);
      const pct = parseFloat(document.getElementById('pct-a')?.value);
      let p = null;
      if (Number.isFinite(odds) && odds > 1) p = 1 / odds;
      else if (Number.isFinite(pct) && pct > 0 && pct < 100) p = pct / 100;
      if (p == null) {
        alert('Cargá una cuota decimal mayor a 1 o un porcentaje entre 1 y 99.');
        return;
      }
      ledger.recordMarket(state.gameId, p);
      openMatch(state.matchId, { force: true });
    });
  }
  document.querySelectorAll('[data-result]').forEach((b) =>
    b.addEventListener('click', () => {
      ledger.recordResult(state.gameId, b.dataset.result);
      openMatch(state.matchId, { force: true });
    })
  );
}

/* ------------------------------------------------------------------ *
 * registro
 * ------------------------------------------------------------------ */

function renderLedger() {
  const s = ledger.summary();
  const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

  const metric = (label, value, note) => `
    <div class="stat"><div class="stat-k">${esc(label)}</div>
      <div class="stat-v">${value}</div>
      ${note ? `<div class="muted-xs">${esc(note)}</div>` : ''}</div>`;

  const rows = s.entries.slice(0, 60).map((e) => `
    <div class="layer-row">
      <div>
        <div><strong>${esc(e.teamA)} vs ${esc(e.teamB)}</strong>
          <span class="muted-xs">${esc(e.league ?? '')} · mapa ${e.gameNumber ?? '?'}</span>
          ${e.prediction?.preGame ? '<span class="badge badge-ok">previa</span>' : '<span class="badge badge-warn">en curso</span>'}
          ${e.result ? `<span class="badge badge-blue">ganó ${e.result === 'A' ? esc(e.teamA) : esc(e.teamB)}</span>` : ''}
        </div>
        <div class="layer-reason">
          ${esc(new Date(e.createdAt).toLocaleString('es'))} ·
          modelo ${(e.prediction.p * 100).toFixed(0)}% ·
          Δ ${e.prediction.tfDelta != null ? e.prediction.tfDelta.toFixed(2) + ' sd' : '—'}
          ${Object.keys(e.snapshots ?? {}).length ? ` · snapshots: ${Object.keys(e.snapshots).join(', ')} min` : ''}
          ${e.market?.length ? ` · mercado ${(e.market[0].p * 100).toFixed(0)}%→${(e.market[e.market.length - 1].p * 100).toFixed(0)}%` : ''}
        </div>
      </div>
      <button class="btn btn-sm btn-outline" data-del="${esc(e.gameId)}">borrar</button>
    </div>`).join('');

  $('#content').innerHTML = `
  <div class="card">
    <div class="card-head"><h3>Registro de predicciones</h3>
      <span class="muted-xs">la calibración solo se construye con predicciones escritas antes</span></div>
    <div class="card-body">
      <div class="live-grid">
        ${metric('Registradas', s.total, `${s.resolved} con resultado`)}
        ${metric('Brier (todas)', s.brierAll ? s.brierAll.brier.toFixed(4) : '—',
          s.brierAll ? `n=${s.brierAll.n} · 0.25 = predecir 50% siempre` : 'hace falta cargar resultados')}
        ${metric('Brier (solo previas)', s.brierPreGame ? s.brierPreGame.brier.toFixed(4) : '—',
          s.brierPreGame ? `n=${s.brierPreGame.n}` : 'sin predicciones previas resueltas')}
        ${metric('Aciertos', s.hits ? `${s.hits.hits}/${s.hits.n}` : '—',
          s.hits ? `${pct(s.hits.rate)} — correcto no es informativo` : '')}
        ${metric('Anticipó el movimiento', s.clv ? `${s.clv.anticipated}/${s.clv.n}` : '—',
          s.clv ? `${pct(s.clv.rate)} · proxy de CLV` : 'hace falta apertura y cierre de precio')}
      </div>

      <div class="note">
        La referencia del backtest es <strong>Brier 0.2368 propio contra 0.2353 del mercado</strong>,
        con λ*=0. Si tu Brier no baja de eso de forma sostenida, el número propio no está aportando
        sobre el precio y la postura NO BET sigue siendo la correcta.
      </div>

      <div style="margin:14px 0; display:flex; gap:8px; flex-wrap:wrap">
        <button class="btn btn-sm" id="exp-json">Exportar JSON</button>
        <button class="btn btn-sm" id="exp-csv">Exportar CSV</button>
        <button class="btn btn-sm btn-outline" id="ledger-clear">Vaciar registro</button>
      </div>

      ${rows || '<p class="muted">Todavía no hay predicciones registradas. Se guardan solas al abrir un mapa.</p>'}
    </div>
  </div>`;

  document.getElementById('exp-json')?.addEventListener('click', () =>
    download('checkmatch-registro.json', ledger.exportJSON(), 'application/json'));
  document.getElementById('exp-csv')?.addEventListener('click', () =>
    download('checkmatch-registro.csv', ledger.exportCSV(), 'text/csv'));
  document.getElementById('ledger-clear')?.addEventListener('click', () => {
    if (confirm('¿Vaciar todo el registro? Se pierden las predicciones guardadas.')) {
      ledger.clearLedger();
      renderLedger();
    }
  });
  document.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => { ledger.deleteEntry(b.dataset.del); renderLedger(); })
  );
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function runMetaIndex(btn) {
  if (state.metaBuilding) return;
  state.metaBuilding = true;
  btn.disabled = true;
  btn.textContent = 'Indexando…';
  const box = document.getElementById('meta-progress')
    ?? btn.parentElement.appendChild(Object.assign(document.createElement('div'), { id: 'meta-progress' }));

  try {
    state.metaIndex = await buildTournamentIndex(state.league.id, state.tournament, {
      onProgress: ({ label, done, total }) => {
        const pct = total ? (done / total) * 100 : 0;
        box.innerHTML = `<div class="muted-xs" style="margin-top:8px">${esc(label)} ${done}/${total || '?'}</div>
                         <div class="progress"><i style="width:${pct}%"></i></div>`;
      },
    });
    await openMatch(state.matchId, { force: true });
  } catch (e) {
    box.innerHTML = `<div class="err" style="margin-top:10px">No se pudo indexar: ${esc(e.message)}</div>`;
  } finally {
    state.metaBuilding = false;
    if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Indexar torneo'; }
  }
}

init();
