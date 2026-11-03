#!/usr/bin/env bash
# Everything that can be proven about this configuration without an Azure subscription.
# Needs only Docker. Run from anywhere: bash infra/azure/scripts/verify.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
DIR="$(pwd -W 2>/dev/null || pwd)"
TF="hashicorp/terraform:1.12"

run() { echo; echo "== $1"; shift; "$@"; }

run "format"                docker run --rm -v "$DIR:/work" -w /work "$TF" fmt -check -recursive
run "init (no backend)"     docker run --rm -v "$DIR:/work" -w /work "$TF" init -backend=false -input=false -no-color
run "validate"              docker run --rm -v "$DIR:/work" -w /work "$TF" validate -no-color
run "tests (mocked providers)" docker run --rm -v "$DIR:/work" -w /work "$TF" test -no-color
run "tflint"                docker run --rm -v "$DIR:/data" -w /data --entrypoint sh ghcr.io/terraform-linters/tflint:latest -c "tflint --init >/dev/null && tflint"
run "trivy"                 docker run --rm -v "$DIR:/src" aquasec/trivy:latest config /src --skip-dirs /src/.terraform --exit-code 1 --quiet
run "checkov"               docker run --rm -v "$DIR:/tf" bridgecrew/checkov:latest -d /tf --framework terraform --quiet --compact --skip-path /tf/.terraform
echo; echo "All offline checks passed. Nothing here proves Azure accepts it: see the README's first-apply list."
