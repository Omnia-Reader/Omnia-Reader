/* eslint-disable playwright/expect-expect */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  LiveGitHubConfigurationError,
  invokeLiveGitHubControl,
  readLiveGitHubConfiguration,
  readProtectedGitHubStorageState,
} from './live-github-control.mjs';

const validEnvironment = {
  LIVE_GITHUB_SYNC_E2E: '1',
  LIVE_GITHUB_PROTECTED_RUNNER: '1',
  BASE_URL: 'https://reader-staging.example.com',
  LIVE_GITHUB_AUTH_STATE: '/run/secrets/github-storage-state.json',
  LIVE_GITHUB_CONTROL_DRIVER: '/opt/omnia/live-github-control',
  LIVE_GITHUB_RUN_ID: '20260912-a1b2c3d4',
  OMNIA_SYNC_SECRET_CANARIES: JSON.stringify({
    'live-github-secret': 'canary-that-must-not-leak-1234',
  }),
  LIVE_GITHUB_THROTTLE_AVAILABLE: '0',
  LIVE_GITHUB_CANDIDATE_COMMIT: 'a'.repeat(40),
  LIVE_GITHUB_CANDIDATE_RELEASE: '0.1.0-rc.1',
  LIVE_GITHUB_ARTIFACT_DIGEST: `sha256:${'b'.repeat(64)}`,
};

test('keeps the live journey disabled unless explicitly requested', () => {
  assert.equal(readLiveGitHubConfiguration({}), null);
});

test('accepts a complete protected live GitHub configuration', () => {
  assert.deepEqual(readLiveGitHubConfiguration(validEnvironment), {
    baseUrl: 'https://reader-staging.example.com',
    authStatePath: '/run/secrets/github-storage-state.json',
    controlDriverPath: '/opt/omnia/live-github-control',
    runId: '20260912-a1b2c3d4',
    repositoryName: 'omnia-reader-live-20260912-a1b2c3d4',
    secretCanary: 'canary-that-must-not-leak-1234',
    throttleAvailable: false,
    candidateCommit: 'a'.repeat(40),
    candidateRelease: '0.1.0-rc.1',
    artifactDigest: `sha256:${'b'.repeat(64)}`,
  });
});

test('fails closed for unprotected, insecure, ambiguous, or incomplete runs', () => {
  for (const override of [
    { LIVE_GITHUB_PROTECTED_RUNNER: '0' },
    { BASE_URL: 'http://reader-staging.example.com' },
    { BASE_URL: 'https://staging.example.invalid' },
    { BASE_URL: 'https://token@reader-staging.example.com' },
    { BASE_URL: 'https://reader-staging.example.com/subpath' },
    { LIVE_GITHUB_AUTH_STATE: 'github-state.json' },
    { LIVE_GITHUB_CONTROL_DRIVER: './control' },
    { LIVE_GITHUB_RUN_ID: 'shared' },
    {
      OMNIA_SYNC_SECRET_CANARIES: JSON.stringify({
        'live-github-secret': 'short',
      }),
    },
    { OMNIA_SYNC_SECRET_CANARIES: '{not-json' },
    {
      OMNIA_SYNC_SECRET_CANARIES: JSON.stringify({
        'live-github-secret': 'canary-that-must-not-leak-1234',
        extra: 'another-secret-canary-value',
      }),
    },
    { LIVE_GITHUB_THROTTLE_AVAILABLE: 'maybe' },
    { LIVE_GITHUB_CANDIDATE_COMMIT: 'main' },
    { LIVE_GITHUB_CANDIDATE_RELEASE: 'release with spaces' },
    { LIVE_GITHUB_ARTIFACT_DIGEST: 'latest' },
  ]) {
    assert.throws(
      () => readLiveGitHubConfiguration({ ...validEnvironment, ...override }),
      LiveGitHubConfigurationError,
    );
  }
});

test('accepts GitHub-only browser state and rejects cross-origin state', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnia-live-github-state-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'state.json');
  const githubState = {
    cookies: [
      {
        name: 'user_session',
        value: 'protected-value',
        domain: '.github.com',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [{ origin: 'https://github.com', localStorage: [] }],
  };
  await writeFile(statePath, JSON.stringify(githubState));
  assert.deepEqual(
    await readProtectedGitHubStorageState(statePath),
    githubState,
  );

  githubState.origins.push({
    origin: 'https://reader-staging.example.com',
    localStorage: [],
  });
  await writeFile(statePath, JSON.stringify(githubState));
  await assert.rejects(
    readProtectedGitHubStorageState(statePath),
    LiveGitHubConfigurationError,
  );
});

test('validates the scoped control-driver envelope without exposing output', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnia-live-github-driver-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const driverPath = join(directory, 'control.mjs');
  await writeFile(
    driverPath,
    `#!/usr/bin/env node
const values = Object.fromEntries(Array.from({ length: process.argv.length - 2 }, (_, index) => index).filter((index) => index % 2 === 0).map((index) => [process.argv[index + 2].replace(/^--/, ''), process.argv[index + 3]]));
process.stdout.write(JSON.stringify({ schemaVersion: 1, operation: values.operation, runId: values['run-id'], repository: values.repository, candidateCommit: values['candidate-commit'], candidateRelease: values['candidate-release'], artifactDigest: values['artifact-digest'], outcome: process.env.DRIVER_OUTCOME ?? 'ok' }));
`,
  );
  await chmod(driverPath, 0o700);
  const configuration = {
    ...readLiveGitHubConfiguration(validEnvironment),
    controlDriverPath: driverPath,
  };

  assert.equal(
    (await invokeLiveGitHubControl(configuration, 'prepare')).outcome,
    'ok',
  );
  await assert.rejects(
    invokeLiveGitHubControl(configuration, 'not-an-operation'),
    /Unsupported/,
  );

  process.env['DRIVER_OUTCOME'] = 'unavailable';
  try {
    await assert.rejects(
      invokeLiveGitHubControl(configuration, 'restart-gateway'),
      /unavailable/,
    );
    assert.equal(
      (
        await invokeLiveGitHubControl(configuration, 'throttle-once', {
          allowUnavailable: true,
        })
      ).outcome,
      'unavailable',
    );
  } finally {
    delete process.env['DRIVER_OUTCOME'];
  }
});
