/**
 * merge-state.mjs — une el estado local con el que ya está en el remoto.
 *
 * POR QUÉ EXISTE
 *
 * El estado del wire se guardaba una sola vez, al final de la corrida. Con la
 * vigilancia continua las corridas pasaron a durar 25 minutos y el cron a
 * dispararse cada 5, así que empezaron a solaparse: medido sobre 39 corridas,
 * 18 se pisaron, hasta 21 minutos en paralelo, y 11 terminaron en fallo.
 *
 * Dos corridas simultáneas leen el mismo `notified`, las dos creen que el aviso
 * está pendiente y las dos lo mandan a Discord. Y cuando la segunda no puede
 * empujar porque la primera ya movió el archivo, su registro de "ya avisado" se
 * pierde, así que la corrida siguiente lo manda otra vez. De ahí los avisos
 * repetidos.
 *
 * La causa principal se ataca en el workflow (que las corridas no se solapen).
 * Esto es la red de seguridad: si igual chocan, el estado se UNE en vez de que
 * gane uno y el otro pierda lo suyo. Perder un `notified` significa spamear.
 *
 * Se usa así, con el archivo del remoto ya guardado aparte:
 *   node tools/merge-state.mjs <archivo-remoto> <archivo-local>
 * y deja el resultado unido en el archivo local.
 */

import fs from 'node:fs';

const [remotoPath, localPath] = process.argv.slice(2);
if (!remotoPath || !localPath) {
  console.error('uso: node tools/merge-state.mjs <remoto.json> <local.json>');
  process.exit(1);
}

const leer = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
};

const remoto = leer(remotoPath);
const local = leer(localPath);

/** Une dos mapas de id -> fecha ISO, quedándose con la MÁS VIEJA. */
function unirFechas(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    // La más vieja es la del primer envío real: si dos corridas avisaron lo
    // mismo, la que vale como "ya estaba avisado" es la primera.
    out[k] = out[k] && out[k] < v ? out[k] : v;
  }
  return out;
}

/** Une las colas de publicaciones, respetando lo ya publicado. */
function unirPosts(a = {}, b = {}) {
  const out = { ...a };
  for (const [id, post] of Object.entries(b)) {
    const previo = out[id];
    if (!previo) { out[id] = post; continue; }
    // `posted` es irreversible: si cualquiera de los dos lo publicó, quedó publicado.
    out[id] = { ...previo, ...post, posted: previo.posted || post.posted };
  }
  return out;
}

const salida = { ...remoto, ...local };

// cml:wire:v1 guarda la cola como STRING de JSON.
const colaDe = (o) => { try { return JSON.parse(o['cml:wire:v1'] ?? '{}'); } catch { return {}; } };
const colaR = colaDe(remoto);
const colaL = colaDe(local);
if (colaR.posts || colaL.posts) {
  salida['cml:wire:v1'] = JSON.stringify({
    ...colaR, ...colaL,
    posts: unirPosts(colaR.posts, colaL.posts),
  });
}

// cml:wire:notified es lo crítico: perderlo significa volver a avisar.
const notifDe = (o) => { try { return JSON.parse(o['cml:wire:notified'] ?? '{}'); } catch { return {}; } };
salida['cml:wire:notified'] = JSON.stringify(
  unirFechas(notifDe(remoto), notifDe(local))
);

// La pausa por cuota agotada: gana la MÁS LEJANA, que es la más prudente.
const pR = Number(remoto['cml:wire:paused-until'] ?? 0);
const pL = Number(local['cml:wire:paused-until'] ?? 0);
if (pR || pL) salida['cml:wire:paused-until'] = String(Math.max(pR, pL));

fs.writeFileSync(localPath, JSON.stringify(salida, null, 2) + '\n');

const cuenta = (s) => Object.keys(JSON.parse(s ?? '{}')).length;
console.log(
  `Estado unido: ${Object.keys(unirPosts(colaR.posts, colaL.posts)).length} publicaciones, ` +
  `${cuenta(salida['cml:wire:notified'])} avisos registrados ` +
  `(remoto ${cuenta(remoto['cml:wire:notified'])}, local ${cuenta(local['cml:wire:notified'])}).`
);
