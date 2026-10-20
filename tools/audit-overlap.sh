#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
#
# audit-overlap.sh — every number in docs/audit-qualify-vs-compat.md, from source, by one command each.
#
#   tools/audit-overlap.sh <omx-clap-core dir> <plugin-hostd dir>
#   tools/audit-overlap.sh --self-test
#
# It prints one line per unit (a function, or a set of functions, in one repository):
#   unit <id> <repo> <file>:<first>-<last> lines=<n>
# one line per pair that does the same job in two places:
#   pair <a> <b> shared=<s> a=<na> b=<nb> overlap=<s/min(na,nb) %> diff=<changed lines or "-"> strings=<both/a/b>
# and one line per counted marker:
#   count <id> <repo> <n>
# A unit is found by its name (a C or TypeScript function runs to the first column-0 `}`, a Python def or class
# to the next column-0 statement), never by a line number, so the numbers follow the code. The audited commits are
# printed first (`tree <repo> <commit>`); the document states which ones it quotes.
#
# Similarity: both bodies are normalised (comments, blank lines and lone braces dropped, whitespace squeezed), then
# `shared` is the number of normalised lines the two have in common (comm -12 over the sorted lines, duplicates
# kept) and `diff` the number of lines `diff` adds or removes between them. Code in two languages shares no line;
# for it the pair prints overlap=0 and diff=-. `strings` is shared/a/b of the distinct string literals (three or
# more characters) each body spells: messages, field names and codes, which survive a change of brace style or of
# language, so a port of the same code shows there when its lines do not.
set -euo pipefail
export LC_ALL=C
Q="$(cd "$(dirname "$0")/.." && pwd)"

die() { echo "audit-overlap: $*" >&2; exit 2; }

# span <lang> <file> <name> — print "<first> <last>" of the named unit, nothing when there is none
span() { # <lang> <file> <name>
  awk -v lang="$1" -v name="$3" '
    function starts(l) {
      if (lang == "py") return l ~ ("^(def|class) " name "[(:]")
      if (lang == "ts") return l ~ ("^(export )?(async )?function " name "[(<]")
      return l ~ ("^[A-Za-z].*[ *]" name "\\(") && l !~ /;[ \t]*$/
    }
    !on && starts($0) { on = 1; first = NR; last = NR; next }
    on && lang != "py" && /^}/ { last = NR; print first, last; exit }
    on && lang == "py" && /^[^ \t#\n]/ { print first, last; exit }
    on && lang == "py" && /[^ \t]/ { last = NR }
    END { if (on && lang == "py") print first, last }
  ' "$2"
}

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
declare -A ROOT LANG_OF

# unit <id> <repo> <lang> <file> <name>... — one unit, the names' bodies concatenated
unit() {
  local id="$1" repo="$2" lang="$3" file="$4"; shift 4
  local root="${ROOT[$repo]}" n total=0 where="" s
  : > "$WORK/$id"
  for n in "$@"; do
    s="$(span "$lang" "$root/$file" "$n")"
    [ -n "$s" ] || die "$repo $file: no $lang unit named $n"
    local a b; read -r a b <<<"$s"
    sed -n "${a},${b}p" "$root/$file" >> "$WORK/$id"
    total=$((total + b - a + 1)); where="${where:+$where,}$a-$b"
  done
  LANG_OF[$id]="$lang"
  echo "unit $id $repo $file:$where lines=$total"
}

# whole <id> <repo> <lang> <file> — a whole file as one unit
whole() {
  local id="$1" repo="$2" lang="$3" file="$4" n
  cp "${ROOT[$repo]}/$file" "$WORK/$id"; n=$(wc -l < "$WORK/$id")
  LANG_OF[$id]="$lang"
  echo "unit $id $repo $file:1-$n lines=$n"
}

