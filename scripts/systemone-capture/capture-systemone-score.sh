#!/usr/bin/env bash
# Follow-up #50 Part D — reproduce test/fixtures/systemone-llama-score-response.json from a REAL llama-server.
#
# The fixture proves the WIRE SHAPE of llama.cpp's /v1/systemone `score` question (request `criteria` = an
# array of 2–10 level labels; response `probabilities` keyed "0".."n-1" plus `legend`/`score`/`confidence`).
# It uses tiny random-weight GGUFs (HuggingFace test models were unreachable), so the probabilities mean
# nothing; "peaked" uses the server's own score_bias metadata to exercise the confident path.
#
# usage: scripts/systemone-capture/capture-systemone-score.sh [WORKDIR]   (default: ../llama-capture)
# needs: git, cmake, a C++ toolchain, python3 with numpy (gguf-py is taken from the llama.cpp checkout).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:-$HERE/../../../llama-capture}"
PORT="${PORT:-8089}"
mkdir -p "$WORK"; cd "$WORK"
[ -d llama.cpp ] || git clone --depth 1 https://github.com/ggml-org/llama.cpp.git
(cd llama.cpp && git rev-parse HEAD > ../llama-commit.txt)
[ -x llama.cpp/build/bin/llama-server ] || (cd llama.cpp && cmake -B build -DLLAMA_CURL=OFF -DGGML_NATIVE=OFF >/dev/null && cmake --build build --target llama-server -j"$(nproc)")
export PYTHONPATH="$WORK/llama.cpp/gguf-py${PYTHONPATH:+:$PYTHONPATH}"
python3 "$HERE/make_tiny_openjev.py" tiny-openjev.gguf
python3 "$HERE/make_tiny_openjev.py" tiny-openjev-peaked.gguf --peaked

capture() { # $1 gguf, $2 request json, $3 out file
  llama.cpp/build/bin/llama-server -m "$1" --host 127.0.0.1 --port "$PORT" -c 2048 -t 1 >"$3.server.log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
  curl -s -w '\nHTTP %{http_code}\n' -H 'Content-Type: application/json' --data @"$2" "http://127.0.0.1:$PORT/v1/systemone" >"$3"
  kill "$pid"; wait "$pid" 2>/dev/null || true
}
capture tiny-openjev.gguf        "$HERE/req-score.json"               resp-score-flat.txt
capture tiny-openjev-peaked.gguf "$HERE/req-score.json"               resp-score-peaked.txt
capture tiny-openjev.gguf        "$HERE/req-score-legacy-levels.json" resp-score-legacy-levels.txt
echo "llama.cpp $(cat llama-commit.txt)"; tail -n 2 resp-score-*.txt
echo "Redact the local model path, then fold flat/peaked/legacyLevelsShape into test/fixtures/systemone-llama-score-response.json."
