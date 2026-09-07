#!/usr/bin/env bash
# Guarda el estado de la cola, el corpus de Elo y el registro de resultados.
#
# Vive en su propio archivo porque ahora se llama DOS veces: cada cierto rato
# durante la vigilancia larga y una vez al final. Si esto no guarda, la corrida
# siguiente vuelve a mandar lo mismo: perder el registro de "ya avisado" es
# exactamente el bug de los avisos repetidos en Discord.
set -u

ARCHIVOS="tools/wire-state.json tools/elo-corpus.json tools/results-log.json"

if [ -z "$(git status --porcelain $ARCHIVOS)" ]; then
  echo "sin cambios en el estado"; exit 0
fi

git config user.name  "checkmatch-wire"
git config user.email "wire@users.noreply.github.com"

for intento in 1 2 3 4 5; do
  git add $ARCHIVOS
  if git diff --cached --quiet; then echo "nada que commitear"; exit 0; fi
  git commit -m "wire: estado de la cola [skip ci]"
  if git push; then
    echo "estado guardado (intento $intento)"; exit 0
  fi

  echo "push rechazado: otra corrida empujó primero. Uniendo en vez de descartar."
  git fetch origin main
  git show origin/main:tools/wire-state.json > /tmp/remoto-wire.json 2>/dev/null || echo '{}' > /tmp/remoto-wire.json
  # Unir NUESTRO estado con el del remoto. Lo de los dos sobrevive.
  node tools/merge-state.mjs /tmp/remoto-wire.json tools/wire-state.json
  cp tools/wire-state.json /tmp/unido-wire.json
  cp tools/elo-corpus.json /tmp/unido-corpus.json
  # Alinearse con el remoto y volver a poner lo unido encima.
  git reset --hard origin/main
  cp /tmp/unido-wire.json tools/wire-state.json
  cp /tmp/unido-corpus.json tools/elo-corpus.json
done

echo "no se pudo guardar el estado tras 5 intentos" >&2
exit 1
