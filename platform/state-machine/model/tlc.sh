#!/usr/bin/env bash
# OS-211 (OS-112): run TLC on the spinoff row model (Spinoff.tla, Spinoff.cfg). Exits non-zero when an
# invariant or property breaks, printing TLC's shortest trace. `bunx moon run state-machine:tlc` runs it, and
# CI's `tla` job runs it on every PR.
#
# TLC is tla2tools.jar v1.7.4 from github.com/tlaplus/tlaplus, fetched once into ~/.cache/tla and checked
# against its sha256; TLA2TOOLS_JAR points at another copy. Java is `java` on PATH, else mise's temurin-17.
# `-deadlock` turns the deadlock check off: `failed` is terminal by design, so a behaviour that ends there is not a fault.
set -euo pipefail
cd "$(dirname "$0")"

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
meta="$(mktemp -d "$tmp/tlc-spinoff-XXXXXX")"
trap 'rm -rf "$meta"' EXIT
"${JAVA[@]}" -Djava.io.tmpdir="$tmp" -XX:+UseParallelGC -cp "$JAR" tlc2.TLC \
  -deadlock -workers auto -metadir "$meta" -config Spinoff.cfg Spinoff.tla