norm() { # <lang> < body
  case "$1" in
    py) sed -E 's/#.*$//' ;;
    *)  sed -E 's#//.*$##; s#/\*.*\*/##g; /^[[:space:]]*\*( |\/|$)/d; /^[[:space:]]*\/\*/d' ;;
  esac | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' | grep -vE '^[{}();, ]*$' || true
}

lits() { grep -oE "\"[^\"\\\\]{3,}\"|'[^'\\\\]{3,}'" | sed -E "s/^.(.*).$/\\1/"; } # quotes dropped: '' and "" alike

pair() { # <a> <b>
  local a="$1" b="$2" na nb s d m l
  norm "${LANG_OF[$a]}" < "$WORK/$a" | sort > "$WORK/$a.n"
  norm "${LANG_OF[$b]}" < "$WORK/$b" | sort > "$WORK/$b.n"
  na=$(wc -l < "$WORK/$a.n"); nb=$(wc -l < "$WORK/$b.n")
  s=$(comm -12 "$WORK/$a.n" "$WORK/$b.n" | wc -l)
  m=$(( na < nb ? na : nb ))
  if [ "${LANG_OF[$a]}" = "${LANG_OF[$b]}" ]; then
    norm "${LANG_OF[$a]}" < "$WORK/$a" > "$WORK/$a.o"; norm "${LANG_OF[$b]}" < "$WORK/$b" > "$WORK/$b.o"
    d=$(diff "$WORK/$a.o" "$WORK/$b.o" | grep -c '^[<>]' || true)
  else d="-"; fi
  # the string literals (messages, field names, codes) both spell: what survives a change of style or language
  norm "${LANG_OF[$a]}" < "$WORK/$a" | lits | sort -u > "$WORK/$a.l" || true
  norm "${LANG_OF[$b]}" < "$WORK/$b" | lits | sort -u > "$WORK/$b.l" || true
  l="$(comm -12 "$WORK/$a.l" "$WORK/$b.l" | wc -l)/$(wc -l < "$WORK/$a.l")/$(wc -l < "$WORK/$b.l")"
  echo "pair $a $b shared=$s a=$na b=$nb overlap=$(( m ? 100 * s / m : 0 ))% diff=$d strings=$l"
}

count() { # <id> <repo> <git grep args> -- <pathspec>...   (this audit's own two files are never counted)
  local id="$1" repo="$2"; shift 2
  local self=(":(exclude)tools/audit-overlap.sh" ":(exclude)docs/audit-qualify-vs-compat.md")
  echo "count $id $repo $(git -C "${ROOT[$repo]}" grep -IE "$@" "${self[@]}" | wc -l)"
}

