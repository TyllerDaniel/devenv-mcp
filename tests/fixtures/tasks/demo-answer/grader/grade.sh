#!/bin/sh
set -eu
test "$(cat answer.txt)" = "42" && echo "answer is correct" || { echo "expected 42, got $(cat answer.txt)"; exit 1; }
