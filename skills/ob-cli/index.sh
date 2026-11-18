#!/usr/bin/env bash
# ob-cli index.sh: print the LIVE `ob` command index, grouped by section.
# Loads it fresh from `ob --help` each run, so it is current by construction
# (the `ob` surface changes fast; a static snapshot would go stale).
# Usage: bash skills/ob-cli/index.sh
set -euo pipefail

help="$(ob --help 2>&1)"

printf '%s\n' "$help" | awk '
  /^[^ ].*:$/ && NR > 2 { print "\n" $0; next }          # section header (col 0, ends ":")
  NR > 5 && /^ {2,8}[a-z]/ {                            # command or subcommand decl
    line = $0
    sub(/^ {2,}/, "", line)                              # strip the decl indent
    sub(/ {2,}.*$/, "", line)                            # drop prose after the usage
    if (length(line) > 112) line = substr(line, 1, 112) "..."
    if (length(line) > 0) print "  " line
    next
  }
'
