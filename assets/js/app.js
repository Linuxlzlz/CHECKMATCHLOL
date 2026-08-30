/**
 * app.js — orquestador de la UI.
 *
 * El informe se arma en el mismo orden que el formato de salida del skill, de
 * lo más duro a lo más interpretativo: draft, índice, concentración, capa de
 * campeón, capa de jugador, parche, ventana, lectura, señales.
 */

import {
  LEAGUES, getSchedule, getLive, getEventDetails, getStandings, getCurrentTournament,
  getRecentTournaments,
  getWindow, getDetails, feedTimestamp, initDDragon, championIcon, championName, secure,
  getRosterIndex, itemIcon,
} from './api.js';
import {
  CHECKPOINTS, stateAtMinute, mergePlayers, roleGoldDiff, goldConcentration, detailSignals,
} from './engine/checkpoints.js';
import * as ledger from './engine/ledger.js';
import { diffChampions } from './engine/patchdiff.js';
import {
  scoreDraft, classificationOf, setManualProfile, profileRow, AXES,
  setMeasuredThresholds, setSiegeVerdict, RAW_NARRATABLE_MIN,
} from './engine/index-score.js';
import {
  structuralAxes, laneMatchups, concentrationAndWindow, NON_COMPUTABLE_AXES,
  MATCHUP_CHECKLIST, ROLE_LABEL,
} from './engine/structural.js';
import { readState, liveSignals, gameMinute, snapshotLabel } from './engine/live.js';
import {
  buildProbability, bettingStance, layerDisagreement, draftWeightFrom, draftWeightConditional,
} from './engine/probability.js';
import {
  evaluate as evaluateModels, readEvaluation, championScaling, championFighting,
} from './engine/discovery.js';
import * as wire from './engine/wire.js';
import { intentUrl, teamTag } from './engine/tweet.js';
import {
  buildTournamentIndex, championLayer, playerLayer, stackedRisk, clearIndexCache, rosterCheck,
  cachedIndices, aggregateIndices,
} from './engine/meta.js';
import { buildElo, eloFor, eloLogOdds } from './engine/elo.js';
import { finalStateOf, resolveSeries, METHOD_LABEL } from './engine/outcome.js';
import { collectDiagnostics } from './engine/diagnostics.js';
import {
  initRiotProfiles, fetchProfiles, profileFor, riotAxes, crossCheck, suggestArchetype,
  riotAvailable,
} from './engine/riot-profile.js';
import { validateIndex, validateAcross, readValidation } from './engine/validation.js';

const $ = (s) => document.querySelector(s);

/**
 * Pestaña virtual "En vivo": junta los partidos en curso de TODAS las ligas.
 *
 * Con 15 ligas configuradas, un partido en curso en LJL o LRS es invisible
 * salvo que uno adivine en qué pestaña mirar. Esto lo pone en un solo lugar.
 *
 * No es una liga de verdad: no tiene calendario ni torneo ni standings. La
 * lista sale de getLive(), que ya se consulta cada 20 segundos para el
 * indicador de la cabecera.
 */
const LIVE_KEY = 'LIVE';
const LIVE_TAB = { key: LIVE_KEY, id: null, name: 'En vivo', region: 'todas las ligas' };
const esEnVivo = (l) => l?.key === LIVE_KEY;

/** Las ligas de la barra: la virtual primero, después las reales. */
const TABS = [LIVE_TAB, ...LEAGUES];


/**
 * Tabla de Elo del corpus entero, memoizada.
 *
 * Los mapas se deduplican por gameId porque los índices de distintos torneos
 * pueden solaparse, y un mapa contado dos veces movería el rating el doble.
 */
let _elo = null;
let _eloFirma = '';
function eloTable() {
  const idx = cachedIndices();
  const firma = idx.map((i) => `${i.tournamentId ?? i.id ?? ''}:${(i.maps || []).length}`).join('|');
  if (_elo && firma === _eloFirma) return _elo;
  const vistos = new Set();
  const maps = [];
  for (const i of idx) {
    for (const m of i.maps || []) {
      if (!m.gameId || vistos.has(m.gameId)) continue;
      vistos.add(m.gameId);
      maps.push(m);
    }
  }
  _elo = buildElo(maps);
  _eloFirma = firma;
  return _elo;
}
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const AXIS_LABEL = {
  teamfight: 'Teamfight', pick: 'Pick', split: 'Split', siege: 'Asedio', scaling: 'Escalado',
};

const state = {
  league: LEAGUES[0],
  liveNuestras: 0,
  ligaVivo: null,
  tournament: null,
  events: [],
  olderToken: null,
  loadingMore: false,
  search: '',
  liveIds: new Set(),
  view: 'match',
  matchId: null,
  gameId: null,
  detail: null,
  standings: null,
  standingsPromise: null,
  metaIndex: null,
  metaBuilding: false,
  metaProgress: null,
  autoIndexTried: new Set(),
  globalIndex: null,
  rosters: null,
  patchDiff: null,
  patchDiffBusy: false,
  seriesOutcome: null,
  diagnostics: null,
  patchDiffKey: null,
  fixAll: null,
  // Función oculta: el vigilante que arma los tweets. Se enciende entrando a
  // #/wire y queda encendido en el navegador hasta que se apague.
  wireOn: (() => { try { return localStorage.getItem('cml:wire:on') === '1'; } catch { return false; } })(),
  wireBusy: false,
  wireLast: null,
};

/* ------------------------------------------------------------------ *
 * ruta: la URL es el estado, para que recargar no pierda el partido
 * ------------------------------------------------------------------ */

const LAST_ROUTE_KEY = 'cml:route:v1';

function routeHash() {
  if (state.view === 'ledger') return '#/registro';
  if (state.view === 'wire') return '#/wire';
  return '#/' + [state.league.key, state.matchId, state.gameId].filter(Boolean).join('/');
}

/** Escribe la ruta actual en la URL y la recuerda para la próxima visita. */
function syncRoute({ push = false } = {}) {
  const h = routeHash();
  if (location.hash !== h) {
    if (push) history.pushState(null, '', h);
    else history.replaceState(null, '', h);
  }
  try { localStorage.setItem(LAST_ROUTE_KEY, h); } catch { /* modo privado */ }
}

function parseRoute(hash) {
  const parts = (hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === 'registro') return { view: 'ledger' };
  // Ruta oculta: no está enlazada en ningún lado, se llega escribiéndola.
  if (parts[0] === 'wire') return { view: 'wire' };
  const league = TABS.find((l) => l.key === parts[0]);
  if (!league) return null;
  return { view: 'match', league, matchId: parts[1] ?? null, gameId: parts[2] ?? null };
}

/**
 * Aplica la ruta de la URL. Se usa al arrancar y en atrás/adelante del
 * navegador, que es lo que hace que el sitio se sienta navegable en vez de una
 * sola pantalla que se reinicia.
 */
async function applyRoute(r) {
  if (!r) return;
  if (r.view === 'ledger') {
    state.view = 'ledger';
    state.matchId = null;
    renderMatchList();
    renderLedger();
    return;
  }
  if (r.view === 'wire') {
    state.view = 'wire';
    state.matchId = null;
    state.wireOn = true;
    renderMatchList();
    renderWire();
    wireTick();
    return;
  }
  state.view = 'match';
  const leagueChanged = r.league.key !== state.league.key;
  state.league = r.league;
  if (leagueChanged) {
    state.metaIndex = null;
    renderLeagues();
    await loadLeague(state.league, { keepMatch: true });
  }
  if (r.matchId) await openMatch(r.matchId, { gameId: r.gameId, fromRoute: true });
  else $('#content').innerHTML = emptyState();
}

/* ------------------------------------------------------------------ *
 * arranque
 * ------------------------------------------------------------------ */

async function init() {
  renderLeagues();
  $('#refresh').addEventListener('click', () => {
    if (state.view === 'ledger') renderLedger();
    else if (state.matchId) openMatch(state.matchId, { force: true });
    else loadLeague(state.league);
  });
  $('#open-ledger').addEventListener('click', () => {
    state.view = 'ledger';
    state.matchId = null;
    syncRoute({ push: true });
    renderMatchList();
    renderLedger();
  });

  window.addEventListener('popstate', () => applyRoute(parseRoute(location.hash)));
  window.addEventListener('hashchange', () => {
    const r = parseRoute(location.hash);
    if (r && r.matchId !== state.matchId) applyRoute(r);
  });

  await Promise.all([initDDragon(), initRiotProfiles()]);

  // La ruta manda; si no hay, se recupera la última visitada.
  let route = parseRoute(location.hash);
  if (!route) {
    try { route = parseRoute(localStorage.getItem(LAST_ROUTE_KEY)); } catch { route = null; }
  }
  if (route?.view === 'match') state.league = route.league;

  state.globalIndex = aggregateIndices(cachedIndices());
  await loadLeague(state.league, { keepMatch: !!route });
  renderLeagues();

  if (route) await applyRoute(route);
  else syncRoute();

  pollLive();
  setInterval(pollLive, 20_000);
}

function renderLeagues() {
  $('#leagues').innerHTML = TABS.map((l) => {
    const activa = l.key === state.league.key;
    // La pestaña de en vivo lleva el contador de partidos en curso, para que se
    // vea que hay algo pasando sin tener que entrar.
    const n = esEnVivo(l) ? (state.liveNuestras ?? 0) : 0;
    const marca = esEnVivo(l)
      ? `<span class="reg">${n ? `${n} en curso` : 'nada ahora'}</span>`
      : `<span class="reg">${esc(l.region)}</span>`;
    return `<button class="league-btn${activa ? ' active' : ''}${esEnVivo(l) ? ' league-live' : ''}${esEnVivo(l) && n ? ' hay-vivo' : ''}"
              data-key="${l.key}">${esc(l.name)}${marca}</button>`;
  }).join('');
  $('#leagues').querySelectorAll('.league-btn').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.key === state.league.key) return;
      state.league = TABS.find((l) => l.key === b.dataset.key);
      state.view = 'match';
      state.matchId = null;
      state.gameId = null;
      state.metaIndex = null;
      renderLeagues();
      syncRoute({ push: true });
      loadLeague(state.league);
      // El indicador de la cabecera depende de la pestaña abierta; sin esto se
      // queda con el texto de la anterior hasta el próximo poll (20 s).
      pollLive();
      $('#content').innerHTML = emptyState();
    })
  );
}

const emptyState = () => `
  <div class="empty-state">
    <div class="empty-mark">🎯</div>
    <h2>${esEnVivo(state.league)
      ? 'Elegí un partido en curso'
      : `Elegí un partido de ${esc(state.league.name)}`}</h2>
    <p>El análisis se arma con el draft real del feed oficial.</p>
  </div>`;

/* ------------------------------------------------------------------ *
 * liga y lista de partidos
 * ------------------------------------------------------------------ */

