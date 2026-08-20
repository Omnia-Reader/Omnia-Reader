/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  EvidenceValidationError,
  attachProfileSetDigest,
  assertProfileSet,
  canonicalStringify,
  parseJsonText,
  profileSetDigest,
} from './performance-contract.mjs';
import {
  captureCurrentEnvironment,
  evaluatePreflight,
} from './validate-profile.mjs';
import { environmentFixture, profileSetFixture } from './test-fixtures.mjs';

test('derives canonical profile identity while rejecting semantic drift', () => {
  const profileSet = profileSetFixture();
  assert.equal(assertProfileSet(profileSet), profileSet);
  assert.equal(profileSetDigest(profileSet), profileSet.profileSetDigest);

  const reordered = Object.fromEntries(Object.entries(profileSet).reverse());
  assert.equal(profileSetDigest(reordered), profileSet.profileSetDigest);
  assert.equal(
    canonicalStringify({ z: 1, nested: { z: 2, a: 1 }, a: 2 }),
    '{"a":2,"nested":{"a":1,"z":2},"z":1}',
  );

  assert.throws(
    () =>
      assertProfileSet({
        ...profileSet,
        dataset: { ...profileSet.dataset, seed: 'drifted-seed' },
      }),
    /profileSetDigest/,
  );
  assert.throws(
    () => assertProfileSet({ ...profileSet, unexpected: true }),
    EvidenceValidationError,
  );
  assert.throws(
    () => parseJsonText(`"${'x'.repeat(8 * 1024 * 1024)}"`),
    /8 MiB/,
  );
});

test('classifies exact, unavailable, dirty, supplemental, and mismatched environments', () => {
  const profileSet = profileSetFixture();
  assert.deepEqual(
    evaluatePreflight(
      profileSet,
      environmentFixture(profileSet, 'desktop-web-v1'),
    ),
    {
      schemaVersion: 1,
      profileSetId: profileSet.profileSetId,
      profileSetDigest: profileSet.profileSetDigest,
      profileId: 'desktop-web-v1',
      status: 'READY',
      mayMeasure: true,
      git: { commit: 'c'.repeat(40), dirty: false },
      reasons: [],
    },
  );

  const unavailable = evaluatePreflight(
    profileSet,
    environmentFixture(profileSet, 'desktop-web-v1', {
      availability: 'unavailable',
      unavailableReasons: ['The constrained reference host is unavailable'],
    }),
  );
  assert.equal(unavailable.status, 'UNVERIFIED');
  assert.equal(unavailable.mayMeasure, false);

  const dirty = evaluatePreflight(
    profileSet,
    environmentFixture(profileSet, 'desktop-web-v1', {
      git: { commit: 'c'.repeat(40), dirty: true },
    }),
  );
  assert.equal(dirty.status, 'SUPPLEMENTAL');
  assert.match(dirty.reasons[0].code, /DIRTY/);

  const supplemental = evaluatePreflight(
    profileSet,
    environmentFixture(profileSet, 'desktop-web-v1', {
      intent: 'supplemental',
    }),
  );
  assert.equal(supplemental.status, 'SUPPLEMENTAL');

  const mismatch = evaluatePreflight(
    profileSet,
    environmentFixture(profileSet, 'desktop-web-v1', {
      values: {
        ...environmentFixture(profileSet).values,
        'source.nodeVersion': 'v99.0.0',
      },
    }),
  );
  assert.equal(mismatch.status, 'UNVERIFIED');
  assert.equal(mismatch.reasons[0].path, 'values.source.nodeVersion');
});

