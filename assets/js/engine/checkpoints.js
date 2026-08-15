/**
 * checkpoints.js — estado en minutos exactos y desglose por jugador.
 *
 * El feed responde `window/{id}?startingTime=T` con ~45 frames que abarcan unos
 * 10 segundos alrededor de T (verificado). O sea que NO devuelve un histórico:
 * para tener el estado del minuto 15 hay que pedir el minuto 15. Eso es barato
 * para dos checkpoints y caro para una curva completa, así que la curva es
 * opcional y se muestrea cada 2 minutos.
 *
 * Esto es lo que permite cumplir el Paso 9 en serio: "anotá el estado del
 * minuto ~16 y del ~20 antes de saber el resultado".
 */

import { getWindow, getDetails, feedTimestamp, pool } from '../api.js';

/** Los dos minutos que el skill nombra explícitamente. */
export const CHECKPOINTS = [15, 20];

/** startingTime para el minuto N de una partida que arrancó en startTs. */
export function timestampForMinute(startTs, minute) {
  const t = new Date(startTs).getTime() + minute * 60_000;
  return feedTimestamp(0, t);
}

/**
 * Estado en un minuto exacto. Devuelve el último frame de window y el de
 * details, o null si ese minuto todavía no ocurrió.
 */
export async function stateAtMinute(gameId, startTs, minute) {
  if (!startTs) return null;
  const target = new Date(startTs).getTime() + minute * 60_000;
  // El feed va ~90 s por detrás del vivo: pedir el futuro devuelve vacío.
  if (target > Date.now() - 90_000) return null;

  const ts = timestampForMinute(startTs, minute);
  // Un minuto ya jugado no vuelve a cambiar: se cachea largo.
  const HISTORIC = 3_600_000;
  try {
    const [w, d] = await Promise.all([
      getWindow(gameId, ts, HISTORIC),
      getDetails(gameId, ts, HISTORIC).catch(() => null),
    ]);
    const frame = w?.frames?.slice(-1)[0] ?? null;
    if (!frame) return null;
    return { minute, frame, detailsFrame: d?.frames?.slice(-1)[0] ?? null, requestedAt: ts };
  } catch {
    return null;
  }
}

/** Curva de oro muestreada cada `step` minutos. Opt-in: una petición por punto. */
export async function goldCurve(gameId, startTs, untilMinute, step = 2, onProgress) {
  const points = [];
  for (let m = step; m <= untilMinute; m += step) points.push(m);
  let done = 0;
  const { results, failures } = await pool(points, 5, async (m) => {
    const st = await stateAtMinute(gameId, startTs, m);
    onProgress?.(++done, points.length);
    if (!st) return null;
    return {
      minute: m,
      blue: st.frame.blueTeam?.totalGold ?? null,
      red: st.frame.redTeam?.totalGold ?? null,
    };
  });
  return { points: results.filter(Boolean), failures: failures.length };
}

/**
 * Une el frame de window (oro, nivel, KDA, CS) con el de details (damage share,
 * participación en kills, wards, ítems) para cada jugador de cada lado.
 */
export function mergePlayers(frame, detailsFrame, sides) {
  if (!frame) return null;
  const wById = {};
  for (const p of [
    ...(frame.blueTeam?.participants ?? []),
    ...(frame.redTeam?.participants ?? []),
  ]) {
    wById[p.participantId] = p;
  }
  const dById = {};
  for (const p of detailsFrame?.participants ?? []) dById[p.participantId] = p;

  const build = (side) =>
    side.players.map((p) => {
      const w = wById[p.participantId] ?? null;
      const d = dById[p.participantId] ?? null;
      return {
        ...p,
        gold: w?.totalGold ?? d?.totalGoldEarned ?? null,
        level: w?.level ?? d?.level ?? null,
        kills: w?.kills ?? d?.kills ?? 0,
        deaths: w?.deaths ?? d?.deaths ?? 0,
        assists: w?.assists ?? d?.assists ?? 0,
        cs: w?.creepScore ?? d?.creepScore ?? null,
        damageShare: d?.championDamageShare ?? null,
        killParticipation: d?.killParticipation ?? null,
        wardsPlaced: d?.wardsPlaced ?? null,
        wardsDestroyed: d?.wardsDestroyed ?? null,
        items: d?.items ?? null,
        hasDetails: !!d,
      };
    });

  return { a: build(sides.a), b: build(sides.b) };
}

const ROLES = ['top', 'jungle', 'mid', 'bottom', 'support'];

/**
 * Diferencial de oro por rol. Es lo que verifica la afirmación del Paso 7:
 * el sitio dice antes dónde se concentra el margen, y esto dice dónde se
 * concentró de verdad.
 */