async function loadLeague(league, { keepMatch = false } = {}) {
  $('#league-title').textContent = league.name;
  $('#tournament-label').textContent = 'cargando…';
  if (!keepMatch) {
    $('#match-list').innerHTML = `<div class="skeleton-list"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;
  }

  // Vista en vivo: no hay calendario ni torneo que pedir. La lista sale de
  // getLive(), que ya se consulta cada 20 s para el indicador de la cabecera.
  if (esEnVivo(league)) {
    state.tournament = null;
    state.olderToken = null;
    state.standings = null;
    state.standingsPromise = Promise.resolve(null);
    await cargarEnVivo();
    return;
  }

  try {
    const [sched, tournament] = await Promise.all([
      getSchedule(league.id),
      getCurrentTournament(league.id).catch(() => null),
    ]);
    state.tournament = tournament;
    state.events = sched?.data?.schedule?.events ?? [];
    state.olderToken = sched?.data?.schedule?.pages?.older ?? null;
    $('#tournament-label').textContent = tournament?.slug
      ? tournament.slug.replace(/_/g, ' ')
      : 'torneo no identificado';

    // Los standings son el componente que más pesa en la probabilidad. Antes se
    // pedían sin esperar, así que el primer render congelaba la predicción en el
    // registro SIN calidad de equipos y esa entrada quedaba coja para siempre.
    // Ahora la promesa se guarda y renderMatch la espera antes de calcular.
    state.standings = null;
    state.standingsPromise = tournament?.id
      ? getStandings(tournament.id)
          .then((s) => { state.standings = s; return s; })
          .catch(() => { state.standings = null; return null; })
      : Promise.resolve(null);

    renderMatchList();
    autoIndex();
  } catch (e) {
    $('#match-list').innerHTML = `<div class="card-body"><div class="err">No se pudo cargar el calendario: ${esc(e.message)}</div></div>`;
  }
}


/**
 * Arma la lista de la vista "En vivo" con los partidos en curso de todas las
 * ligas configuradas. Los eventos de getLive() traen su propia liga, así que se
 * guarda para poder mostrarla en cada fila: en esta vista están mezcladas.
 */
// Etiqueta del encabezado en la pestaña de en vivo.
function etiquetaVivo(n) {
  return n ? `${n} partido${n === 1 ? '' : 's'} en curso` : 'ninguna liga con partidos ahora';
}

async function cargarEnVivo() {
  try {
    const data = await getLive();
    const evs = (data?.data?.schedule?.events ?? [])
      .filter((e) => e.match?.teams?.length === 2)
      .filter((e) => LEAGUES.some((l) => l.id === e.league?.id));
    state.events = evs;
    state.liveNuestras = evs.length;
    $('#tournament-label').textContent = etiquetaVivo(evs.length);
    renderLeagues();
    renderMatchList();
  } catch (e) {
    $('#match-list').innerHTML =
      `<div class="card-body"><div class="err">No se pudo leer el estado en vivo: ${esc(e.message)}</div></div>`;
  }
}
/** Trae una página más de calendario hacia atrás. */
async function loadOlder() {
  if (!state.olderToken || state.loadingMore) return;
  state.loadingMore = true;
  renderMatchList();
  try {
    const sched = await getSchedule(state.league.id, state.olderToken);
    const evs = sched?.data?.schedule?.events ?? [];
    const seen = new Set(state.events.map((e) => e.match?.id));
    state.events = [...evs.filter((e) => e.match?.id && !seen.has(e.match.id)), ...state.events];
    state.olderToken = sched?.data?.schedule?.pages?.older ?? null;
  } catch { /* el botón vuelve a estar disponible */ } finally {
    state.loadingMore = false;
    renderMatchList();
  }
}

function renderMatchList() {
  const q = state.search.trim().toLowerCase();
  const matches = (e) =>
    !q ||
    (e.match?.teams ?? []).some(
      (t) => (t.code ?? '').toLowerCase().includes(q) || (t.name ?? '').toLowerCase().includes(q)
    ) ||
    (e.blockName ?? '').toLowerCase().includes(q);

  const evs = state.events.filter((e) => e.match?.teams?.length === 2).filter(matches);
  const live = [], upcoming = [], done = [];
  for (const e of evs) {
    if (e.state === 'inProgress' || state.liveIds.has(e.match.id)) live.push(e);
    else if (e.state === 'completed') done.push(e);
    else upcoming.push(e);
  }
  done.reverse();

  const vivo = esEnVivo(state.league);
  const groups = vivo
    ? [['En vivo, todas las ligas', evs]].filter(([, arr]) => arr.length)
    : [
        ['En vivo', live],
        ['Próximos', upcoming.slice(0, 15)],
        ['Terminados', done],
      ].filter(([, arr]) => arr.length);

  const head = `
    <div class="list-tools">
      <input id="match-search" class="search" type="search" placeholder="Filtrar por equipo…"
             value="${esc(state.search)}" autocomplete="off">
      <span class="muted-xs">${evs.length} partido${evs.length === 1 ? '' : 's'}</span>
    </div>`;

  const body = groups.length
    ? groups.map(([label, arr]) => `
        <div class="group-label">${label}<span class="group-n">${arr.length}</span></div>
        ${arr.map((e) => matchItem(e, vivo || label === 'En vivo', vivo)).join('')}`).join('')
    : vivo
      ? `<div class="card-body"><p class="muted-xs">No hay partidos en curso en ninguna de las 15 ligas.
           Esta lista se actualiza sola cada 20 segundos.</p></div>`
      : `<div class="card-body"><p class="muted-xs">Sin partidos que coincidan.</p></div>`;

  const more = vivo
    ? ''
    : state.olderToken
    ? `<button class="btn btn-sm btn-outline list-more" id="load-older" ${state.loadingMore ? 'disabled' : ''}>
         ${state.loadingMore ? 'Cargando…' : 'Cargar partidos anteriores'}</button>`
    : `<div class="muted-xs list-more">No hay más partidos hacia atrás en el calendario.</div>`;

  $('#match-list').innerHTML = head + body + more;

  const input = $('#match-search');
  input?.addEventListener('input', () => {
    state.search = input.value;
    const pos = input.selectionStart;
    renderMatchList();
    const again = $('#match-search');
    again.focus();
    again.setSelectionRange(pos, pos);
  });
  $('#load-older')?.addEventListener('click', loadOlder);
  $('#match-list').querySelectorAll('.match-item').forEach((b) =>
    b.addEventListener('click', () => openMatch(b.dataset.id, { push: true }))
  );
}

function matchItem(e, isLive, conLiga = false) {
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
        ${conLiga && e.league?.name ? `<span class="liga-tag">${esc(e.league.name)}</span>` : ''}
        ${score}
        <span>${esc(e.blockName ?? '')}</span>
      </div>
    </button>`;
}

/**
 * Reemplaza el informe conservando lo que el usuario tenía en pantalla.
 *
 * El partido en vivo se refresca solo cada 20 s, y hasta ahora ese refresco
 * pisaba el scroll, las secciones que habías abierto y la cuota que estabas
 * escribiendo. Un panel que se reinicia solo mientras lo leés es inservible
 * justo cuando más sirve, que es con el mapa en curso.
 */
/**
 * Agrupa tarjetas detrás de un plegable.
 *
 * La vista de un partido llegó a tener 20 tarjetas, 27.000 caracteres y unos
 * 800 números en pantalla a la vez. Nada de eso sobra —está todo medido y cada
 * número se ganó su lugar— pero puesto todo junto no se lee: lo importante
 * queda enterrado entre la auditoría del modelo.
 *
 * La solución no es borrar mediciones sino ordenarlas por a quién le sirven:
 * arriba y abierto lo que contesta "qué va a pasar y por qué", plegado lo que
 * contesta "¿y esto cuánto vale?". Un clic de distancia, no un dato menos.
 *
 * setContent() recuerda qué grupos quedaron abiertos, así que el refresco en
 * vivo no los cierra en la cara del que estaba leyendo.
 */
function grupo(k, titulo, resumen, contenido, open = false) {
  const cuerpo = (Array.isArray(contenido) ? contenido : [contenido]).filter(Boolean).join('');
  if (!cuerpo) return '';
  return `
  <details class="grupo" data-k="${esc(k)}"${open ? ' open' : ''}>
    <summary>
      <span class="grupo-t">${esc(titulo)}</span>
      <span class="grupo-r">${esc(resumen)}</span>
      <span class="grupo-x" aria-hidden="true"></span>
    </summary>
    <div class="grupo-body">${cuerpo}</div>
  </details>`;
}

function setContent(html, { preserve = false } = {}) {
  const el = $('#content');
  if (!preserve) {
    el.innerHTML = html;
    return;
  }
  const scroll = window.scrollY;
  const openState = new Map();
  el.querySelectorAll('details[data-k]').forEach((d) => openState.set(d.dataset.k, d.open));
  const values = new Map();
  el.querySelectorAll('input[id]').forEach((i) => { if (i.value) values.set(i.id, i.value); });
  const activeId = document.activeElement?.id ?? null;
  const selStart = document.activeElement?.selectionStart ?? null;

  el.innerHTML = html;

  el.querySelectorAll('details[data-k]').forEach((d) => {
    if (openState.has(d.dataset.k)) d.open = openState.get(d.dataset.k);
  });
  el.querySelectorAll('input[id]').forEach((i) => {
    if (values.has(i.id)) i.value = values.get(i.id);
  });
  if (activeId) {
    const again = document.getElementById(activeId);
    if (again) {
      // Sin preventScroll, devolver el foco arrastra la página hasta el input.
      again.focus({ preventScroll: true });
      if (selStart != null && again.setSelectionRange) {
        try { again.setSelectionRange(selStart, selStart); } catch { /* type sin selección */ }
      }
    }
  }
  // Después del layout: si se restaura antes, el alto todavía no es el final y
  // el navegador recorta la posición.
  window.scrollTo(0, scroll);
  requestAnimationFrame(() => window.scrollTo(0, scroll));
}

async function pollLive() {
  try {
    const data = await getLive();
    const evs = (data?.data?.schedule?.events ?? []).filter((e) => e.match?.teams?.length === 2);
    const nuestras = evs.filter((e) => LEAGUES.some((l) => l.id === e.league?.id));
    const before = [...state.liveIds].sort().join(',');
    state.liveIds = new Set(evs.filter((e) => e.match?.id).map((e) => e.match.id));
    const changed = before !== [...state.liveIds].sort().join(',');
    const vivo = esEnVivo(state.league);
    const mine = vivo ? nuestras : evs.filter((e) => e.league?.id === state.league.id);
    const pill = $('#live-pill');
    pill.hidden = false;
    if (mine.length) {
      pill.className = 'pill pill-live';
      pill.textContent = vivo
        ? `${mine.length} en vivo ahora`
        : `${mine.length} en vivo en ${state.league.name}`;
    } else if (evs.length) {
      pill.className = 'pill pill-idle';
      pill.textContent = `${evs.length} en vivo en otras ligas`;
    } else {
      pill.className = 'pill pill-idle';
      pill.textContent = 'sin partidos en vivo';
    }
    // El contador de la pestaña "En vivo" solo cuenta las ligas que seguimos.
    if (state.liveNuestras !== nuestras.length) {
      state.liveNuestras = nuestras.length;
      renderLeagues();
    }
    // Estando en la pestaña de en vivo, la lista ES el resultado del poll.
    if (vivo) {
      state.events = nuestras;
      $('#tournament-label').textContent = etiquetaVivo(nuestras.length);
    }
    // No repintar la lista mientras se escribe en el filtro: perdería el foco.
    if ((changed || vivo) && document.activeElement?.id !== 'match-search') renderMatchList();
    // Si el partido abierto está en vivo, refrescamos su estado.
    if (state.view === 'match' && state.matchId && state.liveIds.has(state.matchId)) {
      openMatch(state.matchId, { quiet: true });
    }
    if (state.wireOn) wireTick();
  } catch { /* el poll no debe romper la vista */ }
}

/* ------------------------------------------------------------------ *
 * wire: la función oculta que arma los tweets
 * ------------------------------------------------------------------ */

/** Récords para el componente de calidad, desde el índice ya construido. */
function recordFor(teamIdA, teamIdB) {
  const find = (id) => {
    for (const idx of cachedIndices()) {
      const t = idx.teams?.[id];
      if (t?.attributed >= 4) return { wins: t.wins, losses: t.attributed - t.wins };
    }
    return null;
  };
  return { a: find(teamIdA), b: find(teamIdB) };
}

async function wireTick() {
  if (!state.wireOn || state.wireBusy) return;
  state.wireBusy = true;
  try {
    const added = await wire.tick({ recordFor });
    state.wireLast = { at: Date.now(), added };
    const pending = wire.queue().filter((p) => !p.posted).length;
    const pill = $('#wire-pill');
    if (pill) {
      pill.hidden = !pending;
      pill.textContent = `${pending} sin publicar`;
      pill.className = pending ? 'pill pill-live' : 'pill pill-idle';
    }
    if (added && state.view === 'wire') renderWire();
  } catch { /* el vigilante no debe romper la vista */ } finally {
    state.wireBusy = false;
  }
}

function renderWire() {
  const posts = wire.queue();
  const pendientes = posts.filter((p) => !p.posted).length;

  const card = (p) => {
    const chars = p.text.length;
    const mvp = p.mvp;
    return `
    <div class="card wire-post${p.posted ? ' done' : ''}">
      <div class="card-head">
        <h3>${p.kind === 'pre' ? '🔴 Arranque' : '✅ Cierre'} · ${esc(p.teams)}${p.gameNumber ? ` · Mapa ${p.gameNumber}` : ''}</h3>
        <span class="muted-xs">${esc(p.league ?? '')} · ${esc(new Date(p.createdAt).toLocaleString('es'))}</span>
      </div>
      <div class="card-body">
        <div class="tweet-card">
          <div class="tweet-logos">
            ${(p.logos ?? []).filter(Boolean).map((l) => `<img src="${esc(l)}" alt="">`).join('')}
            ${mvp?.photo ? `<img class="tweet-mvp" src="${esc(mvp.photo)}" alt="">` : ''}
          </div>
          <pre class="tweet-text">${esc(p.text)}</pre>
          <div class="tweet-meta">
            <span class="${chars > 280 ? 'warn-txt' : 'muted-xs'}">${chars}/280</span>
            ${p.posted ? '<span class="badge badge-ok">publicado</span>' : ''}
          </div>
        </div>

        ${mvp ? `
          <div class="mvp-box">
            <div class="mvp-head">
              ${mvp.photo ? `<img src="${esc(mvp.photo)}" alt="">` : ''}
              <div>
                <div><strong>${esc(mvp.name)}</strong> · ${esc(championName(mvp.champion))} · ${esc(mvp.team)}</div>
                <div class="muted-xs">${esc(mvp.kda)} · ${(mvp.damageShare * 100).toFixed(0)}% del daño ·
                  ${(mvp.killParticipation * 100).toFixed(0)}% de participación ·
                  ${mvp.gold?.toLocaleString('es') ?? '—'} de oro</div>
              </div>
              <div class="mvp-rating">${mvp.rating.toFixed(1)}<span>/10</span></div>
            </div>
            <div class="muted-xs">${mvp.components.map((c) => `${esc(c.label)}: ${esc(c.value)}`).join(' · ')}</div>
            <div class="note">La calificación es un número inventado y acá se dice: los pesos son
              juicio propio, no están validados contra nada y no entran en ninguna probabilidad ni
              en el registro. Es una etiqueta editorial, no una predicción.</div>
          </div>` : ''}

        <div class="wire-actions">
          <a class="btn btn-sm" href="${esc(intentUrl(p.text))}" target="_blank" rel="noopener"
             data-posted="${esc(p.id)}">Abrir en X</a>
          <button class="btn btn-sm btn-outline" data-copy="${esc(p.id)}">Copiar texto</button>
          ${(p.media ?? []).filter(Boolean).map((m, i) =>
            `<a class="btn btn-sm btn-outline" href="${esc(m)}" target="_blank" rel="noopener">Imagen ${i + 1}</a>`).join('')}
          <button class="btn btn-sm btn-outline" data-toggle="${esc(p.id)}">${p.posted ? 'Marcar sin publicar' : 'Marcar publicado'}</button>
          <button class="btn btn-sm btn-outline" data-drop="${esc(p.id)}">Descartar</button>
        </div>
      </div>
    </div>`;
  };

  setContent(`
    <div class="card">
      <div class="card-head"><h3>Wire</h3>
        <span class="muted-xs">función oculta · no está enlazada desde ninguna parte</span></div>
      <div class="card-body">
        <div class="live-grid">
          <div class="stat"><div class="stat-k">Vigilancia</div>
            <div class="stat-v ${state.wireOn ? 'ok-txt' : 'warn-txt'}">${state.wireOn ? 'encendida' : 'apagada'}</div>
            <div class="muted-xs">revisa las 6 ligas cada 20 s</div></div>
          <div class="stat"><div class="stat-k">En cola</div>
            <div class="stat-v">${posts.length}</div>
            <div class="muted-xs">${pendientes} sin publicar</div></div>
          <div class="stat"><div class="stat-k">Última pasada</div>
            <div class="stat-v small">${state.wireLast ? esc(new Date(state.wireLast.at).toLocaleTimeString('es')) : '—'}</div>
            <div class="muted-xs">${state.wireLast ? `${state.wireLast.added} nuevas` : 'sin correr todavía'}</div></div>
        </div>

        <div class="note note-warn">
          <strong>Esto arma los tweets, no los publica.</strong> Un sitio estático no puede postear
          en X: la API pide OAuth con secretos de servidor, y cualquier cosa embarcada acá la lee
          quien abra el código. Cada entrada queda lista con su texto y sus imágenes; el último paso
          es tuyo. Para que sea automático de punta a punta hace falta un worker con tus
          credenciales — está explicado en el README.
        </div>

        <div class="wire-actions" style="margin-top:12px">
          <button class="btn btn-sm" id="wire-toggle">${state.wireOn ? 'Apagar vigilancia' : 'Encender vigilancia'}</button>
          <button class="btn btn-sm btn-outline" id="wire-now">Revisar ahora</button>
          <button class="btn btn-sm btn-outline" id="wire-clear">Vaciar cola</button>
        </div>
      </div>
    </div>
    ${posts.length ? posts.map(card).join('') : `
      <div class="card"><div class="card-body">
        <p class="muted">Todavía no hay nada en la cola. Se llena sola cuando arranca o termina un
          mapa en cualquiera de las 6 ligas.</p>
      </div></div>`}
  `);

  $('#wire-toggle')?.addEventListener('click', () => {
    state.wireOn = !state.wireOn;
    try { localStorage.setItem('cml:wire:on', state.wireOn ? '1' : '0'); } catch { /* modo privado */ }
    renderWire();
    if (state.wireOn) wireTick();
  });
  $('#wire-now')?.addEventListener('click', async () => {
    await wireTick();
    renderWire();
  });
  $('#wire-clear')?.addEventListener('click', () => {
    if (confirm('¿Vaciar la cola de publicaciones?')) { wire.clearQueue(); renderWire(); }
  });
  document.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', async () => {
      const p = wire.queue().find((x) => x.id === b.dataset.copy);
      if (!p) return;
      try { await navigator.clipboard.writeText(p.text); b.textContent = 'copiado'; }
      catch { b.textContent = 'no se pudo copiar'; }
      setTimeout(() => { b.textContent = 'Copiar texto'; }, 1600);
    })
  );
  document.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = wire.queue().find((x) => x.id === b.dataset.toggle);
      wire.markPosted(b.dataset.toggle, !p?.posted);
      renderWire();
    })
  );
  document.querySelectorAll('[data-drop]').forEach((b) =>
    b.addEventListener('click', () => { wire.removePost(b.dataset.drop); renderWire(); })
  );
  // Abrir el compositor de X marca la entrada: es lo más cerca de "publicado"
  // que el sitio puede saber, y se puede corregir a mano.
  document.querySelectorAll('[data-posted]').forEach((a) =>
    a.addEventListener('click', () => {
      wire.markPosted(a.dataset.posted, true);
      setTimeout(renderWire, 400);
    })
  );
}