test('keeps unresolved profile identities unverified and validates dynamic digests', () => {
  const base = profileSetFixture();
  const unresolvedProfileSet = attachProfileSetDigest({
    ...base,
    profiles: base.profiles.map((profile) =>
      profile.id === 'mobile-web-v1'
        ? {
            ...profile,
            qualification: 'unresolved',
            unresolvedRequirements: ['runtime.chromeVersion'],
            requirements: {
              ...profile.requirements,
              'runtime.chromeVersion': null,
            },
          }
        : profile,
    ),
  });
  const unresolved = evaluatePreflight(
    unresolvedProfileSet,
    environmentFixture(unresolvedProfileSet, 'mobile-web-v1'),
  );
  assert.equal(unresolved.status, 'UNVERIFIED');
  assert.ok(
    unresolved.reasons.some(
      (reason) => reason.code === 'PROFILE_IDENTITY_UNRESOLVED',
    ),
  );

  const constrainedProfileSet = attachProfileSetDigest({
    ...base,
    profiles: base.profiles.map((profile) =>
      profile.id === 'desktop-web-v1'
        ? {
            ...profile,
            requirements: {
              ...profile.requirements,
              'artifact.sha256': { format: 'sha256' },
            },
          }
        : profile,
    ),
  });
  const validEnvironment = environmentFixture(
    constrainedProfileSet,
    'desktop-web-v1',
  );
  validEnvironment.values['artifact.sha256'] = `sha256:${'d'.repeat(64)}`;
  assert.equal(
    evaluatePreflight(constrainedProfileSet, validEnvironment).status,
    'READY',
  );
  validEnvironment.values['artifact.sha256'] = 'not-a-digest';
  assert.equal(
    evaluatePreflight(constrainedProfileSet, validEnvironment).status,
    'UNVERIFIED',
  );
});

test('captures a bounded current environment without inventing missing evidence', async () => {
  const profileSet = profileSetFixture();
  const captured = await captureCurrentEnvironment(
    profileSet,
    'desktop-web-v1',
  );
  assert.equal(captured.schemaVersion, 1);
  assert.equal(captured.profileId, 'desktop-web-v1');
  assert.match(captured.git.commit, /^[a-f0-9]{40}$/);
  assert.equal(typeof captured.git.dirty, 'boolean');
  assert.equal(captured.values['source.nodeVersion'], process.version);
  assert.equal(Object.hasOwn(captured.values, 'environment.arch'), true);
});

test('preflight CLI exits 0 only for READY and emits canonical JSON', async () => {
  const profileSet = profileSetFixture();
  const directory = await mkdtemp(join(tmpdir(), 'omnia-profile-test-'));
  const profilePath = join(directory, 'profiles.json');
  const readyPath = join(directory, 'ready.json');
  const missingPath = join(directory, 'missing.json');
  await writeFile(profilePath, `${JSON.stringify(profileSet)}\n`);
  await writeFile(
    readyPath,
    `${JSON.stringify(environmentFixture(profileSet))}\n`,
  );
  await writeFile(
    missingPath,
    `${JSON.stringify(
      environmentFixture(profileSet, 'desktop-web-v1', {
        availability: 'unavailable',
        unavailableReasons: ['host unavailable'],
      }),
    )}\n`,
  );
  const command = 'apps/omnia-reader-e2e/performance/validate-profile.mjs';

  const ready = spawnSync(
    process.execPath,
    [command, profilePath, 'desktop-web-v1', '--environment', readyPath],
    { encoding: 'utf8' },
  );
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).status, 'READY');
  assert.equal(ready.stdout.endsWith('\n'), true);

  const missing = spawnSync(
    process.execPath,
    [command, profilePath, 'desktop-web-v1', '--environment', missingPath],
    { encoding: 'utf8' },
  );
  assert.equal(missing.status, 2, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).status, 'UNVERIFIED');

  const invalid = spawnSync(
    process.execPath,
    [command, profilePath, 'desktop-web-v1', '--unknown'],
    { encoding: 'utf8' },
  );
  assert.equal(invalid.status, 1);
  assert.deepEqual(JSON.parse(invalid.stdout), {
    schemaVersion: 1,
    valid: false,
    error: {
      code: 'INVALID_EVIDENCE',
      message: 'arguments: unknown option --unknown',
    },
  });
});