audit() {
  local r
  for r in qualify clap-core hostd; do echo "tree $r $(git -C "${ROOT[$r]}" rev-parse --short HEAD)"; done

  # 1. plugin enumeration
  unit q.clap-walk     qualify   c  native/clap-qualify.c is_clap walk scan
  unit c.clap-walk     clap-core c  src/scan.c has_suffix walk main
  unit q.clap-fork     qualify   c  native/clap-qualify.c scan_file
  unit c.clap-fork     clap-core c  src/scan.c scan_file
  unit q.clap-describe qualify   c  native/clap-qualify.c scan_file_entry scan_plugin scan_params scan_audio_ports
  unit c.clap-describe clap-core c  src/scan.c put_file put_plugin put_descriptor put_params put_audio_ports
  unit q.clap-path     qualify   ts src/clap-loader.ts clapSearchPath
  unit c.clap-path     clap-core c  src/scan.c default_paths
  unit q.lv2-manifest  qualify   ts src/lv2-loader.ts pluginsInManifest lv2BundlesOnPath
  unit c.lv2-manifest  clap-core c  src/lv2_locate.c lv2_locate_manifest_names walk_dir lv2_locate
  unit q.lv2-lilv      qualify   py tools/scan.py Scanner
  unit c.lv2-lilv      clap-core py tests/lv2_parity.py lilv_facts
  pair q.clap-walk c.clap-walk
  pair q.clap-fork c.clap-fork
  pair q.clap-describe c.clap-describe
  pair q.clap-path c.clap-path
  pair q.lv2-manifest c.lv2-manifest
  pair q.lv2-lilv c.lv2-lilv
  count q.calls-omx-clap-scan qualify -e 'omx-clap-scan' -- src
  # clap-qualify's whole scan mode (--json), which writes the document omx-clap-scan writes, plus labels and pages
  unit q.scan-mode     qualify   c  native/clap-qualify.c put_labels scan_params scan_remote_controls scan_audio_ports \
                                    scan_plugin put_file_error scan_file_entry scan_file list_add is_clap walk scan
  count c.scan-labels-pages clap-core -i -e 'remote_controls|enum_labels|"labels"' -- src/scan.c

  # 2. deterministic input
  count q.lcg-nr      qualify   -e '1664525u' -- native
  count q.lcg-glibc   qualify   -e '1103515245u' -- native
  count c.lcg-nr      clap-core -e '1664525u' -- tests src
  unit q.noise-lv2    qualify   c  native/lv2-measure.c fill_input
  unit c.signal       clap-core c  tests/jack_parity.c noise signal_at
  pair q.noise-lv2 c.signal
  unit q.notes        qualify   c  native/clap-qualify.c note_event note_midi note_key note_block note_dialect
  unit q.notes-py     qualify   py tools/benchmark.py held_keys midi_sequence
  unit c.notes        clap-core c  tests/jack_parity.c midi_events
  pair q.notes c.notes
  pair q.notes-py q.notes

  # 3. isolated PipeWire, the feeder
  count q.pipewire    qualify   -i -e 'pipewire|unshare' -- src native tools bin
  count c.unshare     clap-core -e 'unshare' -- tests
  unit c.pw-parity    clap-core py tests/lv2_parity.py start_pipewire
  unit c.pw-coverage  clap-core py tests/clap_coverage.py start_pipewire
  unit c.ns-parity    clap-core py tests/lv2_parity.py inside_run cmd_run
  unit c.ns-coverage  clap-core py tests/clap_coverage.py inside_host cmd_host
  unit c.clock        clap-core c  tests/jack_parity.c clock_process clock_state clock_wait clock_start clock_cycle clock_run
  pair c.pw-parity c.pw-coverage
  pair c.ns-parity c.ns-coverage

  # 4. host launch, teardown, crash and hang
  unit q.probe-runner qualify   ts src/probe-runner.ts runOne probeTarget
  unit h.run-child    hostd     c  src/probe.c apply_limits kill_tree run_child child_end
  unit q.bench-worker qualify   py tools/benchmark.py WorkerQueue _Worker
  unit c.host-parity  clap-core py tests/lv2_parity.py Host run_plugin
  unit c.host-coverage clap-core py tests/clap_coverage.py Host
  pair c.host-parity c.host-coverage
  pair q.bench-worker c.host-parity
  count h.runs-clap-qualify hostd -e 'clap-qualify|clap_qualify' -- src
  count h.runs-lv2-measure  hostd -e 'lv2_measure|lv2-measure' -- src

  # 5. records, classification, vocabulary, reports
  unit q.records      qualify   ts src/measurement/sweep-jsonl.ts measuredPluginsFromSweep parseJsonl
  unit c.tsv-parity   clap-core py tests/lv2_parity.py read_tsv write_tsv
  unit c.tsv-coverage clap-core py tests/clap_coverage.py read_tsv write_tsv append_tsv
  pair c.tsv-parity c.tsv-coverage
  unit q.classify     qualify   ts src/hosting-suitability.ts classifyPluginHosting
  unit c.classify     clap-core py tests/lv2_parity.py _classify
  pair q.classify c.classify
  unit c.report       clap-core py tests/lv2_parity.py report_text
  count q.contract-imports qualify -e "from \"@openmixer/omx-contract" -- src
  count c.contract-macros  clap-core -e 'OMX_HOSTING_[A-Z_]+' -- src lv2
  count q.handtyped-hosting qualify -e '"hosting\.[a-z-]+\.[a-z-]+"' -- 'src/*.ts' ':!src/*.test.ts'

  # 6. cost and latency
  unit q.pct-c        qualify   c  native/clap-qualify.c percentile_sorted
  unit q.pct-py       qualify   py tools/benchmark.py percentile
  unit q.cost-c       qualify   c  native/clap-qualify.c cost_rate
  unit c.stage-bench  clap-core c  tests/stage_bench.c main
  pair q.pct-c q.pct-py
  pair q.cost-c c.stage-bench

  # the probing programs plugin-hostd's probe runs as its children today, and what the move into its child deletes
  whole q.prober-clap qualify c  native/clap-qualify.c
  whole q.prober-lv2  qualify c  native/lv2-measure.c
  whole q.benchmark   qualify py tools/benchmark.py

  # 7. mod-host in plugin-qualify: code that runs it, and words that name it
  count q.modhost-spawn qualify -e "spawn[A-Za-z]*\\(['\"]mod-host|execvp?\\(\"mod-host" -- src native tools bin
  count q.modhost-words qualify -i -e 'mod-host' -- .
  count c.modhost-words clap-core -i -e 'mod-host' -- tests
}