/* ------------------------------------------------------------------ *
 * partido
 * ------------------------------------------------------------------ */

/**
 * La liga "de trabajo". En la pestaña de en vivo `state.league` no tiene id, así
 * que el índice del torneo usa la liga real del partido abierto.
 */
function ligaActiva() {
  if (!esEnVivo(state.league)) return state.league;
  const ev = state.events.find((e) => e.match?.id === state.matchId);
  return LEAGUES.find((l) => l.id === ev?.league?.id) ?? state.league;
}

/**
 * En la pestaña de en vivo cada fila es de una liga distinta, así que el torneo
 * y la tabla de posiciones se cargan al abrir el partido, no al abrir la lista.
 * Sin esto la calidad de equipos —el componente que más pesa— entraría vacía
 * justo en los partidos que más importan.
 */
async function contextoEnVivo(matchId) {
  const ev = state.events.find((e) => e.match?.id === matchId);
  const liga = LEAGUES.find((l) => l.id === ev?.league?.id);
  if (!liga || state.ligaVivo === liga.key) return;
  state.ligaVivo = liga.key;
  state.tournament = null;
  state.standings = null;
  const t = await getCurrentTournament(liga.id).catch(() => null);
  state.tournament = t;
  state.standingsPromise = t?.id
    ? getStandings(t.id)
        .then((s) => { state.standings = s; return s; })
        .catch(() => { state.standings = null; return null; })
    : Promise.resolve(null);
  autoIndex();
}

async function openMatch(matchId, { quiet = false, force = false, gameId = null, push = false, fromRoute = false } = {}) {
  const changed = state.matchId !== matchId;
  state.view = 'match';
  state.matchId = matchId;
  if (changed) { state.gameId = null; state.seriesOutcome = null; renderMatchList(); }
  if (gameId) state.gameId = gameId;

  const btn = $('#refresh');
  if (!quiet) btn.classList.add('spinning');
  if (!quiet && changed) {
    setContent(`<div class="card"><div class="card-body"><p class="muted">Cargando partido…</p></div></div>`);
  }

  if (esEnVivo(state.league)) await contextoEnVivo(matchId);

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
    if (!fromRoute) syncRoute({ push: push && changed });
    else syncRoute();
    await renderMatch(ev, force, { preserve: quiet });
  } catch (e) {
    setContent(`<div class="card"><div class="card-body"><div class="err">${esc(e.message)}</div></div></div>`);
  } finally {
    btn.classList.remove('spinning');
  }
}

/**
 * Resuelve el ganador de cada mapa de ESTA serie leyendo el frame final de cada
 * uno y verificándolo contra el marcador. Sirve para dos cosas: mostrar quién
 * ganó cada mapa en las pestañas, y cerrar solo las entradas del registro.
 */
async function resolveOpenSeries(ev) {
  const games = (ev.match?.games ?? []).filter((g) => g.state === 'completed');
  if (!games.length) return null;
  // getEventDetails no devuelve match.id: la clave de caché sale del id del
  // evento. Con `undefined` la caché servía la serie de un partido en otro.
  const matchKey = ev.id ?? state.matchId;
  const cached = state.seriesOutcome;
  if (cached && cached.matchId === matchKey && cached.count === games.length) return cached;

  const teams = (ev.match.teams ?? []).map((t) => ({ id: t.id, code: t.code, wins: t.result?.gameWins ?? 0 }));
  const rows = [];
  for (const g of games) {
    try {
      const w = await getWindow(g.id, feedTimestamp(90), 300_000);
      const meta = w?.gameMetadata;
      rows.push({
        gameId: g.id,
        number: g.number,
        blueTeamId: meta?.blueTeamMetadata?.esportsTeamId ?? g.teams?.find((t) => t.side === 'blue')?.id ?? null,
        redTeamId: meta?.redTeamMetadata?.esportsTeamId ?? g.teams?.find((t) => t.side === 'red')?.id ?? null,
        final: finalStateOf(w),
      });
    } catch { /* un mapa sin frame final no rompe la serie */ }
  }
  const res = resolveSeries(teams, rows);
  const out = { matchId: matchKey, count: games.length, teams, ...res };
  state.seriesOutcome = out;
  return out;
}

async function renderMatch(ev, force, { preserve = false } = {}) {
  const games = ev.match?.games ?? [];
  const game = games.find((g) => g.id === state.gameId);
  const teams = ev.match?.teams ?? [];

  // Draft desde el feed. Sin startingTime = frame de inicio, que es lo que
  // trae el draft y el parche.
  let win = null;
  try { win = await getWindow(state.gameId); } catch { win = null; }

  if (!win?.gameMetadata) {
    setContent(
      matchHeader(ev, game, games) +
      `<div class="card"><div class="card-body">
         <p class="muted">El feed no devuelve datos para este mapa todavía.</p>
         <div class="note">${game?.state === 'inProgress'
           ? 'El mapa figura <strong>en curso</strong> pero el feed todavía no publica frames. Pasa en el primer minuto y medio, entre que arranca la partida y que el feed la alcanza. Se resuelve solo en el próximo refresco.'
           : 'Una respuesta vacía significa que <strong>el mapa no arrancó</strong>. No es un error: es un "todavía no". El draft aparece cuando empieza la partida.'}</div>
       </div></div>`,
      { preserve }
    );
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

  // Ganador de cada mapa ya jugado de esta serie. Cierra solo las entradas del
  // registro: un registro que depende de que vuelvas a marcar a mano quién ganó
  // no se completa nunca, y sin resultados no hay calibración.
  const outcome = await resolveOpenSeries(ev).catch(() => null);

  // --- análisis ---

  // Lo medido sobre el corpus se instala ANTES de puntuar el draft: el umbral de
  // narrabilidad por eje y la resolución del confusor de asedio dejan de ser
  // constantes de juicio y pasan a salir de los datos. Solo pueden endurecer.
  const validation = state.metaIndex ? cachedValidation() : null;
  setMeasuredThresholds(validation?.narratability ?? null);
  setSiegeVerdict(validation?.siege ?? null);

  const score = scoreDraft(
    { team: blue.team, champions: blue.players.map((p) => p.champion) },
    { team: red.team, champions: red.players.map((p) => p.champion) }
  );
  const axes = structuralAxes(blue, red);
  const lanes = laneMatchups(blue, red);
  const { edges, window: win7 } = concentrationAndWindow(blue, red, axes);


  // Segunda fuente: los ejes que Riot publica por campeón. Es lo que convierte
  // parte del Paso 2 de "no computable" en medido, y lo que permite contrastar
  // la tabla congelada contra algo que no salió del mismo juicio.
  const allChamps = [...blue.players, ...red.players].map((p) => p.champion);
  const riotMap = await fetchProfiles(allChamps).catch(() => ({}));
  const rAxes = riotAxes(blue, red, riotMap);
  const cross = crossCheck(allChamps, riotMap, profileRow);

  // El componente que más pesa. Se espera de verdad antes de calcular: si se
  // colaba un render sin standings, la predicción quedaba congelada sin él.
  if (state.standingsPromise) await state.standingsPromise.catch(() => null);
  const recA = findRecord(blue) ?? blue.record;
  const recB = findRecord(red) ?? red.record;
  // Fuerza de equipo medida por mapa en el corpus. Es lo único que le ganó a la
  // línea base fuera de muestra, así que entra al número.
  const teamRow = (id) => {
    for (const idx of cachedIndices()) {
      const t = idx.teams?.[id];
      if (t?.attributed >= 5) return { wr: t.wins / t.attributed, games: t.attributed };
    }
    return null;
  };
  const ctA = teamRow(blue.teamId);
  const ctB = teamRow(red.teamId);
  const corpusTeam = ctA && ctB
    ? { a: ctA.wr, b: ctB.wr, gamesA: ctA.games, gamesB: ctB.games }
    : null;

  // Elo sobre todo el corpus indexado. Reemplaza al récord y al winrate por
  // mapa cuando está disponible: mide lo mismo pero ponderando contra quién
  // jugó cada equipo, y fuera de muestra le gana a los dos.
  //
  // eloTable() está memoizada por tamaño de corpus: recorrer 2000 mapas en cada
  // render es barato pero no gratis, y el corpus solo cambia al indexar.
  const eloA = eloFor(eloTable(), blue.teamId);
  const eloB = eloFor(eloTable(), red.teamId);
  // Días sin jugar del más oxidado de los dos: después de un parón largo el
  // rating describe a un equipo que pudo cambiar de roster, parche y meta.
  // Medido: a partir de 45 días el modelo acierta 38% en vez de 62%.
  const eloDias = (() => {
    const f = (x) => (x?.ultimo ? (Date.now() - new Date(x.ultimo).getTime()) / 86400_000 : null);
    const da = f(eloA), db = f(eloB);
    return da == null || db == null ? null : Math.max(da, db);
  })();
  const elo = { a: eloA, b: eloB, logOdds: eloLogOdds(eloA, eloB, { dias: eloDias }), dias: eloDias };

  const prob = buildProbability({
    elo,
    recordA: recA, recordB: recB,
    tfDelta: score.tfDelta,
    goldDiff: st ? st.a.gold - st.b.gold : null,
    // Lo que pesa es la proporción, no la cantidad: 2k al minuto 10 y 2k al 35
    // son cosas distintas porque el oro en juego se triplicó.
    goldTotal: st ? st.a.gold + st.b.gold : null,
    minute,
    finished: game?.state === 'completed',
    corpusTeam,
    // Con corpus indexado manda la validación del propio corpus. Sin corpus, el
    // peso condicional: teamfight solo cuando los récords están parejos.
    draftWeight: validation?.usable
      ? draftWeightFrom(validation)
      : draftWeightConditional({
          tfRaw: score.perAxis.find((a) => a.axis === 'teamfight')?.dRaw ?? null,
          wrA: recA && recA.wins + recA.losses > 0 ? recA.wins / (recA.wins + recA.losses) : null,
          wrB: recB && recB.wins + recB.losses > 0 ? recB.wins / (recB.wins + recB.losses) : null,
        }),
    // Si hay corpus propio, la ventaja de lado sale de ahí; si no, de la
    // medición congelada en data/evidence.js.
    // El winrate de lado del índice NO entra al modelo.
    //
    // `validation.side` se calcula sobre TODOS los mapas del torneo y nació
    // como control de sanidad del resolutor de ganadores, que es para lo que
    // sirve. Como entrada del modelo mide otra cosa: del mapa 2 en adelante el
    // lado lo elige el perdedor del mapa anterior (azul el 88% de las veces),
    // así que ese winrate es fuerza de equipo disfrazada de lado, y el modelo
    // ya la cuenta en Elo y en récord. Contarla acá la contaba por tercera vez,
    // siempre hacia azul.
    //
    // El modelo tiene su propia medición limpia sobre 867 PRIMEROS mapas
    // (51.7%), mucho mejor sostenida que lo que puede dar un torneo suelto.
    sideRate: null,
  });
  const stance = bettingStance({ p: prob.p, marketP: null });

  const shortPatch = meta.patchVersion ? meta.patchVersion.split('.').slice(0, 2).join('.') : null;
  const rolesOf = (side) => Object.fromEntries(side.players.map((p) => [p.champion, p.role]));
  const layerOpts = (side) => ({ roles: rolesOf(side), patch: shortPatch, global: state.globalIndex });

  const chLayerA = state.metaIndex ? championLayer(state.metaIndex, blue.players.map((p) => p.champion), layerOpts(blue)) : null;
  const chLayerB = state.metaIndex ? championLayer(state.metaIndex, red.players.map((p) => p.champion), layerOpts(red)) : null;
  const plLayerA = state.metaIndex ? playerLayer(state.metaIndex, blue.players, { global: state.globalIndex }) : null;
  const plLayerB = state.metaIndex ? playerLayer(state.metaIndex, red.players, { global: state.globalIndex }) : null;

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
    // Reglas candidatas, congeladas antes del resultado para poder puntuarlas
    // después contra datos que ningún ajuste vio.
    reglas: ledger.evaluarReglas({
      pModelo: prob.p,
      tfRaw: score.perAxis.find((a) => a.axis === 'teamfight')?.dRaw ?? null,
      tfFavorsA: score.tfDelta > 0,
      wrA: recA && recA.wins + recA.losses > 0 ? recA.wins / (recA.wins + recA.losses) : null,
      wrB: recB && recB.wins + recB.losses > 0 ? recB.wins / (recB.wins + recB.losses) : null,
    }),
  });
  for (const cp of checkpoints) {
    ledger.recordSnapshot(state.gameId, cp.minute, {
      goldDiff: cp.goldDiff,
      kills: cp.state ? `${cp.state.a.kills}-${cp.state.b.kills}` : null,
      towers: cp.state ? `${cp.state.a.towers}-${cp.state.b.towers}` : null,
    });
  }

  // Cerrar la entrada sola si ya se sabe quién ganó este mapa.
  const resolved = outcome?.byGame?.[state.gameId] ?? null;
  if (resolved?.winnerTeamId) {
    ledger.autoResolve(state.gameId, resolved.winnerTeamId === blue.teamId ? 'A' : 'B');
  }
  const entryNow = ledger.getEntry(state.gameId) ?? entry;

  const diagnostics = collectDiagnostics({
    score,
    champions: [
      ...blue.players.map((p) => ({ champion: p.champion, team: blue.team })),
      ...red.players.map((p) => ({ champion: p.champion, team: red.team })),
    ],
    metaIndex: state.metaIndex,
    metaBuilding: state.metaBuilding,
    metaProgress: state.metaProgress,
    champLayers: [...(chLayerA ?? []), ...(chLayerB ?? [])],
    playerLayers: [...(plLayerA ?? []), ...(plLayerB ?? [])],
    prob,
    window: win7,
    patchDiff: state.patchDiff,
    patchDiffBusy: state.patchDiffBusy,
    entry: entryNow,
    riot: { available: riotAvailable(), axes: rAxes, cross },
    validation,
  });
  state.diagnostics = diagnostics;

  setContent([
    // --- Lo que se lee siempre: qué va a pasar y en qué mirar ---
    matchHeader(ev, game, games, outcome),
    cardSummary({ score, prob, edges, blue, red, st, minute, game, diagnostics, win7, resolved, entry: entryNow }),
    st ? cardLiveState(st, minute, game) : '',
    checkpoints.length ? cardCheckpoints(checkpoints, blue, red) : '',
    cardDraft(blue, red, lanes, rosterA, rosterB),
    cardReading(score, prob, stance, blue, red, disagreement, entryNow, resolved),
    st ? cardSignals(st, minute, dSignals) : cardSignalsPreview(),

    // --- Por qué: el razonamiento sobre el draft ---
    grupo('g-draft', 'Por qué', 'índice, dónde se concentra la ventaja y ventana', [
      cardIndex(score),
      cardConcentration(edges, axes, blue, red),
      roleGold ? cardRoleGold(roleGold, goldConc, edges, blue, red, minute) : '',
      cardWindow(win7, state.metaIndex),
      cardMatchupChecklist(),
    ]),

    // --- Quién: los diez que juegan ---
    grupo('g-jugadores', 'Los que juegan', 'campeones, jugadores y rendimiento en vivo', [
      merged ? cardPlayerDetail(merged, blue, red) : '',
      cardChampionLayer(chLayerA, chLayerB, blue, red),
      cardPlayerLayer(plLayerA, plLayerB, blue, red, chLayerA, chLayerB, rosterA, rosterB),
      cardRiot(rAxes, cross, blue, red, riotMap),
    ]),

    // --- Cuánto vale: la auditoría del propio modelo ---
    grupo('g-modelo', 'Cuánto vale esto', 'validación, qué predice de verdad y diagnóstico', [
      cardValidation(validation),
      cardDiscovery(state.metaIndex ? cachedDiscovery() : null),
      cardPatch(meta.patchVersion, blue, red),
      cardDiagnostics(diagnostics),
    ]),
  ].join(''), { preserve });

  bindGameTabs();
  bindMetaButton();
  bindPatchDiff(blue, red, meta.patchVersion);
  bindMarketAndResult(blue, red);
  bindDiagnostics([...blue.players, ...red.players], riotMap);

  // El diff de parche es barato y era un pendiente permanente en el panel. Se
  // dispara solo la primera vez que se ve este draft.
  autoPatchDiff(allChamps, meta.patchVersion);
}

