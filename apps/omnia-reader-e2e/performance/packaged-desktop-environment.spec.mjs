/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */
/* eslint-disable playwright/no-conditional-in-test -- Hostile fixture variants share the same contract. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  assertExclusivePackagedDesktopProcess,
  assertPackagedDesktopSamplingIdentity,
  createPackagedDesktopEnvironment,
  launchPackagedDesktopEnvironment,
  preparePackagedDesktopApplication,
} from './packaged-desktop-environment.mjs';
import { profileSetV2Fixture } from './platform-test-fixtures.mjs';

const ownedDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...ownedDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  ownedDirectories.clear();
});

test('copies one exact non-debuggable AppImage into owned storage', async () => {
  const root = await temporaryDirectory('omnia-packaged-appimage-');
  const bytes = appImageBytes('release');
  const sourcePath = join(root, 'Omnia.Reader_0.1.0_amd64.AppImage');
  await writeFile(sourcePath, bytes, { mode: 0o700 });
  const foreign = join(root, 'foreign.txt');
  await writeFile(foreign, 'preserve');

  const prepared = await preparePackagedDesktopApplication({
    sourcePath,
    destinationRoot: join(root, 'sessions'),
    provenance: provenanceFixture(sourcePath, bytes),
    platform: 'linux',
    architecture: 'x64',
  });

  assert.deepEqual(await readFile(prepared.applicationPath), bytes);
  assert.match(prepared.ownedRoot, /omnia-packaged-desktop-/);
  assert.notEqual(prepared.applicationPath, sourcePath);
  await prepared.cleanup();
  await prepared.cleanup();
  await assert.rejects(access(prepared.ownedRoot), { code: 'ENOENT' });
  assert.equal(await readFile(foreign, 'utf8'), 'preserve');
});

test('rejects debug substitution, archive packages, and embedded debug automation', async () => {
  const root = await temporaryDirectory('omnia-packaged-reject-');
  for (const variant of ['debug', 'archive', 'embedded-driver']) {
    const extension = variant === 'archive' ? 'deb' : 'AppImage';
    const sourcePath = join(root, `${variant}.${extension}`);
    const bytes = appImageBytes(
      variant === 'embedded-driver'
        ? 'tauri-plugin-wdio-webdriver native-e2e'
        : variant,
    );
    await writeFile(sourcePath, bytes, { mode: 0o700 });
    const provenance = provenanceFixture(sourcePath, bytes);
    if (variant === 'debug') provenance.artifact.debuggable = true;
    if (variant === 'archive') provenance.artifact.kind = 'linux-deb';

    await assert.rejects(
      preparePackagedDesktopApplication({
        sourcePath,
        destinationRoot: join(root, `sessions-${variant}`),
        provenance,
        platform: 'linux',
        architecture: 'x64',
      }),
      /debuggable|archive|embedded debug automation/,
    );
  }
});

test('rejects a raw ELF binary mislabeled as an AppImage', async () => {
  const root = await temporaryDirectory('omnia-packaged-raw-elf-');
  const bytes = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.from('raw tauri binary'),
  ]);
  const sourcePath = join(root, 'mislabeled.AppImage');
  await writeFile(sourcePath, bytes, { mode: 0o700 });
  await assert.rejects(
    preparePackagedDesktopApplication({
      sourcePath,
      destinationRoot: join(root, 'sessions'),
      provenance: provenanceFixture(sourcePath, bytes),
      platform: 'linux',
      architecture: 'x64',
    }),
    /AppImage type-2 headers/,
  );
});

test(
  'rejects source and destination link attacks without touching their targets',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await temporaryDirectory('omnia-packaged-links-');
    const bytes = appImageBytes('release');
    const target = join(root, 'target.AppImage');
    const linkedSource = join(root, 'linked.AppImage');
    await writeFile(target, bytes, { mode: 0o700 });
    await symlink(target, linkedSource);
    await assert.rejects(
      preparePackagedDesktopApplication({
        sourcePath: linkedSource,
        destinationRoot: join(root, 'sessions-source'),
        provenance: provenanceFixture(linkedSource, bytes),
        platform: 'linux',
        architecture: 'x64',
      }),
      /regular file|symbolic link/,
    );

    const outside = join(root, 'outside');
    const linkedRoot = join(root, 'linked-root');
    await mkdir(outside);
    await symlink(outside, linkedRoot);
    await assert.rejects(
      preparePackagedDesktopApplication({
        sourcePath: target,
        destinationRoot: linkedRoot,
        provenance: provenanceFixture(target, bytes),
        platform: 'linux',
        architecture: 'x64',
      }),
      /owned destination root.*symbolic link/,
    );
    assert.deepEqual(await readFile(target), bytes);
  },
);

test('rejects stale endpoints before launch', async () => {
  let starts = 0;
  await assert.rejects(
    launchPackagedDesktopEnvironment({
      applicationPath: '/owned/omnia-reader.AppImage',
      endpoint: 'http://127.0.0.1:4444',
      constraintScope: '/omnia.slice',
      endpointAvailable: async () => true,
      start: async () => {
        starts += 1;
      },
      cleanupTimeoutMs: 50,
    }),
    /stale automation endpoint/,
  );
  assert.equal(starts, 0);
});

test('rejects duplicate instances, process-scope drift, and application crash', async () => {
  const applicationPath = '/owned/omnia-reader.AppImage';
  const base = {
    pid: 4100,
    executable: applicationPath,
    constraintScope: '/omnia.slice',
    running: true,
  };
  assert.throws(
    () =>
      assertExclusivePackagedDesktopProcess({
        applicationPath,
        constraintScope: '/omnia.slice',
        processes: [base, { ...base, pid: 4101 }],
      }),
    /exactly one application process/,
  );
  assert.throws(
    () =>
      assertExclusivePackagedDesktopProcess({
        applicationPath,
        constraintScope: '/omnia.slice',
        processes: [{ ...base, constraintScope: '/foreign.slice' }],
      }),
    /constraint scope drift/,
  );

  let started = false;
  let running = true;
  const session = await launchPackagedDesktopEnvironment({
    applicationPath,
    endpoint: 'http://127.0.0.1:4444',
    constraintScope: '/omnia.slice',
    endpointAvailable: async () => started && running,
    start: async () => {
      started = true;
      return {
        applicationPid: 4100,
        observeProcesses: async () => (running ? [base] : []),
        close: async () => {
          running = false;
        },
        terminate: async () => {
          running = false;
        },
      };
    },
    cleanupTimeoutMs: 50,
  });
  running = false;
  await assert.rejects(session.assertRunning(), /application crashed/);
  await session.cleanup();
});

test('bounds a hung close and removes only the owned application', async () => {
  const applicationPath = '/owned/omnia-reader.AppImage';
  const owned = {
    pid: 4200,
    executable: applicationPath,
    constraintScope: '/omnia.slice',
    running: true,
  };
  const foreign = {
    pid: 4300,
    executable: '/foreign/reader',
    constraintScope: '/foreign.slice',
    running: true,
  };
  let started = false;
  let ownedRunning = true;
  let terminateCalls = 0;
  const session = await launchPackagedDesktopEnvironment({
    applicationPath,
    endpoint: 'http://127.0.0.1:4444',
    constraintScope: '/omnia.slice',
    endpointAvailable: async () => started && ownedRunning,
    start: async () => {
      started = true;
      return {
        applicationPid: owned.pid,
        observeProcesses: async () => [
          ...(ownedRunning ? [owned] : []),
          foreign,
        ],
        close: () => new Promise(() => undefined),
        terminate: async () => {
          terminateCalls += 1;
          ownedRunning = false;
        },
      };
    },
    cleanupTimeoutMs: 25,
  });

  const startedAt = Date.now();
  await session.cleanup();
  await session.cleanup();
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(terminateCalls, 1);
  assert.equal(foreign.running, true);
});

test('binds package, runtime, source, resource, and power identity', () => {
  const profileSet = profileSetV2Fixture();
  const environment = createPackagedDesktopEnvironment({
    profileSet,
    profileId: 'packaged-desktop-v2',
    git: { commit: 'c'.repeat(40), dirty: false },
    observations: observationFixture(),
  });
  assert.equal(
    environment.values['environment.profileMarker'],
    'packaged-desktop-v2',
  );
  assert.equal(environment.values['source.nodeVersion'], 'v26.5.0');
  assertPackagedDesktopSamplingIdentity(
    environment,
    structuredClone(environment),
  );

  for (const [key, value] of [
    ['environment.profileMarker', 'wrong-profile'],
    ['source.packageLockSha256', `sha256:${'d'.repeat(64)}`],
  ]) {
    const drifted = structuredClone(environment);
    drifted.values[key] = value;
    assert.throws(
      () => assertPackagedDesktopSamplingIdentity(environment, drifted),
      /identity drift/,
    );
  }
});

function observationFixture() {
  return {
    artifact: {
      kind: 'linux-appimage',
      sizeBytes: 16_020_112,
      sha256: `sha256:${'e'.repeat(64)}`,
    },
    host: {
      operatingSystem: 'linux',
      kernel: '6.17.0-5-generic',
      architecture: 'x64',
      constraintScope: '/omnia.slice',
      cpuQuota: 2,
      memoryLimitBytes: 4_294_967_296,
      powerMode: 'ac-balanced',
    },
    runtime: {
      wryVersion: '0.55.1',
      webkitVersion: '2.52.3',
      tauriDriverVersion: '2.0.5',
      nativeDriverVersion: '2.52.3',
    },
    source: {
      nodeVersion: 'v26.5.0',
      packageLockSha256: `sha256:${'b'.repeat(64)}`,
      cargoLockSha256: `sha256:${'a'.repeat(64)}`,
    },
  };
}

function appImageBytes(marker) {
  return Buffer.concat([
    Buffer.from([
      0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x41, 0x49, 0x02,
    ]),
    Buffer.from(marker),
  ]);
}

function provenanceFixture(path, bytes) {
  const fileName = path.split('/').at(-1);
  return {
    schemaVersion: 1,
    provenanceId: 'omnia-packaged-desktop-release-v1',
    artifact: {
      kind: 'linux-appimage',
      fileName,
      sizeBytes: bytes.byteLength,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      releaseMode: 'release',
      debuggable: false,
      packageId: 'io.github.omniareader.reader',
      packageVersion: '0.1.0',
      target: 'x86_64-linux',
      signerSha256: null,
    },
    source: {
      commit: 'c'.repeat(40),
      dirty: false,
      packageLockSha256: `sha256:${'a'.repeat(64)}`,
      cargoLockSha256: `sha256:${'b'.repeat(64)}`,
    },
    toolchain: {
      node: 'v26.5.0',
      rust: '1.89.0',
      tauri: '2.11.4',
    },
  };
}

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  ownedDirectories.add(directory);
  return directory;
}
