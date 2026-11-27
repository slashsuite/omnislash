#!/usr/bin/env bash
# OS-211 (OS-112): run TLC on each model here: the spinoff row (Spinoff.tla) and, since OS-249, the team
# restart (TeamRestart.tla), each with its own .cfg. `tlc.sh <Model>...` runs only those. Exits non-zero when
# an invariant or property breaks, printing TLC's shortest trace. `bunx moon run state-machine:tlc` runs it, and
# CI's `tla` job runs it on every PR.
#
# TLC is tla2tools.jar v1.7.4 from github.com/tlaplus/tlaplus, fetched once into ~/.cache/tla and checked
# against its sha256; TLA2TOOLS_JAR points at another copy. Java is `java` on PATH, else mise's temurin-17.
# `-deadlock` turns the deadlock check off: `failed` is terminal by design, and the restart model's sends and runs
# are bounded, so a behaviour that ends there is not a fault.
set -euo pipefail
# --here runs the models in the current directory (mutants.ts's mutated copies) instead of this one.
if [ "${1:-}" = "--here" ]; then shift; else cd "$(dirname "$0")"; fi

VERSION=1.7.4
SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
JAR="${TLA2TOOLS_JAR:-${XDG_CACHE_HOME:-$HOME/.cache}/tla/tla2tools-$VERSION.jar}"

if [ ! -f "$JAR" ]; then
  mkdir -p "$(dirname "$JAR")"
  curl -fsSL -o "$JAR.part" "https://github.com/tlaplus/tlaplus/releases/download/v$VERSION/tla2tools.jar"
  mv "$JAR.part" "$JAR"
fi
if [ -z "${TLA2TOOLS_JAR:-}" ]; then
  echo "$SHA256  $JAR" | sha256sum -c --quiet - || { echo "tlc.sh: $JAR is not tla2tools v$VERSION (sha256 differs)" >&2; exit 2; }
fi

if java -version >/dev/null 2>&1; then JAVA=(java)
elif command -v mise >/dev/null 2>&1; then JAVA=(mise exec java@temurin-17 -- java)
else echo "tlc.sh: no java on PATH and no mise to fetch one" >&2; exit 2
fi

tmp="${TMPDIR:-$HOME/.cache/tmp}"
mkdir -p "$tmp"
MODELS=("$@")
[ ${#MODELS[@]} -gt 0 ] || MODELS=(Spinoff TeamRestart)
for model in "${MODELS[@]}"; do
  meta="$(mktemp -d "$tmp/tlc-$model-XXXXXX")"
  echo "tlc.sh: $model"
  status=0
  "${JAVA[@]}" -Djava.io.tmpdir="$tmp" -XX:+UseParallelGC -cp "$JAR" tlc2.TLC \
    -deadlock -workers auto -metadir "$meta" -config "$model.cfg" "$model.tla" || status=$?
  rm -rf "$meta"
  [ "$status" -eq 0 ] || exit "$status"
done