/** Compara el parche sin que haya que pedirlo. Una vez por draft. */
async function autoPatchDiff(champions, patchVersion) {
  const key = `${patchVersion}|${[...champions].sort().join(',')}`;
  if (state.patchDiffKey === key || state.patchDiffBusy) return;
  state.patchDiffKey = key;
  state.patchDiffBusy = true;
  try {
    state.patchDiff = await diffChampions(champions, patchVersion);
    if (state.matchId && state.view === 'match') await openMatch(state.matchId, { quiet: true });
  } catch {
    state.patchDiff = null;
    state.patchDiffKey = null;
  } finally {
    state.patchDiffBusy = false;
  }
}

/**
 * Validación memoizada. La clave incluye la marca de construcción de cada índice,
 * así que reindexar la invalida sola y cualquier otra cosa la reutiliza.
 */
let validationCache = null;
function cachedValidation() {
  const all = cachedIndices();
  const key = all.map((i) => `${i.tournamentId}:${i.builtAt}`).sort().join('|');
  if (validationCache?.key === key) return validationCache.value;
  const v = all.length > 1 ? validateAcross(all) : validateIndex(state.metaIndex);
  const value = { ...v, read: readValidation(v) };
  validationCache = { key, value };
  return value;
}

/**
 * Descubrimiento: entrena candidatos con la parte vieja del corpus y los evalúa
 * con la nueva. Se memoiza igual que la validación porque puntúa cientos de
 * mapas y el partido en vivo se repinta cada 20 s.
 */
