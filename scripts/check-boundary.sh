#!/usr/bin/env bash
#
# The two standing rules that are cheap to check and expensive to lose.
#
#   1. No storage knowledge in the frontend  (`plan.md` standing rule 1)
#   2. No literal values in components       (`plan.md` standing rule 2)
#
# Grep rather than tooling, deliberately. These rules should still be checkable
# in ten years, by someone reading this file, with no toolchain installed. The
# ESLint rule in `apps/web/eslint.config.mjs` covers rule 1 as well; two
# independent checks mean neither can be quietly switched off.
#
# Written for bash 3.2, which is what macOS ships — no `mapfile`, no associative
# arrays. Being runnable matters more here than being modern.

set -o pipefail

WEB="apps/web"

# The one file permitted to hold literal values, by definition: it is where
# every token is defined (`design.md` §6.1).
TOKENS="$WEB/app/tokens.css"

# `@font-face` has to name the family it is declaring, so the font file is
# exempt from the font-family check only. It is still checked for everything else.
FONTS="$WEB/app/fonts.css"

status=0

fail() {
  printf '\n\xe2\x9c\x97 %s\n' "$1"
  status=1
}

ALL=$(mktemp)
COMPONENTS=$(mktemp)
STYLED=$(mktemp)
trap 'rm -f "$ALL" "$COMPONENTS" "$STYLED"' EXIT

# Source files only: no build output, no dependencies, no font binaries.
find "$WEB" \
  -type d \( -name node_modules -o -name .next -o -name out \) -prune -o \
  -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' -o -name '*.css' \) \
  -print | sort > "$ALL"

if [ ! -s "$ALL" ]; then
  fail "found no frontend sources — is this being run from the repository root?"
  exit 1
fi

grep -v -x -F "$TOKENS" "$ALL" > "$COMPONENTS"
grep -v -x -F "$FONTS" "$COMPONENTS" > "$STYLED"

# Reports every match of $2 in the file list $3, under the heading $1.
# An optional $4 is a pattern for matches that are legitimate and filtered out.
check() {
  local heading="$1" pattern="$2" list="$3" allowed="${4:-}" hits
  hits=$(xargs grep -nE "$pattern" < "$list" 2>/dev/null)
  if [ -n "$hits" ] && [ -n "$allowed" ]; then
    hits=$(printf '%s\n' "$hits" | grep -vE "$allowed")
  fi
  if [ -n "$hits" ]; then
    fail "$heading"
    printf '%s\n' "$hits"
  fi
}

# ── 1. No storage knowledge in the frontend ──────────────────────────────────
#
# `fs`, `path`, `child_process`, a YAML parser, or any reach into the backend's
# own source. Each would mean the frontend had begun to know how entries are
# stored, and it must not (`requirements.md` §7.1).

check "the frontend imports storage or process modules:" \
  "from ['\"](node:)?(fs|fs/promises|path|os|child_process)['\"]|require\(['\"](node:)?(fs|path|child_process)['\"]\)|from ['\"]yaml['\"]" \
  "$ALL"

# The ESLint config names these paths in order to ban them, which is the
# opposite of a violation.
check "the frontend reaches across the boundary in-process — it must use HTTP (\`plan.md\` standing rule 3):" \
  "@journal/api|apps/api" \
  "$ALL" \
  "^$WEB/eslint\.config\.mjs:"

# ── 2. No literal values in components ───────────────────────────────────────
#
# No literal colour, size, spacing or font family outside the token file
# (`design.md` §6.2). This is what keeps restyling an afternoon's work rather
# than a rewrite.

check "a literal colour appears outside $TOKENS:" \
  "#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bcolor-mix\(" \
  "$COMPONENTS"

check "a literal size appears outside $TOKENS — use a token:" \
  "[0-9]+(px|pt|em)\b" \
  "$COMPONENTS"

# Durations — animation/transition timings. `ms` only: this codebase writes no
# bare-second values, and matching a plain trailing `s` reliably without
# false-positiving on ordinary words is not worth the fragility.
check "a literal duration appears outside $TOKENS — use a token:" \
  "[0-9]+ms\b" \
  "$COMPONENTS"

# Only inside a declaration, so `var(--measure)` passes where `62ch` does not.
check "a literal measure appears outside $TOKENS — use a token:" \
  "^[^/*]*:[^;]*[0-9]+(rem|ch)\b" \
  "$COMPONENTS"

# Every `font-family` must resolve through a token. grep -E has no negative
# lookahead, so match them all and filter the legitimate ones out.
check "a literal font family appears outside $TOKENS:" \
  "font-family:" \
  "$STYLED" \
  "font-family:[[:space:]]*(var\(|inherit)"

if [ "$status" -eq 0 ]; then
  printf '\xe2\x9c\x93 boundary intact: no storage knowledge, no literal values in %s\n' "$WEB"
fi

exit "$status"