self_test() {
  T="$(mktemp -d)"; local t="$T"; trap 'rm -rf "$T" "$WORK"' EXIT
  for r in a b c; do mkdir -p "$t/$r"; git -C "$t/$r" init -q; done
  cat > "$t/a/x.c" <<'EOF'
static int one(int v)
{
  /* a comment */
  return v + !"same"; /* "comment" */
}
static int two(int v) {
  return v * 2;
}
EOF
  cat > "$t/b/y.py" <<'EOF'
def one(v):
    # a comment
    return v + len("same")  # "comment"

X = 1
EOF
  cp "$t/a/x.c" "$t/c/z.c"; sed -i 's/v \* 2/v * 3/' "$t/c/z.c"
  for r in a b c; do git -C "$t/$r" add -A; git -C "$t/$r" -c user.name=t -c user.email=t@t commit -qm t; done
  ROOT[qualify]="$t/a"; ROOT[clap-core]="$t/b"; ROOT[hostd]="$t/c"
  local out fail=0
  expect() { grep -qxF -- "$1" <<<"$out" || { echo "self-test: missing: $1" >&2; fail=1; }; }
  out="$(unit u1 qualify c x.c one; unit u2 qualify c x.c two; unit p1 clap-core py y.py one
         unit h1 hostd c z.c one two; unit h2 qualify c x.c one two
         pair h2 h1; pair u1 p1; count n qualify -e 'return' -- .)"
  expect "unit u1 qualify x.c:1-5 lines=5"
  expect "unit u2 qualify x.c:6-8 lines=3"
  expect "unit p1 clap-core y.py:1-3 lines=3"
  expect "pair h2 h1 shared=3 a=4 b=4 overlap=75% diff=2 strings=1/1/1"
  expect "pair u1 p1 shared=0 a=2 b=2 overlap=0% diff=- strings=1/1/1"
  expect "count n qualify 2"
  # a name that is not there is refused, never counted as zero
  if (unit u3 qualify c x.c three) 2>/dev/null; then echo "self-test: a missing unit was not refused" >&2; fail=1; fi
  [ "$fail" = 0 ] && echo "audit-overlap self-test: ok"
  return "$fail"
}

case "${1:-}" in
  --self-test) self_test ;;
  -h|--help|"") sed -n '5,9p' "$0"; [ -n "${1:-}" ] ;;
  *) [ $# = 2 ] || die "usage: $0 <omx-clap-core dir> <plugin-hostd dir>"
     ROOT[qualify]="$Q"; ROOT[clap-core]="$(cd "$1" && pwd)"; ROOT[hostd]="$(cd "$2" && pwd)"
     audit ;;
esac
