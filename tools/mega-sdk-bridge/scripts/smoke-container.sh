#!/bin/sh

set -eu

image="${OMNIA_MEGA_BRIDGE_IMAGE:-omnia-reader/mega-sdk-bridge:local}"
port="${OMNIA_MEGA_BRIDGE_SMOKE_PORT:-47840}"
suffix="$$"
container="omnia-mega-bridge-smoke-${suffix}"
volume="omnia-mega-bridge-smoke-${suffix}"
response_file="$(mktemp)"
identifier="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
token="smoke-test-token-0123456789-abcdef"

cleanup() {
  docker rm --force "${container}" >/dev/null 2>&1 || true
  docker volume rm "${volume}" >/dev/null 2>&1 || true
  rm -f "${response_file}"
}
trap cleanup EXIT INT TERM

docker volume create "${volume}" >/dev/null
docker run \
  --rm \
  --user 0:0 \
  --entrypoint /bin/sh \
  --volume "${volume}:/data" \
  "${image}" \
  -c "mkdir -p /data/download-${identifier} /data/sdk-${identifier} &&
      touch /data/upload-${identifier}.tmp \
            /data/download-${identifier}/content \
            /data/sdk-${identifier}/cache &&
      chown -R 10001:10001 /data &&
      chmod 0700 /data"

docker run \
  --detach \
  --network host \
  --name "${container}" \
  --volume "${volume}:/var/lib/omnia-mega-bridge" \
  --env OMNIA_MEGA_APP_KEY=smoke-test-app-key \
  --env OMNIA_MEGA_BRIDGE_TOKEN="${token}" \
  --env OMNIA_MEGA_BRIDGE_PORT="${port}" \
  "${image}" >/dev/null

status=""
attempt=0
while [ "${attempt}" -lt 50 ]; do
  status="$(
    curl \
      --silent \
      --output "${response_file}" \
      --write-out '%{http_code}' \
      "http://127.0.0.1:${port}/v1/folders" || true
  )"
  if [ "${status}" = "401" ]; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done

if [ "${status}" != "401" ] ||
  [ "$(tr -d '\r\n' <"${response_file}")" != '{"code":"UNAUTHORIZED"}' ]; then
  echo "MEGA bridge authentication smoke check failed" >&2
  exit 1
fi

if [ -n "$(
  docker exec \
    "${container}" \
    /bin/ls -A /var/lib/omnia-mega-bridge
)" ]; then
  echo "MEGA bridge did not clean its stale temporary data" >&2
  exit 1
fi

docker stop --timeout 5 "${container}" >/dev/null
if [ "$(docker inspect "${container}" --format '{{.State.ExitCode}}')" != "0" ]; then
  echo "MEGA bridge did not exit cleanly after SIGTERM" >&2
  exit 1
fi

echo "MEGA bridge container smoke checks passed"
