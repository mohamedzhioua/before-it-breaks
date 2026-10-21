#!/usr/bin/env bash
# Run the Semgrep rule tests, one rule per semgrep process.
#
# Usage: bash rules/semgrep/run-tests.sh [-j N] [rule-set-folder]
#   rule-set-folder  folder holding <id>.yaml rules and tests/<id>.ts|.tsx test
#                    files; relative to this script or absolute (default: typescript).
#   -j N             how many rule processes run at once (default 4, or the
#                    SEMGREP_TEST_JOBS environment variable). -j 1 is fully serial.
#
# Why one rule per process: `semgrep --test <dir>` starts a worker per rule file,
# and on Windows those workers can collide on Semgrep's user settings file and
# fail with PermissionError even though the rules are fine. Here every rule runs
# in its own semgrep process with its own settings and log files
# (SEMGREP_SETTINGS_FILE, SEMGREP_LOG_FILE),
# and a run that still reports PermissionError is retried. Results are printed
# in rule order once every rule has finished.
#
# Exit codes: 0 every rule passed, 1 at least one rule failed, 2 usage error.
set -u

jobs="${SEMGREP_TEST_JOBS:-4}"
set_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    -j) [ $# -ge 2 ] || { echo "run-tests: -j needs a number" >&2; exit 2; }; jobs="$2"; shift 2 ;;
    -j*) jobs="${1#-j}"; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    -*) echo "run-tests: unknown option $1" >&2; exit 2 ;;
    *) [ -z "$set_dir" ] || { echo "run-tests: only one rule-set folder" >&2; exit 2; }; set_dir="$1"; shift ;;
  esac
done
case "$jobs" in
  ''|*[!0-9]*|0) echo "run-tests: -j must be a positive number, got '$jobs'" >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
set_dir="${set_dir:-typescript}"
case "$set_dir" in
  /*|[A-Za-z]:*) ;;
  *) set_dir="$here/$set_dir" ;;
esac

if [ ! -d "$set_dir" ]; then
  echo "run-tests: rule-set folder not found: $set_dir" >&2
  exit 2
fi
if ! command -v semgrep >/dev/null 2>&1; then
  echo "run-tests: semgrep is not on PATH (see rules/semgrep/README.md#running)" >&2
  exit 2
fi

shopt -s nullglob
rules=("$set_dir"/*.yaml "$set_dir"/*.yml)
if [ ${#rules[@]} -eq 0 ]; then
  echo "run-tests: no .yaml rules in $set_dir" >&2
  exit 2
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/semgrep-rule-tests.XXXXXX")" || { echo "run-tests: cannot create a temp folder" >&2; exit 2; }
trap 'rm -rf "$work"' EXIT

# test_one <index> <rule-file>: writes $work/<index>.out and $work/<index>.status
test_one() {
  local idx="$1" rule="$2" id test_file ext out attempt
  id="$(basename "$rule")"; id="${id%.*}"
  test_file=""
  for ext in ts tsx js jsx; do
    if [ -f "$set_dir/tests/$id.$ext" ]; then test_file="$set_dir/tests/$id.$ext"; break; fi
  done
  if [ -z "$test_file" ]; then
    echo "no test file tests/$id.ts or tests/$id.tsx" > "$work/$idx.out"
    echo bad > "$work/$idx.status"
    return
  fi
  mkdir -p "$work/$idx.home"
  out=""
  for attempt in 1 2 3; do
    out="$(SEMGREP_SETTINGS_FILE="$work/$idx.home/settings.yml" SEMGREP_LOG_FILE="$work/$idx.home/semgrep.log" \
      SEMGREP_ENABLE_VERSION_CHECK=0 \
      semgrep --test --metrics=off --config "$rule" "$test_file" 2>&1 < /dev/null)"
    if ! printf '%s\n' "$out" | grep -q PermissionError; then break; fi
  done
  printf '%s\n' "$out" > "$work/$idx.out"
  if printf '%s\n' "$out" | grep -q "All tests passed"; then echo ok; else echo bad; fi > "$work/$idx.status"
}

# Run in groups of $jobs (portable to bash 3.2, which has no `wait -n`).
i=0
while [ $i -lt ${#rules[@]} ]; do
  n=0
  while [ $n -lt "$jobs" ] && [ $i -lt ${#rules[@]} ]; do
    test_one "$i" "${rules[$i]}" &
    i=$((i + 1)); n=$((n + 1))
  done
  wait
done

passed=0
failed=0
i=0
for rule in "${rules[@]}"; do
  id="$(basename "$rule")"; id="${id%.*}"
  if [ "$(cat "$work/$i.status" 2>/dev/null)" = ok ]; then
    echo "PASS $id"
    passed=$((passed + 1))
  else
    echo "FAIL $id"
    grep -v '^[[:space:]]*$' "$work/$i.out" 2>/dev/null | head -20 | sed 's/^/    /'
    failed=$((failed + 1))
  fi
  i=$((i + 1))
done

echo "summary: $passed passed, $failed failed, $((passed + failed)) rules in $(basename "$set_dir")"
[ "$failed" -eq 0 ]