export function roleGoldDiff(merged, sides) {
  if (!merged) return [];
  const pick = (arr, role) => arr.find((p) => p.role === role) ?? null;
  return ROLES.map((role) => {
    const a = pick(merged.a, role);
    const b = pick(merged.b, role);
    const diff = a?.gold != null && b?.gold != null ? a.gold - b.gold : null;
    return {
      role,
      a,
      b,
      diff,
      favors: diff == null || diff === 0 ? null : diff > 0 ? sides.a.team : sides.b.team,
    };
  });
}

/**
 * ¿Dónde se concentró el oro de verdad? Devuelve los roles ordenados por
 * magnitud, para contrastar contra la concentración predicha por el draft.
 */
export function goldConcentration(roleDiffs) {
  const withDiff = roleDiffs.filter((r) => r.diff != null);
  if (!withDiff.length) return null;
  const sorted = [...withDiff].sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  const total = withDiff.reduce((s, r) => s + Math.abs(r.diff), 0);
  const top2 = sorted.slice(0, 2);
  return {
    top: sorted,
    // Cuánto del desequilibrio total vive en las dos posiciones más marcadas.
    share: total > 0 ? top2.reduce((s, r) => s + Math.abs(r.diff), 0) / total : null,
  };
}

/**
 * Señales que solo salen del feed `details`, que hasta ahora se pedía y se
 * descartaba. Todas son falsables y con umbral explícito.
 */
export function detailSignals(merged, sides, minute) {
  if (!merged) return [];
  const out = [];
  const all = [
    ...merged.a.map((p) => ({ ...p, team: sides.a.team })),
    ...merged.b.map((p) => ({ ...p, team: sides.b.team })),
  ];
  if (!all.some((p) => p.hasDetails)) return [];

  // 1. Quién carga de verdad: mayor participación en el daño de su equipo.
  for (const [side, label] of [[merged.a, sides.a.team], [merged.b, sides.b.team]]) {
    const withDmg = side.filter((p) => p.damageShare != null);
    if (!withDmg.length) continue;
    const top = withDmg.reduce((m, p) => (p.damageShare > m.damageShare ? p : m));
    out.push({
      id: `carry-${label}`,
      label: `Carga el daño de ${label}`,
      value: `${top.champion} ${(top.damageShare * 100).toFixed(0)}% del daño`,
      reading:
        top.damageShare >= 0.32
          ? 'Concentración alta: si cae ese jugador, el equipo se queda sin daño.'
          : 'Daño repartido entre varios.',
      ok: top.damageShare < 0.32,
    });
  }

  // 2. Oro sin daño: recursos invertidos que no se convirtieron.
  const idle = all.filter(
    (p) =>
      p.damageShare != null &&
      p.role !== 'support' &&
      p.gold != null &&
      minute >= 14 &&
      p.damageShare < 0.14 &&
      p.gold >= 8000
  );
  out.push({
    id: 'gold-no-damage',
    label: 'Oro sin daño',
    value: idle.length
      ? idle.map((p) => `${p.champion} (${p.team}) ${p.gold.toLocaleString('es')} oro, ${(p.damageShare * 100).toFixed(0)}% daño`).join(' · ')
      : 'Nadie destacado',
    reading: idle.length
      ? 'Ese jugador tiene recursos y no los está convirtiendo en daño.'
      : 'Nadie con oro alto y daño bajo.',
    ok: idle.length === 0,
  });

  // 3. Participación en kills: quién está fuera de las peleas.
  const absent = all.filter(
    (p) => p.killParticipation != null && minute >= 14 && p.killParticipation < 0.4
  );
  out.push({
    id: 'kill-participation',
    label: 'Participación en kills baja',
    value: absent.length
      ? absent.map((p) => `${p.champion} (${p.team}) ${(p.killParticipation * 100).toFixed(0)}%`).join(' · ')
      : 'Todos por encima del 40%',
    reading: absent.length
      ? 'Está farmeando o muriendo fuera de las peleas que deciden.'
      : 'Nadie desconectado de las peleas.',
    ok: absent.length === 0,
  });

  // 4. Visión, que es el insumo del control de objetivos.
  const wards = (side) =>
    side.reduce((s, p) => s + (p.wardsPlaced ?? 0), 0);
  const wa = wards(merged.a);
  const wb = wards(merged.b);
  if (wa || wb) {
    out.push({
      id: 'vision',
      label: 'Wards colocadas',
      value: `${sides.a.team} ${wa} · ${sides.b.team} ${wb}`,
      reading:
        Math.abs(wa - wb) >= 10
          ? `${wa > wb ? sides.a.team : sides.b.team} controla la visión, que es lo que decide el pulso alrededor de objetivos.`
          : 'Visión pareja.',
      ok: Math.abs(wa - wb) < 10,
    });
  }

  return out;
}
