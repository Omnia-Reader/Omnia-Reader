#!/usr/bin/env bash
set -euo pipefail

readonly compose_file="deployment/compose.yaml"
readonly contract="deployment/smoke-contract.mjs"
readonly http_port="${OMNIA_SMOKE_HTTP_PORT:-18080}"
readonly base_url="http://127.0.0.1:${http_port}"
readonly strict="${OMNIA_SMOKE_STRICT:-0}"
readonly public_url="${OMNIA_SMOKE_PUBLIC_BASE_URL:-}"
readonly redis_driver="${OMNIA_SMOKE_REDIS_CONTROL_DRIVER:-}"
readonly expected_version="${OMNIA_SMOKE_VERSION:-smoke}"
readonly expected_web_image_id="${OMNIA_SMOKE_EXPECTED_WEB_IMAGE_ID:-}"
readonly expected_gateway_image_id="${OMNIA_SMOKE_EXPECTED_GATEWAY_IMAGE_ID:-}"
readonly connect_timeout="${OMNIA_SMOKE_CONNECT_TIMEOUT_SECONDS:-5}"
readonly request_timeout="${OMNIA_SMOKE_REQUEST_TIMEOUT_SECONDS:-20}"
readonly shutdown_timeout="${OMNIA_SMOKE_SHUTDOWN_TIMEOUT_SECONDS:-30}"
expected_revision="${OMNIA_SMOKE_REVISION:-}"
if [[ -z "${expected_revision}" ]]; then
  expected_revision="$(git rev-parse HEAD)"
  if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
    expected_revision="${expected_revision}-dirty"
  fi
fi
readonly expected_revision
redis_disrupted=0
build_images="${OMNIA_SMOKE_BUILD:-}"