let discoveryCache = null;
function cachedDiscovery() {
  const all = cachedIndices();
  const key = all.map((i) => `${i.tournamentId}:${i.builtAt}`).sort().join('|');
  if (discoveryCache?.key === key) return discoveryCache.value;
  const maps = all.flatMap((i) => i.maps ?? []);
  if (maps.length < 40) return null;
  const ev = evaluateModels(maps);
  const value = {
    eval: ev,
    read: readEvaluation(ev),
    scaling: championScaling(maps),
    fighting: championFighting(maps),
  };
  discoveryCache = { key, value };
  return value;
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

/**
 * Tarjeta plegable. Lo que es detalle profundo se puede cerrar; la espina
 * dorsal del informe queda siempre visible. El `data-k` permite conservar qué
 * secciones tenías abiertas cuando el refresco en vivo repinta.
 */
function collapsible(key, title, sub, body, { open = false } = {}) {
  return `
  <details class="card fold" data-k="${esc(key)}"${open ? ' open' : ''}>
    <summary class="card-head">
      <h3>${title}</h3>
      <span class="muted-xs">${sub ?? ''}</span>
      <span class="chev" aria-hidden="true"></span>
    </summary>
    <div class="card-body">${body}</div>
  </details>`;
}

/**
 * Resumen ejecutivo. Existe porque el informe completo son quince tarjetas y la
 * pregunta que se hace primero siempre es la misma: quién va ganando, cuánto
 * pesa el draft y qué tan confiable es lo que estoy leyendo.
 */
function cardSummary({ score, prob, edges, blue, red, st, minute, game, diagnostics, win7, resolved, entry }) {
  const p = prob.p;
  const favored = p >= 0.5 ? blue : red;
  const pShown = p >= 0.5 ? p : 1 - p;
  const tier = score.tfBand.tier;
  const tierClass = { strong: 'band-strong', weak: 'band-weak', coin: 'band-coin' }[tier];

  const bloq = diagnostics.counts.bloqueante;
  const confidence = bloq > 0 || !prob.hasQuality
    ? { cls: 'warn', txt: `${Math.max(bloq, 1)} hueco${Math.max(bloq, 1) === 1 ? '' : 's'} sin resolver` }
    : diagnostics.counts.parcial > 0
      ? { cls: 'ok', txt: 'Completa, con reservas' }
      : { cls: 'ok', txt: 'Lectura completa' };

  const stateLine = resolved?.winnerTeamId
    ? `Mapa terminado — ganó <strong>${esc(resolved.winnerTeamId === blue.teamId ? blue.team : red.team)}</strong>
       <span class="muted-xs">(${esc(METHOD_LABEL[resolved.method] ?? 'resuelto')})</span>`
    : st
      ? `En curso, minuto ${minute?.toFixed(0) ?? '?'} · oro ${
          (() => { const d = st.a.gold - st.b.gold;
            return Math.abs(d) < 1000
              ? 'parejo (menos de 1k)'
              : `${(d >= 0 ? '+' : '') + d.toLocaleString('es')} para ${esc(d >= 0 ? blue.team : red.team)}`; })()}`
      : game?.state === 'unstarted'
        ? 'El mapa todavía no arrancó: esto es lectura de draft pura.'
        : 'Sin estado en vivo.';

  const edge = edges[0];

  // El eje de escalado es el ÚNICO del índice que pasó su prueba condicional:
  // 55.7% en el tercio de partidas más largas contra 51.5% en el más corto, de
  // forma monotónica (evidence.js -> escalado). No puede mover la probabilidad
  // previa porque la duración no se sabe antes de jugar, pero sí merece estar a
  // la vista: la tarjeta mostraba solo teamfight, que es el eje medido en 50.0%.
  const escalado = score.perAxis?.find((a) => a.axis === 'scaling') ?? null;

  return `
  <div class="card summary">
    <div class="card-body">
      <div class="summary-grid">
        <div class="sum-cell">
          <div class="sum-k">Probabilidad</div>
          <div class="sum-v">${(pShown * 100).toFixed(0)}% <span class="sum-team">${esc(favored.team)}</span></div>
          <div class="muted-xs">${prob.finished ? 'lectura previa, no predice lo ya jugado' : prob.hasQuality ? 'calidad + draft' + (st ? ' + estado' : '') : 'sin calidad de equipos'}</div>
        </div>
        <div class="sum-cell">
          <div class="sum-k">Δ teamfight</div>
          <div class="sum-v ${tierClass}">${score.tfDelta >= 0 ? '+' : ''}${score.tfDelta.toFixed(2)} sd</div>
          <div class="muted-xs">banda ${esc(score.tfBand.label)} · ${tier === 'coin' ? 'no usar como señal' : `favorece a ${esc(score.tfFavors)}`}</div>
          ${escalado && Math.abs(escalado.dz) >= 0.5
            ? `<div class="muted-xs esc-line">escalado ${escalado.dz >= 0 ? '+' : '-'}${Math.abs(escalado.dz).toFixed(2)} sd
                 · si se estira, ${esc(escalado.favors)}</div>`
            : ''}
        </div>
        <div class="sum-cell">
          <div class="sum-k">Dónde se decide</div>
          <div class="sum-v small">${edge ? esc(edge.label) : 'Mapa parejo en estructura'}</div>
          <div class="muted-xs">${edge ? `${esc(edge.side)}${edge.carrier ? ` · lo carga ${esc(championName(edge.carrier.champion))}` : ''}` : 'ningún eje concentra margen suficiente'}</div>
        </div>
        <div class="sum-cell">
          <div class="sum-k">Confianza del dato</div>
          <div class="sum-v small ${confidence.cls === 'ok' ? 'ok-txt' : 'warn-txt'}">${confidence.txt}</div>
          <div class="muted-xs">${diagnostics.counts.parcial} parcial${diagnostics.counts.parcial === 1 ? '' : 'es'} · ${diagnostics.counts.declarado} límite${diagnostics.counts.declarado === 1 ? '' : 's'} declarado${diagnostics.counts.declarado === 1 ? '' : 's'}</div>
        </div>
      </div>
      <div class="summary-state">${stateLine}</div>
      <div class="summary-foot">
        <span class="stance-mini">NO BET</span>
        <span class="muted-xs">Postura por defecto${entry?.market?.length ? '' : ' — sin precio cargado no hay edge que medir'}.
          ${win7.declared ? `Ventana declarada ${win7.from}–${win7.to} min.` : 'Sin ventana declarable.'}</span>
      </div>
    </div>
  </div>`;
}

const SEVERITY = {
  bloqueante: { label: 'Bloqueante', cls: 'sev-block' },
  parcial: { label: 'Parcial', cls: 'sev-partial' },
  declarado: { label: 'Límite declarado', cls: 'sev-known' },
};

function cardDiagnostics(d) {
  const rows = d.items.map((it) => `
    <div class="diag ${SEVERITY[it.severity].cls}">
      <div class="diag-head">
        <span class="diag-tag">${SEVERITY[it.severity].label}</span>
        <span class="diag-title">${esc(it.title)}</span>
        ${it.action ? `<button class="btn btn-sm btn-outline diag-act" data-diag="${esc(it.action.id)}">${esc(it.action.label)}</button>` : ''}
      </div>
      <div class="diag-detail">${esc(it.detail)}</div>
    </div>`).join('');

  return collapsible(
    'diagnostico',
    'Diagnóstico',
    `${d.counts.bloqueante} bloqueante${d.counts.bloqueante === 1 ? '' : 's'} · ${d.counts.parcial} parcial${d.counts.parcial === 1 ? '' : 'es'} · ${d.counts.declarado} declarado${d.counts.declarado === 1 ? '' : 's'}`,
    `<div class="note">Todo lo que este análisis <strong>no</strong> puede sostener, junto y con nombre.
       Un hueco repartido entre ocho tarjetas se lee como "acá no hay nada que ver", y no es lo mismo
       que un dato ausente.</div>
     ${rows}
     <div class="index-foot">
       ${d.items.some((i) => i.action && ['indexar', 'reindexar', 'comparar-parche'].includes(i.action.id))
         ? '<button class="btn btn-sm" id="fix-all">Resolver todo lo automatizable</button>' : ''}
       <button class="btn btn-sm btn-outline" data-diag="abrir-editor">Clasificar campeones</button>
       <button class="btn btn-sm btn-outline" data-diag="indexar-mas">Indexar otra liga</button>
       <span class="muted-xs">Lo que se puede resolver sin vos se resuelve de una; puntuar un
         campeón y cargar una cuota no, y por eso quedan señalados en vez de simulados.</span>
     </div>
     ${state.fixAll ? `<div class="note note-ok">Se ejecutaron ${state.fixAll.ran} acciones automáticas
       ${esc(new Date(state.fixAll.at).toLocaleTimeString('es'))}.
       ${state.fixAll.manual
         ? `Quedan ${state.fixAll.manual} que dependen de una decisión tuya y el sitio no va a tomar por vos.`
         : 'No quedó nada automatizable pendiente.'}</div>` : ''}`,
    { open: d.counts.bloqueante > 0 }
  );
}

/** Editor de arquetipos: la salida para los campeones que no están en ninguna tabla. */
function championEditor(champions, riotMap) {
  const rows = champions.map((c) => {
    const src = classificationOf(c);
    const prof = profileRow(c) ?? {};
    const riot = profileFor(riotMap, c);
    const sug = !src && riot ? suggestArchetype(riot) : null;
    const start = prof.fl != null ? prof : sug ?? {};
    const inputs = AXES.map((a) => `
      <label class="ax-in"><span>${a}</span>
        <input type="number" min="0" max="3" step="1" data-ax="${a}" data-champ="${esc(c)}"
               value="${start[a] ?? 0}"></label>`).join('');
    const riotLine = riot
      ? `<div class="muted-xs">Riot: ${esc((riot.roles ?? []).join('/') || 'sin clase')} ·
         ${riot.attackType === 'ranged' ? 'a distancia' : 'cuerpo a cuerpo'} ·
         daño ${esc(riot.damageType ?? '?')} · cc ${riot.crowdControl} · dur ${riot.durability} ·
         mov ${riot.mobility}</div>`
      : '';
    return `
      <div class="editor-row">
        <div class="editor-champ">
          ${championIcon(c) ? `<img src="${esc(championIcon(c))}" alt="" loading="lazy">` : ''}
          <div>
            <strong>${esc(championName(c))}</strong>
            <div class="muted-xs">${src ? `origen: ${esc(src)}` : 'sin clasificar — hoy cuenta cero en los cinco ejes'}</div>
            ${riotLine}
          </div>
        </div>
        <div class="editor-axes">${inputs}</div>
        <div class="editor-btns">
          <button class="btn btn-sm" data-save-champ="${esc(c)}">Guardar</button>
          ${src === 'manual' ? `<button class="btn btn-sm btn-outline" data-reset-champ="${esc(c)}">Volver a la tabla</button>` : ''}
        </div>
      </div>
      ${sug ? `<div class="sug">Punto de partida propuesto arriba. ${esc(sug.basis)}</div>` : ''}`;
  }).join('');

  return `
    <div class="editor">
      <div class="note">Escala 0-3 por eje, la misma que la tabla congelada:
        <strong>fl</strong> frontline · <strong>aoe</strong> daño de área · <strong>eng</strong> inicio duro ·
        <strong>pick</strong> amenaza de pick · <strong>poke</strong> asedio · <strong>split</strong> presión lateral ·
        <strong>scale</strong> escalado. Lo que guardes queda marcado como <em>manual</em> en todas las
        lecturas y se guarda solo en este navegador: no toca la escala de referencia.</div>
      ${rows}
    </div>`;
}

function matchHeader(ev, game, games, outcome = null) {
  const [t1, t2] = ev.match?.teams ?? [];
  const codeOf = (teamId) => (ev.match?.teams ?? []).find((t) => t.id === teamId)?.code ?? null;
  const tabs = games.map((g) => {
    const label = `Mapa ${g.number}`;
    const dis = g.state === 'unstarted' || g.state === 'unneeded' ? 'disabled' : '';
    const dot = g.state === 'inProgress' ? ' ●' : '';
    const w = outcome?.byGame?.[g.id]?.winnerTeamId;
    const tag = w ? `<span class="tab-win">${esc(codeOf(w) ?? '')}</span>` : '';
    return `<button class="game-tab${g.id === state.gameId ? ' active' : ''}" data-game="${g.id}" ${dis}>${label}${dot}${tag}</button>`;
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
  const src = classificationOf(p.champion);
  const prof = profileRow(p.champion);
  // El perfil en crudo, para poder discutir el campeón y no solo la suma.
  const axes = prof
    ? `<div class="champ-axes" title="fl · aoe · eng · pick · poke · split · scale">${
        AXES.map((a) => `<span class="ax${prof[a] >= 3 ? ' hi' : prof[a] === 0 ? ' zero' : ''}" title="${a}: ${prof[a]}">${prof[a]}</span>`).join('')
      }</div>`
    : '';
  const tag = src === null
    ? `<div class="unclassified">sin clasificar — cuenta cero en los cinco ejes</div>`
    : src === 'manual'
      ? `<div class="unclassified manual">clasificación manual tuya</div>`
      : src === 'extension'
        ? `<div class="unclassified ext">clasificado por extensión</div>`
        : '';
  return `<div class="champ">
      ${icon ? `<img src="${esc(icon)}" alt="" loading="lazy">` : '<div class="champ-img-ph"></div>'}
      <div class="champ-txt">
        <div class="champ-name">${esc(championName(p.champion))}</div>
        <div class="champ-player">${esc(p.name)}${subLabel ? ` <span class="badge badge-warn">${esc(subLabel)}</span>` : ''}</div>
        ${axes}
        ${tag}
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

  return collapsible(
    'detalle-jugador',
    'Detalle por jugador',
    'daño, participación en kills, visión e ítems',
    `${anyDetails ? '' : `<div class="note note-warn">El feed de detalle no devolvió datos para este
       frame. Las columnas de daño, KP y wards quedan vacías: faltan, no son cero.</div>`}
     ${side(merged.a, blue.team)}
     ${side(merged.b, red.team)}`,
    { open: true }
  );
}

function cardIndex(score) {
  const [A, B] = score.sides;
  const d = score.tfDelta;
  const tierClass = { strong: 'band-strong', weak: 'band-weak', coin: 'band-coin' }[score.tfBand.tier];

  const axisRows = score.perAxis.map((ax) => {
    const pct = Math.max(-1, Math.min(1, ax.dz / 3));
    const w = Math.abs(pct) * 50;
    const left = pct >= 0 ? 50 : 50 - w;
    const th = ax.threshold;
    const flag = ax.narratable
      ? ''
      : `<div class="axis-flag">no narrable
           <span class="th-src ${th?.source === 'medido' ? 'medido' : ''}">${th?.source === 'medido'
             ? `umbral medido: ${th.measured} pts`
             : `umbral por defecto: ${th?.value ?? RAW_NARRATABLE_MIN} pts`}</span>
         </div>`;
    return `
      <div class="axis-row${ax.narratable ? '' : ' dim'}">
        <div class="axis-name">${AXIS_LABEL[ax.axis]}</div>
        <div class="axis-bar"><div class="mid"></div>
          <div class="fill" style="left:${left}%;width:${w}%;background:${pct >= 0 ? 'var(--blue)' : 'var(--red)'}"></div>
        </div>
        <div class="axis-val">
          ${ax.dz >= 0 ? '+' : ''}${ax.dz.toFixed(2)} sd · ${ax.dRaw >= 0 ? '+' : ''}${ax.dRaw.toFixed(1)} pts
          ${flag}
        </div>
      </div>`;
  }).join('');

  const anyMeasured = score.perAxis.some((ax) => ax.threshold?.source === 'medido');

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
          Diferencia por eje (${esc(A.team)} respecto de ${esc(B.team)}). Un eje se marca como no
          narrable cuando su diferencia cruda no llega al umbral: los z-scores amplifican los ejes
          de dispersión estrecha.
          ${anyMeasured
            ? 'Los umbrales marcados como <strong>medidos</strong> salen del corpus indexado, no de una regla de dedo.'
            : 'Sin corpus indexado el umbral es el mismo para los cinco ejes (1 punto crudo), que es una regla de dedo y no una medición.'}
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

const KIND_TAG = {
  hecho: '<span class="kind kind-fact">hecho</span>',
  proxy: '<span class="kind kind-proxy">proxy</span>',
};

/**
 * Segunda fuente. Lo importante de esta tarjeta no es que agregue ejes: es que
 * por primera vez hay algo con qué contrastar la tabla de juicio propio.
 */
function cardRiot(rAxes, cross, blue, red, riotMap) {
  if (!rAxes.available) {
    return collapsible(
      'riot', 'Segunda fuente', 'datos de campeón publicados por Riot',
      `<div class="note note-warn">No se pudieron cargar los perfiles de Community Dragon para este
         draft. Los ejes de abajo quedan sin medir; los del Paso 2 vuelven a ser lectura humana.</div>`
    );
  }

  const rows = rAxes.axes.map((ax) => `
    <div class="row">
      <span class="row-label">${esc(ax.label)} ${KIND_TAG[ax.kind] ?? ''}
        ${ax.favors ? `<span class="badge badge-blue">${esc(ax.favors)}</span>` : ''}</span>
      <span class="row-val">${esc(blue.team)} ${esc(String(ax.a))} · ${esc(red.team)} ${esc(String(ax.b))}<br>
        <span class="muted-xs">${esc(ax.unit)}</span></span>
    </div>
    ${ax.note ? `<div class="muted-xs" style="padding:0 0 8px">${esc(ax.note)}</div>` : ''}`).join('');

  const dis = cross.disagreements;
  const crossHtml = cross.rows.length
    ? `<div class="cross">
        <div class="cross-head">Contraste con la tabla congelada
          <span class="muted-xs">${(cross.agreement * 100).toFixed(0)}% de acuerdo en ${cross.rows.length} campeones</span></div>
        ${dis.length
          ? dis.map((r) => `<div class="cross-row">
              <strong>${esc(championName(r.champion))}</strong>
              <span class="muted-xs">frontline propio ${r.fl} · durabilidad de Riot ${r.durability}
                · clases ${esc(r.roles.join('/') || '—')}</span>
            </div>`).join('')
          : '<div class="muted-xs">Ninguna discrepancia fuerte: las dos fuentes coinciden en quién aguanta.</div>'}
        <div class="note">Comparar el eje <code>fl</code> (juicio propio) contra <code>durability</code>
          (Riot) es lo más cerca que llega el sitio a auditar su propia tabla. Una discrepancia de 2 o
          más puntos significa una de dos cosas: la tabla tiene un error, o el campeón cambió de rol
          desde que se escribió. No se corrige solo — se muestra.</div>
      </div>`
    : '';

  const perChamp = [...blue.players, ...red.players].map((p) => {
    const r = profileFor(riotMap, p.champion);
    if (!r) return '';
    return `<div class="riot-chip" title="${esc(p.champion)}">
        ${championIcon(p.champion) ? `<img src="${esc(championIcon(p.champion))}" alt="" loading="lazy">` : ''}
        <span class="muted-xs">${r.attackType === 'ranged' ? 'dist.' : 'c.a.c.'} ·
          ${r.damageType === 'physical' ? 'fís' : r.damageType === 'magic' ? 'mág' : 'mix'} ·
          cc ${r.crowdControl} · dur ${r.durability} · mov ${r.mobility}</span>
      </div>`;
  }).join('');

  return collapsible(
    'riot',
    'Segunda fuente',
    `Community Dragon · ${rAxes.coverage.a + rAxes.coverage.b} de 10 campeones cubiertos`,
    `<div class="note note-ok">Estos ejes no salen de la tabla de juicio: son los que <strong>Riot
       publica por campeón</strong> en los datos del cliente. Sirven para dos cosas — medir parte del
       Paso 2 que hasta ahora se declaraba no computable, y tener por primera vez una fuente
       independiente contra la cual contrastar la tabla propia.</div>
     ${rows}
     <div class="riot-chips">${perChamp}</div>
     ${crossHtml}`,
    { open: true }
  );
}

/**
 * A partir de cuántos puntos crudos cada eje dice algo. Reemplaza una regla de
 * dedo aplicada por igual a los cinco ejes por una medición por eje.
 */
function cardNarratability(nar, n) {
  if (!nar) return '';
  const cell = (b) => {
    if (!b || !b.n) return '<td class="num muted-xs">—</td>';
    const cls = b.straddles ? '' : b.p > 0.5 ? 'ok-txt' : 'warn-txt';
    return `<td class="num ${cls}" title="IC95 [${(b.low * 100).toFixed(0)}, ${(b.high * 100).toFixed(0)}] · n=${b.n}">
      ${(b.p * 100).toFixed(0)}%<div class="muted-xs">n=${b.n}</div></td>`;
  };
  const rows = Object.entries(nar).map(([axis, r]) => `
    <tr>
      <td><strong>${AXIS_LABEL[axis]}</strong>
        <div class="muted-xs">${r.measured != null
          ? `umbral medido: ${r.measured} pts${r.tightened ? ' — endurece el de por defecto' : ' — no cambia el de por defecto'}`
          : 'sin evidencia a ninguna magnitud'}</div></td>
      ${cell(r.buckets[0])}${cell(r.buckets[1])}${cell(r.buckets[2])}${cell(r.buckets[3])}
    </tr>`).join('');

  const tightened = Object.entries(nar).filter(([, r]) => r.tightened).map(([a]) => AXIS_LABEL[a]);
  // Distinguir "no hay evidencia" de "hay evidencia de que no": lo decide el n.
  const powered = Object.values(nar).some((r) => r.wellPowered);
  const noneSeparate = Object.values(nar).every((r) => r.measured == null);

  return `
    <div class="muted-xs" style="margin:18px 0 6px">¿A partir de cuántos puntos crudos dice algo cada eje?
      Tasa de acierto del lado favorecido, por magnitud de la diferencia cruda (${n} mapas).</div>
    <div class="table-scroll">
      <table class="detail-table nar-table">
        <thead><tr><th>Eje</th><th>1 pt</th><th>2 pts</th><th>3 pts</th><th>4+ pts</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="note ${tightened.length || (noneSeparate && powered) ? 'note-warn' : ''}">
      ${tightened.length
        ? `Con esta medición se <strong>endurece</strong> el umbral de ${esc(tightened.join(', '))}: por
           debajo de lo medido esos ejes no separan ganadores, así que dejan de narrarse aunque su
           z-score sea alto.`
        : noneSeparate && powered
          ? `<strong>Ningún eje separa ganadores a ninguna magnitud</strong>, y con estos n no es por
             falta de muestra: los intervalos son estrechos y todos contienen el 50%. O sea que la
             pregunta "¿desde cuántos puntos se puede narrar un eje?" no tiene respuesta acá, porque
             ni con 4 o más puntos de diferencia el eje dice quién gana. El umbral de 1 punto no
             estaba siendo demasiado conservador: si algo, se queda corto.`
          : 'Ningún eje justifica endurecer el umbral por encima del punto crudo de siempre, pero los n todavía son chicos.'}
      La medición <strong>solo puede endurecer</strong>, nunca aflojar. Si el corpus dijera que con
      medio punto ya alcanza, no se afloja igual: aflojar un umbral porque una muestra lo permite es
      tomar cinco observaciones y convertirlas en una regla, que es el error que este método existe
      para evitar. Endurecer de más solo te vuelve más callado.
    </div>`;
}

/** El confusor que el método declaraba y no resolvía. */
function cardSiege(s) {
  if (!s) return '';
  const line = (label, o) => `
    <div class="row">
      <span class="row-label">${label} <span class="muted-xs">n=${o.n}</span></span>
      <span class="row-val">${o.tf
        ? `teamfight ${(o.tf.p * 100).toFixed(0)}%<br><span class="muted-xs">IC95 [${(o.tf.low * 100).toFixed(0)}, ${(o.tf.high * 100).toFixed(0)}]${o.tf.straddles ? ' — no distingue' : ''}</span>`
        : '<span class="muted-xs">sin casos</span>'}</span>
    </div>`;

  return `
    <div class="muted-xs" style="margin:18px 0 6px">Teamfight contra asedio: ¿cuál de los dos es la señal?</div>
    ${line('Los dos ejes apuntan al mismo lado', s.agree)}
    ${line('Los ejes discrepan', s.disagree)}
    ${s.corr != null ? `<div class="muted-xs">Correlación entre las dos diferencias: ${s.corr.toFixed(2)}.
      ${Math.abs(s.corr) > 0.3
        ? 'Se superponen bastante, que es justo lo que crea la ambigüedad: en la mayoría de los mapas los dos ejes apuntan al mismo lado y no se pueden distinguir.'
        : 'Se superponen poco, así que los dos ejes son más independientes de lo que la advertencia sugiere.'}</div>` : ''}
    <div class="note ${s.resolved ? 'note-ok' : 'note-warn'}">
      <strong>${s.resolved ? 'Ambigüedad resuelta en este corpus.' : 'Ambigüedad todavía abierta.'}</strong>
      ${esc(s.verdict)}
      <div class="muted-xs" style="margin-top:6px">El acuerdo entre los dos ejes es redundancia, no
        confirmación: las comps con mucho poke suelen tener poco daño de área e inicio, así que
        tienden a apuntar al mismo lado por construcción. Los únicos mapas que discriminan entre
        "el teamfight es mejor" y "el poke está flojo" son aquellos donde se contradicen.</div>
    </div>`;
}

/**
 * Qué predice de verdad. Compara candidatos fuera de muestra, con corte
 * cronológico, contra la línea base correcta: el lado azul.
 */
function cardDiscovery(disc) {
  if (!disc) return '';
  if (!disc.eval.usable) {
    return collapsible('descubrimiento', 'Qué predice de verdad', 'requiere más corpus',
      `<div class="note note-warn">${esc(disc.eval.reason)}</div>`);
  }
  const ev = disc.eval;
  const best = ev.rows[0];
  const rows = ev.rows.map((r) => `
    <tr class="${r.id === best.id ? 'best' : ''}${r.beatsBase === false && r.id !== 'side' ? ' worse' : ''}">
      <td><strong>${esc(r.label)}</strong><div class="muted-xs">${esc(r.detail)}</div></td>
      <td class="num">${r.brier.toFixed(4)}</td>
      <td class="num">${r.id === 'side' ? '—' : `${r.vsBase >= 0 ? '+' : ''}${r.vsBase.toFixed(4)}`}</td>
      <td class="num">${(r.acc * 100).toFixed(0)}%<div class="muted-xs">[${(r.accLow * 100).toFixed(0)},${(r.accHigh * 100).toFixed(0)}]</div></td>
    </tr>`).join('');

  const splitCard = (s) => {
    if (!s?.usable) return '';
    const surv = s.rows.filter((r) => r.survivesFDR);
    const top = surv.length ? surv : s.rows.slice(0, 4).concat(s.rows.slice(-4));
    return `
      <div class="muted-xs" style="margin:16px 0 6px"><strong>${esc(s.label)}</strong> —
        ${esc(s.highLabel)} contra ${esc(s.lowLabel)}, corte en ${s.median.toFixed(1)}.
        ${s.tested} campeones con muestra suficiente de los ${s.n} mapas.</div>
      <div class="table-scroll">
        <table class="detail-table nar-table">
          <thead><tr><th>Campeón</th><th>${esc(s.highLabel)}</th><th>${esc(s.lowLabel)}</th><th>Δ (IC95)</th></tr></thead>
          <tbody>${top.map((r) => `
            <tr class="${r.survivesFDR ? 'best' : ''}">
              <td><strong>${esc(championName(r.name))}</strong><div class="muted-xs">n=${r.total}</div></td>
              <td class="num">${(r.highWr * 100).toFixed(0)}%<div class="muted-xs">n=${r.high.g}</div></td>
              <td class="num">${(r.lowWr * 100).toFixed(0)}%<div class="muted-xs">n=${r.low.g}</div></td>
              <td class="num">${r.diff >= 0 ? '+' : ''}${(r.diff * 100).toFixed(0)}
                <div class="muted-xs">[${(r.lo * 100).toFixed(0)}, ${(r.hi * 100).toFixed(0)}]</div></td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="note ${surv.length ? 'note-ok' : 'note-warn'}">
        ${surv.length
          ? `${surv.length} campeón${surv.length === 1 ? '' : 'es'} sobrevive${surv.length === 1 ? '' : 'n'} a la corrección por comparaciones múltiples (Benjamini-Hochberg, q=${s.fdr.q}).`
          : `<strong>Ninguno sobrevive a la corrección por comparaciones múltiples.</strong>
             Sin corregir habría ${s.naive} "hallazgos", y probar ${s.tested} campeones al 95%
             produce ${s.expectedFalse.toFixed(1)} por puro azar. O sea que los que cruzan el umbral
             son indistinguibles de ruido, y quedarse con ellos sería justo el error que este método
             existe para evitar: tomar cinco observaciones consistentes y convertirlas en una regla.`}
      </div>`;
  };

  return collapsible(
    'descubrimiento',
    'Qué predice de verdad',
    `${ev.nTrain} mapas de entrenamiento · ${ev.nTest} de evaluación`,
    `<div class="note ${disc.read.verdict === 'hay señal' ? 'note-ok' : 'note-warn'}">
       <strong>${esc(disc.read.verdict)}.</strong> ${esc(disc.read.text)}</div>

     <div class="muted-xs" style="margin:14px 0 6px">
       Corte cronológico: se entrena con lo de <strong>${esc((ev.trainFrom ?? '').slice(0, 10))} a
       ${esc((ev.trainTo ?? '').slice(0, 10))}</strong> y se evalúa con
       <strong>${esc((ev.testFrom ?? '').slice(0, 10))} a ${esc((ev.testTo ?? '').slice(0, 10))}</strong>.
       Un corte aleatorio dejaría partidas del mismo día de los dos lados y filtraría información del
       futuro. La línea base no es 50%: es predecir siempre al lado azul, que gana
       ${(ev.sideRate * 100).toFixed(0)}% en el corpus. Ese ${(ev.sideRate * 100).toFixed(0)}% no es
       ventaja de lado —casi todo viene del mapa 2, donde el azul es el ganador del mapa 1 el 88% de
       las veces—, pero por eso mismo es una vara dura: superarla exige aportar algo por encima de
       ya saber quién es el favorito de la serie.
     </div>
     <div class="table-scroll">
       <table class="detail-table nar-table">
         <thead><tr><th>Modelo</th><th>Brier</th><th>vs base</th><th>Acierto</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>
     </div>
     <div class="note">Brier más bajo es mejor. Todo lo de esta tabla es <strong>fuera de muestra</strong>:
       ninguna fila vio los ${ev.nTest} mapas con los que se la evalúa.</div>

     ${splitCard(disc.scaling)}
     ${splitCard(disc.fighting)}`,
    { open: true }
  );
}

/** El sitio corriendo su propio test sobre el corpus que indexó. */
function cardValidation(v) {
  if (!v) {
    return collapsible(
      'validacion', 'Validación del índice', 'requiere corpus indexado',
      `<div class="note">Sin índice de torneo no hay corpus con el que testear nada. El 74% de la
         banda grande queda como cita del backtest original, sin poder reproducirse acá.</div>`
    );
  }
  if (!v.usable) {
    return collapsible(
      'validacion', 'Validación del índice', 'sin corpus suficiente',
      `<div class="note note-warn">${esc(v.reason)}</div>`
    );
  }

  const bandRow = (key, label) => {
    const b = v.byBand[key];
    if (!b || !b.n) return `<div class="row"><span class="row-label">${label}</span>
      <span class="row-val muted-xs">sin casos en el corpus</span></div>`;
    return `
      <div class="row">
        <span class="row-label">${label}</span>
        <span class="row-val">${b.hits}/${b.n} · <strong>${(b.p * 100).toFixed(0)}%</strong>
          <br><span class="muted-xs">IC95 [${(b.low * 100).toFixed(0)}, ${(b.high * 100).toFixed(0)}]${
            b.straddles ? ' — cruza el 50%, no distingue' : ''}</span></span>
      </div>
      ${wrBar(b)}`;
  };

  const verdictCls = { 'se sostiene': 'note-ok', 'no distingue': 'note-warn',
    'apunta al lado contrario': 'note-warn' }[v.read.verdict] ?? '';

  return collapsible(
    'validacion',
    'Validación del índice',
    `${v.n} mapas del corpus · ${esc(v.tournament ?? '')}`,
    `<div class="note ${verdictCls}"><strong>${esc(v.read.verdict)}.</strong> ${esc(v.read.text)}</div>

     <div class="muted-xs" style="margin:14px 0 6px">¿Gana el lado que el índice favorece?
       <strong>Régimen limpio</strong>, ${v.nClean} de ${v.n} mapas — al menos una de las dos comps
       por encima del promedio de la referencia en teamfight.</div>
     ${bandRow('strong', 'Banda grande (|Δ| &gt; 1 sd)')}
     ${bandRow('weak', 'Banda media (0.5 – 1 sd)')}
     ${bandRow('coin', 'Banda chica (&lt; 0.5 sd)')}
     ${v.overall ? `<div class="muted-xs">Sobre todo el régimen limpio, sin separar por banda:
       ${v.overall.hits}/${v.overall.n} (${(v.overall.p * 100).toFixed(0)}%). Mezcla los drafts
       parejos, donde el propio método dice que no hay que usar el índice, así que es contexto y no
       resultado.</div>` : ''}

     ${v.nDirty ? `
       <div class="muted-xs" style="margin:16px 0 6px">Fuera de régimen (${v.nDirty} mapas con las dos
         comps por debajo del promedio). Acá el propio método avisa que el hallazgo no es limpio,
         así que funciona de control.</div>
       <div class="row"><span class="row-label">Banda grande, fuera de régimen</span>
         <span class="row-val">${v.byBandDirty?.strong?.n
           ? `${v.byBandDirty.strong.hits}/${v.byBandDirty.strong.n} · ${(v.byBandDirty.strong.p * 100).toFixed(0)}%`
           : 'sin casos'}</span></div>
       ${v.byBandDirty?.strong?.n && v.byBand?.strong?.n
         ? `<div class="muted-xs">${v.byBandDirty.strong.p < (v.byBand.strong.p ?? 0)
             ? 'Peor que dentro del régimen, que es lo que la advertencia predice: separar por régimen no es una excusa, tiene contenido.'
             : 'No es peor que dentro del régimen. Con estos n no dice mucho, pero si se sostiene, la advertencia de régimen no está capturando lo que dice capturar.'}</div>`
         : ''}
     ` : ''}
     ${v.overallAll ? `<div class="muted-xs" style="margin-top:8px">Sin filtrar por régimen, todos los
       mapas: ${v.overallAll.hits}/${v.overallAll.n} (${(v.overallAll.p * 100).toFixed(0)}%).</div>` : ''}

     ${v.longGames ? `
       <div class="muted-xs" style="margin:16px 0 6px">¿El eje de escalado predice las partidas largas?
         (mediana del corpus: ${v.longGames.median.toFixed(1)} min)</div>
       <div class="row"><span class="row-label">Mapas largos</span>
         <span class="row-val">${v.longGames.hits}/${v.longGames.n} ·
           <strong>${(v.longGames.p * 100).toFixed(0)}%</strong><br>
           <span class="muted-xs">IC95 [${(v.longGames.low * 100).toFixed(0)}, ${(v.longGames.high * 100).toFixed(0)}]${
             v.longGames.straddles ? ' — no distingue' : ''}</span></span></div>
       ${v.shortGames ? `<div class="row"><span class="row-label">Mapas cortos</span>
         <span class="row-val">${v.shortGames.hits}/${v.shortGames.n} ·
           ${(v.shortGames.p * 100).toFixed(0)}%<br>
           <span class="muted-xs">control: acá el escalado NO debería predecir</span></span></div>` : ''}
     ` : ''}

     ${cardNarratability(v.narratability, v.n)}
     ${cardSiege(v.siege)}

     ${v.side ? `
       <div class="muted-xs" style="margin:16px 0 6px">Control de sanidad del resolutor de ganadores</div>
       <div class="row"><span class="row-label">Winrate del lado azul</span>
         <span class="row-val">${(v.side.p * 100).toFixed(0)}% en ${v.side.n} mapas<br>
           <span class="muted-xs">IC95 [${(v.side.low * 100).toFixed(0)}, ${(v.side.high * 100).toFixed(0)}]</span></span></div>
       <div class="note ${v.sideSane ? 'note-ok' : 'note-warn'}">
         ${v.sideSane
           ? 'Cae donde tiene que caer para LoL profesional (el azul suele estar entre 50% y 58%). Esto no valida el índice: valida que el ganador inferido de cada mapa no está sesgado hacia un lado.'
           : 'Está fuera del rango esperable para LoL profesional. Eso apunta a que la inferencia de ganadores tiene un sesgo por lado, y si es así todo lo de arriba queda en duda. Vale la pena reindexar y volver a mirar.'}
       </div>` : ''}

     <div class="note">
       <strong>Qué testea esto y qué no.</strong> La muestra es nueva — el backtest original no vio
       estos mapas — pero la <strong>tabla de arquetipos es la misma</strong>: esto mide si la regla
       se sostiene, no si la tabla describe bien a los campeones. Tampoco es el backtest original
       reejecutado: aquel corría sobre datos de Oracle's Elixir con su propia selección de partidos,
       y esta es una reimplementación sobre otro corpus. Una diferencia entre los dos números puede
       venir de la regla, del meta, de la liga o del método de selección, y con estos n no se pueden
       separar. Además el corpus sale del ganador que infiere el sitio: si esa inferencia se
       equivocara de forma sistemática se llevaría puesta la validación entera, y por eso está el
       control de sanidad de arriba.
       ${v.patches?.length ? `Parches en el corpus: ${esc(v.patches.join(', '))}.` : ''}
     </div>`,
    { open: true }
  );
}

/** Barra de winrate con su IC95 dibujado, para que el intervalo se vea. */
function wrBar(ci) {
  if (!ci) return '';
  const pos = (v) => `${Math.max(0, Math.min(100, v * 100)).toFixed(1)}%`;
  return `
    <div class="wr-bar${ci.straddles ? ' straddles' : ''}" title="IC95 [${(ci.low * 100).toFixed(0)}, ${(ci.high * 100).toFixed(0)}]">
      <span class="wr-ci" style="left:${pos(ci.low)};width:${pos(ci.high - ci.low)}"></span>
      <span class="wr-mid"></span>
      <span class="wr-dot" style="left:${pos(ci.p)}"></span>
    </div>`;
}

function cardChampionLayer(la, lb, blue, red) {
  if (!la) {
    const busy = state.metaBuilding;
    return `
    <div class="card">
      <div class="card-head"><h3>Capa de campeón</h3><span class="muted-xs">paso 4</span></div>
      <div class="card-body">
        <p class="muted">${busy
          ? 'Indexando el torneo…'
          : 'Requiere indexar el torneo. gol.gg no es accesible desde el navegador, así que esta capa se reconstruye leyendo los drafts de los partidos ya jugados desde el feed oficial.'}</p>
        <div style="margin-top:12px"><button class="btn" id="build-meta" ${busy ? 'disabled' : ''}>
          ${busy ? 'Indexando…' : 'Indexar torneo'}</button></div>
        <div id="meta-progress">${state.metaProgress ? progressHTML(state.metaProgress) : ''}</div>
        <div class="note">Sin el índice, esta capa está <strong>ausente</strong>, no en cero.
          El análisis de arriba no la incluye.</div>
      </div>
    </div>`;
  }

  const idx = state.metaIndex;
  const row = (c) => {
    const badge = c.admits ? 'badge-ok' : c.status === 'sin-datos' ? 'badge-warn' : 'badge-no';
    const badgeTxt = c.admits ? 'admitido' : c.status === 'sin-datos' ? 'sin datos' : 'excluido';
    const roleTxt = c.roleRow
      ? `${ROLE_LABEL[c.role] ?? c.role}: ${c.roleRow.picks}p${c.roleWr ? ` · ${(c.roleWr.p * 100).toFixed(0)}% (n=${c.roleWr.n})` : ''}`
      : null;
    const patchTxt = c.patchRow
      ? `parche ${c.patch}: ${c.patchRow.picks}p${c.patchWr ? ` · ${(c.patchWr.p * 100).toFixed(0)}%` : ' · sin winrate reportable'}`
      : c.patch ? `sin picks en el parche ${c.patch}` : null;
    return `
    <div class="layer-row">
      <div class="layer-main">
        <div>
          ${championIcon(c.champion) ? `<img class="mini-champ" src="${esc(championIcon(c.champion))}" alt="" loading="lazy">` : ''}
          <strong>${esc(championName(c.champion))}</strong>
          <span class="badge ${badge}">${badgeTxt}</span>
          ${c.presence != null ? `<span class="badge badge-blue">presencia ${(c.presence * 100).toFixed(0)}%</span>` : ''}
        </div>
        <div class="layer-reason">${esc(c.reason)}</div>
        ${c.ci ? wrBar(c.ci) : ''}
        ${roleTxt || patchTxt ? `<div class="layer-split">${[roleTxt, patchTxt].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
        ${c.fallback ? `<div class="layer-split fallback">Respaldo fuera del torneo: ${c.fallback.picks} picks en
          ${c.fallback.sources} torneo(s) indexado(s)${c.fallback.wr ? ` · ${(c.fallback.wr.p * 100).toFixed(0)}%
          IC95 [${(c.fallback.wr.low * 100).toFixed(0)}, ${(c.fallback.wr.high * 100).toFixed(0)}]` : ''}.
          Otra liga es otro meta: sirve para no quedarte a ciegas, no para reemplazar el dato del torneo.</div>` : ''}
      </div>
      <div class="row-val">${c.picks}<div class="muted-xs">picks</div></div>
    </div>`;
  };

  const methodTxt = Object.entries(idx.methods ?? {})
    .map(([k, n]) => `${n} por ${k === 'barrida' ? 'barrida' : k === 'cierre' ? 'mapa de cierre' : 'estado final'}`)
    .join(' · ');

  const body = `
      <div class="note note-ok">
        Resultado atribuido en <strong>${idx.gamesAttributable} de ${idx.gamesCounted}</strong> mapas
        ${methodTxt ? `(${esc(methodTxt)})` : ''}.
        La API no expone el ganador de cada mapa: sale del estado final del mapa y se
        <strong>verifica contra el marcador de la serie</strong> — ${idx.seriesVerified} de
        ${idx.seriesTotal} series verificaron. Las que no verifican quedan con sus mapas ambiguos
        sin atribuir en vez de forzarlos. Los <strong>picks</strong> se cuentan sobre todos los mapas.
      </div>
      ${idx.failures?.any ? `<div class="note note-warn">
        Lectura incompleta: de ${idx.gamesTotal ?? '?'} mapas del torneo se leyeron ${idx.gamesCounted}.
        ${idx.failures.games ? `${idx.failures.games} fallaron al descargar. ` : ''}
        ${idx.failures.emptyDrafts ? `${idx.failures.emptyDrafts} volvieron sin draft. ` : ''}
        ${idx.failures.matches ? `${idx.failures.matches} series no se pudieron leer. ` : ''}
        El n de abajo es menor de lo que debería y eso ensancha los intervalos.
      </div>` : ''}
      <div style="margin-top:12px"><div class="side-label side-blue">${esc(blue.team)}</div>${la.map(row).join('')}</div>
      <div style="margin-top:14px"><div class="side-label side-red">${esc(red.team)}</div>${lb.map(row).join('')}</div>
      <div class="index-foot">
        <button class="btn btn-sm btn-outline" id="rebuild-meta">Reindexar</button>
        <span class="muted-xs">${esc(idx.tournamentSlug ?? '')} · ${idx.gamesCounted} mapas ·
          construido ${esc(new Date(idx.builtAt).toLocaleString('es'))}
          ${idx.duration ? ` · duración media ${idx.duration.mean.toFixed(1)} min` : ''}</span>
      </div>`;

  return collapsible('capa-campeon', 'Capa de campeón', 'solo winrates con 10+ picks', body, { open: true });
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
      <div class="layer-main">
        <div><strong>${esc(p.name)}</strong> <span class="muted-xs">${esc(championName(p.champion))}</span>
          <span class="badge ${p.admits ? 'badge-ok' : p.status === 'observacion' ? 'badge-blue' : 'badge-no'}">
            ${p.admits ? 'entra' : p.status === 'observacion' ? 'observación' : 'sin datos'}</span>
          ${isSub(roster, p) ? '<span class="badge badge-warn">suplente</span>' : ''}</div>
        <div class="layer-reason">${esc(p.reason)}${isSub(roster, p)
          ? ' Está fuera del roster listado: sus pocas partidas se explican por eso, no por un pick raro.' : ''}</div>
        ${p.ci ? wrBar(p.ci) : ''}
        ${p.overall ? `<div class="layer-split">En el torneo: ${(p.overall.p * 100).toFixed(0)}%
          sobre ${p.overall.n} mapas con resultado, IC95 [${(p.overall.low * 100).toFixed(0)}, ${(p.overall.high * 100).toFixed(0)}].
          Es winrate de equipo mirado por jugador, no habilidad individual.</div>` : ''}
        ${p.fallback ? `<div class="layer-split fallback">Respaldo fuera del torneo: ${p.fallback.games} partidas
          con el campeón en los torneos indexados${p.fallback.wr ? ` · ${(p.fallback.wr.p * 100).toFixed(0)}%` : ''}.</div>` : ''}
      </div>
      <div class="row-val">${p.champGames}/${p.seasonGames}<div class="muted-xs">camp./torneo</div></div>
    </div>`).join('');

  const body = `
      <div style="margin-top:2px"><div class="side-label side-blue">${esc(blue.team)}</div>${side(pa, rosterA)}</div>
      <div style="margin-top:14px"><div class="side-label side-red">${esc(red.team)}</div>${side(pb, rosterB)}</div>
      ${risks.map((r) => `<div class="note note-warn">${esc(r)}</div>`).join('')}
      <div class="note">
        El <strong>conteo de partidas</strong> es observación, no regla: acertó 5 veces seguidas y
        después falló en las dos direcciones el mismo día. El winrate solo entra con n≥10 y con el
        IC95 sin cruzar el 50%.
      </div>`;

  return collapsible('capa-jugador', 'Capa de jugador', 'partidas con el campeón / totales en el torneo', body, { open: true });
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

function cardWindow(w, index) {
  const dur = index?.duration ?? null;
  // Contexto real de la liga: una ventana de 25-31 significa algo distinto si el
  // torneo promedia 28 minutos que si promedia 35.
  const durNote = dur
    ? `<div class="note">En este torneo la duración media es <strong>${dur.mean.toFixed(1)} min</strong>
        (mitad de los mapas entre ${dur.p25.toFixed(0)} y ${dur.p75.toFixed(0)}, n=${dur.n}).
        ${w.declared
          ? w.from > dur.p75
            ? 'La ventana declarada cae después del 75% de los mapas: en la mayoría de las partidas el punto de quiebre no llega a jugarse.'
            : w.to < dur.p25
              ? 'La ventana declarada termina antes de que la mayoría de los mapas se decidan.'
              : 'La ventana declarada cae dentro del rango donde se decide la mayoría de los mapas.'
          : 'Sirve igual como referencia para leer el reloj del mapa.'}</div>`
    : '';

  if (!w.declared) {
    return `
    <div class="card">
      <div class="card-head"><h3>Ventana</h3><span class="muted-xs">punto de quiebre como rango</span></div>
      <div class="card-body">
        <p class="muted">Sin ventana declarada.</p>
        <div class="note note-warn">${esc(w.reason)}</div>
        ${durNote}
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
      ${durNote}
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
      ${entry?.result
        ? `<span class="badge badge-ok">registrado: ${entry.result === 'A' ? esc(blue.team) : esc(red.team)}</span>
           <span class="muted-xs">${entry.resultSource === 'auto'
             ? 'resuelto solo desde el frame final, verificado contra el marcador de la serie'
             : 'cargado a mano'}</span>`
        : ''}
    </div>
  </div>`;
}

function cardReading(score, prob, stance, blue, red, dis, entry, resolved = null) {
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
  return collapsible(
    'checklist',
    'Checklist de matchup',
    'relaciones estables entre parches',
    `<ul class="checklist">${MATCHUP_CHECKLIST.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`
  );
}

const progressHTML = (p) => `
  <div class="muted-xs" style="margin-top:8px">${esc(p.label ?? '')} ${p.done ?? 0}/${p.total || '?'}</div>
  <div class="progress"><i style="width:${p.total ? ((p.done / p.total) * 100).toFixed(1) : 0}%"></i></div>`;

/**
 * Indexa el torneo solo, sin esperar a que alguien apriete un botón.
 *
 * Las capas 4 y 5 estaban detrás de un click, así que en la práctica el análisis
 * se leía casi siempre sin ellas y los pasos del método quedaban afuera. Si ya
 * hay índice en caché se usa; si no, se construye en segundo plano y el informe
 * se vuelve a armar cuando termina.
 */
async function autoIndex() {
  const tid = state.tournament?.id ?? ligaActiva().id;
  if (!tid) return;
  if (state.metaBuilding || state.autoIndexTried.has(tid)) return;
  state.autoIndexTried.add(tid);

  const cached = cachedIndices().find((i) => i.tournamentId === tid);
  if (cached) {
    state.metaIndex = cached;
    if (state.matchId && state.view === 'match') openMatch(state.matchId, { quiet: true });
    return;
  }
  runMetaIndex(null);
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
    runMetaIndex(rebuild, { force: true });
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
      <div class="ledger-btns">
        ${e.matchId ? `<button class="btn btn-sm btn-outline" data-open="${esc(e.matchId)}|${esc(e.gameId)}">abrir</button>` : ''}
        <button class="btn btn-sm btn-outline" data-del="${esc(e.gameId)}">borrar</button>
      </div>
    </div>`).join('');

  $('#content').innerHTML = `
  <div class="card">
    <div class="card-head"><h3>Registro de predicciones</h3>
      <span class="muted-xs">la calibración solo se construye con predicciones escritas antes</span></div>
    <div class="card-body">
      <div class="live-grid">
        ${metric('Registradas', s.total, `${s.resolved} con resultado${s.autoResolved ? ` · ${s.autoResolved} resueltas solas` : ''}`)}
        ${metric('Brier (todas)', s.brierAll ? s.brierAll.brier.toFixed(4) : '—',
          s.brierAll ? `n=${s.brierAll.n} · 0.25 = predecir 50% siempre` : 'hace falta cargar resultados')}
        ${metric('Brier (solo previas)', s.brierPreGame ? s.brierPreGame.brier.toFixed(4) : '—',
          s.brierPreGame ? `n=${s.brierPreGame.n}` : 'sin predicciones previas resueltas')}
        ${metric('Aciertos', s.hits ? `${s.hits.hits}/${s.hits.n}` : '—',
          s.hits ? `${pct(s.hits.rate)} — correcto no es informativo` : '')}
        ${metric('Anticipó el movimiento', s.clv ? `${s.clv.anticipated}/${s.clv.n}` : '—',
          s.clv ? `${pct(s.clv.rate)} · proxy de CLV` : 'hace falta apertura y cierre de precio')}
      </div>

      ${s.paired ? `
        <div class="paired">
          <div class="paired-head">Contra el mercado, sobre los mismos ${s.paired.n} mapas</div>
          <div class="paired-bars">
            <div class="paired-row"><span>Modelo</span>
              <div class="pb"><i style="width:${Math.min(100, s.paired.own * 200)}%"></i></div>
              <strong>${s.paired.own.toFixed(4)}</strong></div>
            <div class="paired-row"><span>Mercado</span>
              <div class="pb mkt"><i style="width:${Math.min(100, s.paired.market * 200)}%"></i></div>
              <strong>${s.paired.market.toFixed(4)}</strong></div>
          </div>
          <div class="muted-xs">${s.paired.edge > 0
            ? `El modelo va ${s.paired.edge.toFixed(4)} por debajo del mercado en Brier sobre este subconjunto. Con n=${s.paired.n} eso todavía no distingue nada: hace falta muchísima más muestra antes de tratarlo como edge.`
            : `El mercado va ${(-s.paired.edge).toFixed(4)} por debajo. Es el resultado esperado y el motivo de la postura NO BET.`}</div>
        </div>`
        : `<div class="note note-warn">Todavía no hay ningún mapa con predicción, resultado y precio a la vez,
             que es lo único que permite comparar contra el mercado. El Brier de arriba, solo, no dice
             si el análisis aporta: hay que compararlo con el precio sobre los mismos partidos.</div>`}

      <div class="note">
        La referencia del backtest es <strong>Brier 0.2368 propio contra 0.2353 del mercado</strong>,
        con λ*=0. Si tu Brier no baja de eso de forma sostenida, el número propio no está aportando
        sobre el precio y la postura NO BET sigue siendo la correcta.
      </div>

      ${(() => {
        const rs = ledger.scoreReglas(s.entries);
        const filas = rs.map((r) => `
          <div class="layer-row">
            <div>
              <div><strong>${esc(r.nombre)}</strong></div>
              <div class="layer-reason">${r.n
                ? `${r.hits}/${r.n} · IC95 [${(r.ic[0]*100).toFixed(0)}, ${(r.ic[1]*100).toFixed(0)}]`
                : 'todavía sin partidos resueltos donde la regla se pronuncie'}</div>
            </div>
            <div class="row-val">${r.p != null ? `${(r.p*100).toFixed(0)}%` : '—'}</div>
          </div>`).join('');
        return `
        <div style="margin-top:16px">
          <div class="muted-xs" style="margin-bottom:6px"><strong>Reglas en prueba</strong></div>
          ${filas}
          <div class="note">
            Cada regla se congela ANTES del resultado y se puntúa sola. La del teamfight con
            récord parejo está acá por pedido: hacia atrás da 50% [45, 55] sobre 377 mapas,
            contra 56% de simplemente elegir el lado azul. Si en vivo se porta distinto, esto lo
            va a mostrar sin que haya que discutirlo — y ese es el único camino por el que una
            señal se asciende a regla en este proyecto.
          </div>
        </div>`;
      })()}

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
  document.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => {
      const [matchId, gameId] = b.dataset.open.split('|');
      state.view = 'match';
      openMatch(matchId, { gameId, push: true });
    })
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

/**
 * Construye el índice del torneo. `btn` puede ser null: en ese caso corre en
 * segundo plano y solo informa por la barra de la barra lateral.
 */
async function runMetaIndex(btn, { force = false } = {}) {
  if (state.metaBuilding) return;
  state.metaBuilding = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Indexando…'; }

  const paint = (p) => {
    state.metaProgress = p;
    const box = document.getElementById('meta-progress');
    if (box) box.innerHTML = progressHTML(p);
    const pill = $('#index-pill');
    if (pill) {
      pill.hidden = false;
      pill.textContent = `${p.label ?? 'Indexando'} ${p.done ?? 0}${p.total ? `/${p.total}` : ''}`;
    }
  };

  try {
    const ligaIdx = ligaActiva();
    state.metaIndex = await buildTournamentIndex(ligaIdx.id, state.tournament, {
      league: ligaIdx,
      force,
      onProgress: paint,
    });
    state.globalIndex = aggregateIndices(cachedIndices());
    state.metaProgress = null;
    const pill = $('#index-pill');
    if (pill) pill.hidden = true;
    if (state.matchId && state.view === 'match') await openMatch(state.matchId, { force: true });
  } catch (e) {
    state.metaProgress = null;
    const box = document.getElementById('meta-progress');
    if (box) box.innerHTML = `<div class="err" style="margin-top:10px">No se pudo indexar: ${esc(e.message)}</div>`;
    const pill = $('#index-pill');
    if (pill) { pill.hidden = false; pill.textContent = 'falló el indexado'; }
  } finally {
    state.metaBuilding = false;
    if (btn?.isConnected) { btn.disabled = false; btn.textContent = 'Indexar torneo'; }
  }
}

/* ------------------------------------------------------------------ *
 * diagnóstico: cada hueco con su acción
 * ------------------------------------------------------------------ */

function bindDiagnostics(players, riotMap) {
  const run = (id) => {
    if (id === 'indexar' || id === 'reindexar') {
      const target = document.getElementById('build-meta') ?? document.getElementById('rebuild-meta');
      if (state.tournament?.id) {
        // Un intento fallido no puede dejar el auto-indexado bloqueado para siempre.
        state.autoIndexTried.delete(state.tournament.id);
        if (id === 'reindexar') clearIndexCache(state.tournament.id);
      }
      return runMetaIndex(target, { force: id === 'reindexar' });
    }
    if (id === 'indexar-mas') return openLeaguePicker();
    if (id === 'abrir-editor') return openChampionEditor(players, riotMap);
    if (id === 'comparar-parche') return document.getElementById('patch-diff')?.click();
    if (id === 'cargar-precio') {
      const input = document.getElementById('odds-a');
      input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      input?.focus();
      return undefined;
    }
    return undefined;
  };

  document.querySelectorAll('[data-diag]').forEach((b) =>
    b.addEventListener('click', () => run(b.dataset.diag))
  );

  // Resolver todo: ejecuta cada acción pendiente en orden, sin que haya que ir
  // ítem por ítem. Lo que no se puede automatizar (cargar una cuota, puntuar un
  // campeón) queda señalado al final en vez de simularse.
  document.getElementById('fix-all')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const ids = [...new Set(
      [...document.querySelectorAll('[data-diag]')].map((b) => b.dataset.diag)
    )].filter((id) => id === 'indexar' || id === 'reindexar' || id === 'comparar-parche' || id === 'indexar-mas');

    const manual = state.diagnostics?.items.filter(
      (i) => i.action && ['abrir-editor', 'cargar-precio'].includes(i.action.id)
    ) ?? [];

    for (const id of ids) {
      if (id === 'indexar-mas') continue; // abre un diálogo: no va en una cadena automática
      btn.textContent = id === 'comparar-parche' ? 'Comparando parche…' : 'Indexando torneo…';
      try { await run(id); } catch { /* seguimos con el resto */ }
    }
    // El panel se rearma solo al terminar, así que el estado del botón se pierde.
    // La confirmación se guarda aparte para que quede visible después del repintado.
    state.fixAll = { at: Date.now(), ran: ids.filter((i) => i !== 'indexar-mas').length, manual: manual.length };
    btn.textContent = manual.length
      ? `Quedan ${manual.length} que dependen de vos`
      : 'Todo lo automatizable, hecho';
    if (state.matchId && state.view === 'match') openMatch(state.matchId, { quiet: true });
  });
}

/** Diálogo para puntuar campeones que no están en ninguna tabla. */
function openChampionEditor(players, riotMap) {
  const all = [...new Set(players.map((p) => p.champion))];
  // Primero los que no están clasificados, después los que discrepan con Riot.
  const priority = all.filter((c) => classificationOf(c) !== 'congelado');
  const list = priority.length ? [...priority, ...all.filter((c) => !priority.includes(c))] : all;
  openModal('Clasificar campeones', championEditor(list, riotMap));

  document.querySelectorAll('[data-save-champ]').forEach((b) =>
    b.addEventListener('click', () => {
      const champ = b.dataset.saveChamp;
      const values = {};
      document.querySelectorAll(`[data-champ="${CSS.escape(champ)}"]`).forEach((i) => {
        values[i.dataset.ax] = i.value;
      });
      setManualProfile(champ, values);
      closeModal();
      openMatch(state.matchId, { force: true });
    })
  );
  document.querySelectorAll('[data-reset-champ]').forEach((b) =>
    b.addEventListener('click', () => {
      setManualProfile(b.dataset.resetChamp, null);
      closeModal();
      openMatch(state.matchId, { force: true });
    })
  );
}

/**
 * Cuántos splits se traen al indexar una liga.
 *
 * Tres: el vigente y los dos anteriores del mismo año, que es lo que la API
 * ofrece sin irse a 2025. Con uno solo el corpus quedaba en 142 series y las
 * mediciones por liga salían con intervalos que cruzan el 50% en casi todas.
 */
const SPLITS_A_INDEXAR = 3;

/** Indexar otra liga para que los campeones sin muestra local tengan respaldo. */
function openLeaguePicker() {
  const cached = new Set(cachedIndices().map((i) => i.leagueId));
  const rows = LEAGUES.map((l) => `
    <div class="editor-row">
      <div><strong>${esc(l.name)}</strong> <span class="muted-xs">${esc(l.region)}</span>
        <div class="muted-xs">${cached.has(l.id) ? 'ya indexada' : 'sin indexar'}</div></div>
      <button class="btn btn-sm" data-index-league="${esc(l.key)}" ${l.key === state.league.key ? 'disabled' : ''}>
        ${l.key === state.league.key ? 'liga actual' : 'Indexar'}</button>
    </div>`).join('');

  openModal(
    'Indexar otra liga',
    `<div class="note">Un campeón con 6 picks en esta liga puede tener 20 sumando otras ya indexadas.
       Ese agregado aparece como <strong>respaldo etiquetado</strong>, nunca reemplazando el dato del
       torneo: otra liga es otro meta, y el paso 4 pide el winrate <em>de este torneo</em>.</div>
     ${rows}`
  );

  document.querySelectorAll('[data-index-league]').forEach((b) =>
    b.addEventListener('click', async () => {
      const league = LEAGUES.find((l) => l.key === b.dataset.indexLeague);
      b.disabled = true;
      b.textContent = 'Indexando…';
      try {
        // Se indexa el split vigente Y los dos anteriores. Con uno solo, ligas
        // como LCK quedaban en 23 series y el récord de equipo se medía con un
        // intervalo de [22, 59] — o sea, no se medía. Cada torneo se guarda
        // aparte, así que las medidas por parche siguen pudiendo filtrar.
        const ts = await getRecentTournaments(league.id, SPLITS_A_INDEXAR).catch(() => []);
        if (!ts.length) throw new Error('La liga no devolvió torneos.');
        let hechos = 0;
        for (const t of ts) {
          await buildTournamentIndex(league.id, t, {
            league,
            onProgress: (p) => {
              const paso = `${hechos + 1}/${ts.length}`;
              b.textContent = `${paso} · ${p.done ?? 0}${p.total ? `/${p.total}` : ''}`;
            },
          });
          hechos++;
        }
        state.globalIndex = aggregateIndices(cachedIndices());
        b.textContent = `listo (${hechos} split${hechos === 1 ? '' : 's'})`;
        if (state.matchId) openMatch(state.matchId, { force: true });
      } catch (e) {
        b.textContent = 'falló';
        b.title = e.message;
      }
    })
  );
}

function openModal(title, html) {
  closeModal();
  const el = document.createElement('div');
  el.className = 'modal-back';
  el.id = 'modal';
  el.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title)}</h3>
        <button class="btn-ghost" id="modal-close" aria-label="Cerrar">✕</button></div>
      <div class="modal-body">${html}</div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => { if (e.target === el) closeModal(); });
  document.getElementById('modal-close').addEventListener('click', closeModal);
}

function closeModal() {
  document.getElementById('modal')?.remove();
}

init();
