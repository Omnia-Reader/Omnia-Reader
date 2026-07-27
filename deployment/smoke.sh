#!/usr/bin/env bash
set -euo pipefail

readonly compose_file="deployment/compose.yaml"
readonly http_port="${OMNIA_SMOKE_HTTP_PORT:-18080}"
readonly base_url="http://127.0.0.1:${http_port}"
readonly response_headers="$(mktemp)"
readonly response_body="$(mktemp)"

cleanup() {
  rm -f "${response_headers}" "${response_body}"
  OMNIA_HTTP_PORT="${http_port}" docker compose \
    --file "${compose_file}" \
    down \
    --remove-orphans
}

trap cleanup EXIT INT TERM

OMNIA_HTTP_PORT="${http_port}" docker compose \
  --file "${compose_file}" \
  up \
  --build \
  --detach \
  --wait

curl --fail --silent --show-error \
  --dump-header "${response_headers}" \
  --output "${response_body}" \
  "${base_url}/"

rg --ignore-case --quiet \
  '^content-security-policy:.*frame-ancestors.*none' \
  "${response_headers}"
rg --ignore-case --quiet '^x-frame-options:[[:space:]]*DENY' "${response_headers}"
rg --ignore-case --quiet '^x-content-type-options:[[:space:]]*nosniff' "${response_headers}"

readonly asset_path="$(
  node --input-type=module -e "
    import { readFile } from 'node:fs/promises';
    const html = await readFile(process.argv[1], 'utf8');
    const match = html.match(/(?:src|href)=\"([^\"]+\.(?:css|js))\"/);
    if (!match) process.exit(1);
    process.stdout.write(match[1]);
  " "${response_body}"
)"

curl --fail --silent --show-error \
  --dump-header "${response_headers}" \
  --output /dev/null \
  "${base_url}/${asset_path#./}"

rg --ignore-case --quiet \
  '^cache-control:[[:space:]]*public, max-age=31536000, immutable' \
  "${response_headers}"

curl --fail --silent --show-error "${base_url}/healthz" |
  node --input-type=module -e "
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const value = JSON.parse(input);
    if (value.status !== 'ok' || value.service !== 'omnia-reader-sync-gateway') {
      process.exit(1);
    }
  "

curl --fail --silent --show-error \
  "${base_url}/api/sync/github/session" |
  node --input-type=module -e "
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const value = JSON.parse(input);
    if (value.configured !== false || value.authenticated !== false) {
      process.exit(1);
    }
  "

echo "Omnia Reader production container smoke passed at ${base_url}"
