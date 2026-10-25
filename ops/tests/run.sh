#!/usr/bin/env bash
# Runs every ops script test. Needs bash, age, rclone, and sha256sum.
set -uo pipefail
cd "$(dirname "$0")" || exit 1
status=0
for test_file in test-*.sh; do
  bash "$test_file" || status=1
done
exit "$status"
