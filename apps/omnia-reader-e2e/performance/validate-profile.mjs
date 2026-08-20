#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EvidenceValidationError,
  assertProfileSet,
  canonicalStringify,
  readJsonFile,
} from './performance-contract.mjs';
import { evaluatePreflight } from './profile-preflight.mjs';

export { evaluatePreflight } from './profile-preflight.mjs';

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

export async function captureCurrentEnvironment(profileSetInput, profileId) {
  const profileSet = assertProfileSet(profileSetInput);
  const profile = profileSet.profiles.find((entry) => entry.id === profileId);
  if (!profile) {
    throw new EvidenceValidationError(
      'selected profile does not exist',
      'profileId',
    );
  }
  const packageLock = await readFile(
    resolve(REPOSITORY_ROOT, 'package-lock.json'),
  );
  const packageLockValue = JSON.parse(packageLock.toString('utf8'));
  const osRelease = await readOsRelease();
  const knownValues = {
    'dataset.recipeDigest': profileSet.dataset.recipeDigest,
    'environment.arch': arch(),
    'environment.cpuModel': cpus()[0]?.model ?? null,
    'environment.kernelRelease': release(),
    'environment.osRelease': osRelease.VERSION_ID ?? null,
    'environment.platform': platform(),
    'runtime.playwrightVersion':
      packageLockValue.packages?.['node_modules/@playwright/test']?.version ??
      null,
    'source.nodeVersion': process.version,
    'source.packageLockSha256': `sha256:${createHash('sha256')
      .update(packageLock)
      .digest('hex')}`,
  };
  const values = Object.fromEntries(
    Object.keys(profile.requirements).map((key) => [
      key,
      Object.hasOwn(knownValues, key) ? knownValues[key] : null,
    ]),
  );
  return {
    schemaVersion: 1,
    profileSetId: profileSet.profileSetId,
    profileSetDigest: profileSet.profileSetDigest,
    profileId,
    intent: 'primary',
    availability: 'available',
    unavailableReasons: [],
    git: captureGitState(),
    driver: profile.driver,
    values,
  };
}

async function main(arguments_) {
  const [profilePath, profileId, ...options] = arguments_;
  if (!profilePath || !profileId) {
    throw new EvidenceValidationError(
      'usage: validate-profile.mjs <profile-set.json> <profile-id> [--environment <environment.json>] [--json]',
      'arguments',
    );
  }
  let environmentPath = null;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === '--json') {
      continue;
    }
    if (option === '--environment' && options[index + 1]) {
      environmentPath = options[index + 1];
      index += 1;
      continue;
    }
    throw new EvidenceValidationError(`unknown option ${option}`, 'arguments');
  }
  const profileSet = assertProfileSet(await readJsonFile(profilePath));
  const environment = environmentPath
    ? await readJsonFile(environmentPath)
    : await captureCurrentEnvironment(profileSet, profileId);
  if (environment.profileId !== profileId) {
    throw new EvidenceValidationError(
      `expected ${profileId} but received ${environment.profileId}`,
      'environment.profileId',
    );
  }
  const report = evaluatePreflight(profileSet, environment);
  process.stdout.write(`${canonicalStringify(report)}\n`);
  process.exitCode = report.status === 'READY' ? 0 : 2;
}

function captureGitState() {
  const commit = runGit(['rev-parse', 'HEAD']).trim();
  const status = runGit(['status', '--porcelain', '--untracked-files=normal']);
  return { commit, dirty: status.trim().length > 0 };
}

function runGit(arguments_) {
  const result = spawnSync('git', arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new EvidenceValidationError(
      result.stderr.trim() || 'Git evidence is unavailable',
      'git',
    );
  }
  return result.stdout;
}

async function readOsRelease() {
  try {
    const content = await readFile('/etc/os-release', 'utf8');
    return Object.fromEntries(
      content
        .split(/\r?\n/)
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => {
          const separator = line.indexOf('=');
          const key = line.slice(0, separator);
          const raw = line.slice(separator + 1);
          return [key, raw.replace(/^"|"$/g, '')];
        }),
    );
  } catch {
    return {};
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2)).catch((error) => {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown evidence validation error';
    process.stdout.write(
      `${canonicalStringify({
        schemaVersion: 1,
        valid: false,
        error: {
          code: 'INVALID_EVIDENCE',
          message: message.slice(0, 2_048),
        },
      })}\n`,
    );
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  });
}
