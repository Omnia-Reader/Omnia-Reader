# Quickstart: Low-Latency Local-First Synchronization

## Focused checks

```sh
npx nx test sync-core --skip-nx-cache
npx nx test sync-git --skip-nx-cache
npx nx test sync-gateway --skip-nx-cache
```

Expected: one-second trailing debounce, ten-second visible revision polling, provider backoff, single-flight behavior, and deterministic timer cleanup pass. No push broker, SSE route, or EventSource client remains.

## Static and production gates

```sh
npx nx run-many -t lint -p sync-core sync-git sync-gateway omnia-reader omnia-reader-e2e --skip-nx-cache
npx nx build sync-gateway --configuration production --skip-nx-cache
npx nx build omnia-reader --configuration production --skip-nx-cache
git diff --check
```

## GitHub App boundary

No Push event, synchronization webhook URL, or synchronization webhook secret is required. Existing Contents read/write and optional Administration permissions remain sufficient.