require_bounded_integer() {
  local name="$1"
  local value="$2"
  local minimum="$3"
  local maximum="$4"
  if [[ ! "${value}" =~ ^[0-9]+$ || ${#value} -gt 6 ]] ||
    ((10#${value} < minimum || 10#${value} > maximum)); then
    echo "${name} must be an integer from ${minimum} through ${maximum}" >&2
    exit 1
  fi
}

require_bounded_integer OMNIA_SMOKE_HTTP_PORT "${http_port}" 1024 65535
require_bounded_integer \
  OMNIA_SMOKE_CONNECT_TIMEOUT_SECONDS "${connect_timeout}" 1 30
require_bounded_integer \
  OMNIA_SMOKE_REQUEST_TIMEOUT_SECONDS "${request_timeout}" 1 300
require_bounded_integer \
  OMNIA_SMOKE_SHUTDOWN_TIMEOUT_SECONDS "${shutdown_timeout}" 1 120

if [[ -z "${build_images}" ]]; then
  if [[ "${strict}" == "1" ]]; then
    build_images=0
  else
    build_images=1
  fi
fi
readonly build_images

if [[ "${strict}" != "0" && "${strict}" != "1" ]]; then
  echo "OMNIA_SMOKE_STRICT must be 0 or 1" >&2
  exit 1
fi
if [[ "${build_images}" != "0" && "${build_images}" != "1" ]]; then
  echo "OMNIA_SMOKE_BUILD must be 0 or 1" >&2
  exit 1
fi

validated_public_url=""
if [[ -n "${public_url}" ]]; then
  validated_public_url="$(node "${contract}" public-url "${public_url}")"
fi
readonly validated_public_url

if [[ "${strict}" == "1" ]]; then
  if [[ -z "${validated_public_url}" ]]; then
    echo "Strict smoke requires OMNIA_SMOKE_PUBLIC_BASE_URL" >&2
    exit 1
  fi
  if [[ ! "${expected_web_image_id}" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    [[ ! "${expected_gateway_image_id}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "Strict smoke requires expected web and gateway image IDs" >&2
    exit 1
  fi
  if [[ -z "${redis_driver}" ]]; then
    echo "Strict smoke requires OMNIA_SMOKE_REDIS_CONTROL_DRIVER" >&2
    exit 1
  fi
fi
if [[ -n "${redis_driver}" &&
  ("${redis_driver}" != /* || ! -x "${redis_driver}") ]]; then
  echo "OMNIA_SMOKE_REDIS_CONTROL_DRIVER must be an absolute executable path" >&2
  exit 1
fi

compose() {
  OMNIA_HTTP_PORT="${http_port}" \
    OMNIA_VERSION="${expected_version}" \
    OMNIA_REVISION="${expected_revision}" \
    OMNIA_SYNC_ALERT_MIN_REQUESTS=1 \
    OMNIA_SYNC_ALERT_MAX_FAILURE_RATIO=0.05 \
    OMNIA_SYNC_ALERT_MAX_P95_MS=0.001 \
    OMNIA_SYNC_ALERT_MAX_READINESS_FAILURES=0 \
    docker compose --file "${compose_file}" "$@"
}

bounded_curl() {
  curl --silent --show-error \
    --connect-timeout "${connect_timeout}" \
    --max-time "${request_timeout}" \
    "$@"
}

run_redis_driver() {
  local operation="$1"
  if ! "${redis_driver}" "${operation}" >/dev/null 2>&1; then
    echo "Redis control driver failed during ${operation}" >&2
    return 1
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ "${redis_disrupted}" == "1" ]]; then
    run_redis_driver recover || status=1
  fi
  compose down --remove-orphans || status=1
  rm -f "${response_headers}" "${response_body}"
  rmdir "${smoke_temp}" || status=1
  exit "${status}"
}

smoke_temp="$(mktemp -d)"
readonly smoke_temp
readonly response_headers="${smoke_temp}/headers"
readonly response_body="${smoke_temp}/body"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

assert_ok_probe() {
  local origin="$1"
  local path="$2"
  bounded_curl --fail "${origin}${path}" |
    node "${contract}" probe ok
}

wait_for_readiness() {
  local expected_http="$1"
  local expected_status="$2"
  local attempt http_status
  for ((attempt = 0; attempt < 30; attempt += 1)); do
    http_status="$(bounded_curl \
      --output "${response_body}" \
      --write-out '%{http_code}' \
      "${base_url}/readyz" || true)"
    if [[ "${http_status}" == "${expected_http}" ]] &&
      node "${contract}" probe "${expected_status}" <"${response_body}"; then
      return 0
    fi
    sleep 1
  done
  echo "Gateway readiness did not become ${expected_status}" >&2
  return 1
}

assert_container_identity() {
  local service="$1"
  local expected_image_id="$2"
  local container_id
  container_id="$(compose ps --quiet "${service}")"
  if [[ -z "${container_id}" ]]; then
    echo "Container identity is unavailable for ${service}" >&2
    return 1
  fi
  local -a identity_arguments=(
    image
    "${expected_version}"
    "${expected_revision}"
  )
  if [[ -n "${expected_image_id}" ]]; then
    identity_arguments+=("${expected_image_id}")
  fi
  docker inspect \
    --format '{"imageId":{{json .Image}},"version":{{json (index .Config.Labels "org.opencontainers.image.version")}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}' \
    "${container_id}" |
    node "${contract}" "${identity_arguments[@]}"
}

assert_graceful_shutdown() {
  local container_id="$1"
  compose stop --timeout "${shutdown_timeout}" sync-gateway
  docker inspect \
    --format '{"running":{{json .State.Running}},"oomKilled":{{json .State.OOMKilled}},"exitCode":{{json .State.ExitCode}}}' \
    "${container_id}" |
    node "${contract}" shutdown
}

declare -a up_arguments=(up --detach --wait)
if [[ "${build_images}" == "1" ]]; then
  up_arguments+=(--build)
fi
compose "${up_arguments[@]}"

bounded_curl --fail \
  --dump-header "${response_headers}" \
  --output "${response_body}" \
  "${base_url}/"
node "${contract}" headers <"${response_headers}"

asset_path="$(
  node --input-type=module -e "
    import { readFile } from 'node:fs/promises';
    const html = await readFile(process.argv[1], 'utf8');
    const match = html.match(/(?:src|href)=\"([^\"]+\.(?:css|js))\"/);
    if (!match) process.exit(1);
    process.stdout.write(match[1]);
  " "${response_body}"
)"
readonly asset_path

bounded_curl --fail \
  --dump-header "${response_headers}" \
  --output /dev/null \
  "${base_url}/${asset_path#./}"
rg --ignore-case --quiet \
  '^cache-control:[[:space:]]*public, max-age=31536000, immutable' \
  "${response_headers}"

assert_ok_probe "${base_url}" /healthz
assert_ok_probe "${base_url}" /readyz

bounded_curl --fail "${base_url}/api/sync/github/session" |
  node --input-type=module -e "
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const value = JSON.parse(input);
    if (typeof value.configured !== 'boolean' || value.authenticated !== false) {
      process.exit(1);
    }
  "

metrics_status="$(bounded_curl \
  --output "${response_body}" \
  --write-out '%{http_code}' \
  "${base_url}/metrics")"
readonly metrics_status
if [[ "${metrics_status}" != "404" ]] ||
  rg --quiet 'omnia_sync_' "${response_body}"; then
  echo "Private synchronization metrics are exposed by the public proxy" >&2
  exit 1
fi

assert_container_identity web "${expected_web_image_id}"
assert_container_identity sync-gateway "${expected_gateway_image_id}"

if [[ -n "${validated_public_url}" ]]; then
  public_remote_address="$(bounded_curl --fail \
    --proto '=https' \
    --tlsv1.2 \
    --dump-header "${response_headers}" \
    --output /dev/null \
    --write-out '%{remote_ip}' \
    "${validated_public_url}/")"
  readonly public_remote_address
  node "${contract}" public-address "${public_remote_address}" >/dev/null
  node "${contract}" headers --https <"${response_headers}"
  assert_ok_probe "${validated_public_url}" /healthz
  assert_ok_probe "${validated_public_url}" /readyz
fi

declare -a metrics_arguments=(metrics --expect-latency-alert)
if [[ -n "${redis_driver}" ]]; then
  run_redis_driver fail
  redis_disrupted=1
  wait_for_readiness 503 unavailable
  run_redis_driver recover
  redis_disrupted=0
  wait_for_readiness 200 ok
  metrics_arguments+=(--expect-recovery)
fi

compose exec -T sync-gateway node --input-type=module -e "
  const response = await fetch('http://127.0.0.1:3333/metrics');
  if (!response.ok) process.exit(1);
  process.stdout.write(await response.text());
" | node "${contract}" "${metrics_arguments[@]}"

gateway_container_id="$(compose ps --quiet sync-gateway)"
readonly gateway_container_id
assert_graceful_shutdown "${gateway_container_id}"

if [[ "${strict}" == "1" ]]; then
  echo "Omnia Reader strict deployment smoke passed at ${validated_public_url}"
else
  echo "Omnia Reader local container smoke passed at ${base_url}; public HTTPS and Redis failure injection were not required"
fi
