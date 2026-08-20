/* eslint-disable playwright/expect-expect, playwright/no-conditional-in-test -- Node tests assert through node:assert. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJsonFile } from './performance-contract.mjs';
import { createManagementWorkload } from './management-workload.mjs';
import { assertSamplingIdentity } from './primary-management-run.mjs';
import { captureSamplingIdentity } from './sampling-identity.mjs';
import { environmentFixture } from './test-fixtures.mjs';

test('recaptures qualified Git, browser, viewport, cgroup, and AC power identity', async () => {
  const profileSet = await readJsonFile(
    'specs/001-multi-format-books/performance/profiles-v1.json',
  );
  const environment = environmentFixture(profileSet);
  const workload = createManagementWorkload();
  const [width, height] = environment.values['environment.viewport']
    .split('x')
    .map(Number);
  const files = new Map([
    ['/proc/self/cgroup', '0::/user.slice/omnia-performance.scope\n'],
    [
      '/sys/fs/cgroup/user.slice/omnia-performance.scope/cpu.max',
      '200000 100000\n',
    ],
    [
      '/sys/fs/cgroup/user.slice/omnia-performance.scope/memory.max',
      '8589934592\n',
    ],
    ['/sys/fs/cgroup/user.slice/cpu.max', 'max 100000\n'],
    ['/sys/fs/cgroup/user.slice/memory.max', 'max\n'],
    ['/sys/fs/cgroup/cpu.max', 'max 100000\n'],
    ['/sys/fs/cgroup/memory.max', 'max\n'],
    ['/sys/firmware/acpi/platform_profile', 'balanced\n'],
    ['/sys/class/power_supply/AC0/type', 'Mains\n'],
    ['/sys/class/power_supply/AC0/online', '1\n'],
  ]);
  const readText = async (path) => {
    if (files.has(path)) return files.get(path);
    const error = new Error(`Missing fixture ${path}`);
    error.code = 'ENOENT';
    throw error;
  };
  const runGit = (arguments_) =>
    arguments_[0] === 'rev-parse' ? `${environment.git.commit}\n` : '';

  const identity = await captureSamplingIdentity({
    profileSet,
    environment,
    workload,
    browserName: environment.values['runtime.browserName'],
    browserVersion: environment.values['runtime.browserVersion'],
    viewport: { width, height },
    deviceScaleFactor: environment.values['environment.deviceScaleFactor'],
    runGit,
    readText,
    listDirectory: async () => ['AC0'],
  });

  assert.equal(
    assertSamplingIdentity(profileSet, environment, workload, identity),
    identity,
  );
});

test('refuses sampling when effective resource limits are unbounded', async () => {
  const profileSet = await readJsonFile(
    'specs/001-multi-format-books/performance/profiles-v1.json',
  );
  const environment = environmentFixture(profileSet);
  const workload = createManagementWorkload();
  const readText = async (path) => {
    if (path === '/proc/self/cgroup') return '0::/unconstrained\n';
    if (path.endsWith('/cpu.max')) return 'max 100000\n';
    if (path.endsWith('/memory.max')) return 'max\n';
    if (path === '/sys/firmware/acpi/platform_profile') return 'balanced\n';
    const error = new Error(`Missing fixture ${path}`);
    error.code = 'ENOENT';
    throw error;
  };

  await assert.rejects(
    captureSamplingIdentity({
      profileSet,
      environment,
      workload,
      browserName: 'chromium',
      browserVersion: '1.0.0.0',
      viewport: { width: 1366, height: 768 },
      deviceScaleFactor: 1,
      runGit: () => `${environment.git.commit}\n`,
      readText,
      listDirectory: async () => [],
    }),
    /finite effective CPU and memory limits/,
  );
});
