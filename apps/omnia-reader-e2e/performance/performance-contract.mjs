import { createHash, randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

export const MAX_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_JSON_DEPTH = 32;
export const MAX_SAMPLES_PER_COLLECTION = 10_000;
export const MAX_REASONS = 256;

export const APPROVED_PROFILE_IDS = [
  'desktop-web-v1',
  'mobile-web-v1',
  'packaged-desktop-v1',
  'android-v1',
];

export const APPROVED_BRANCH_IDS = [
  'add-local-success',
  'add-local-failure',
  'associate-success',
  'associate-failure',
  'detach-success',
  'detach-failure',
  'delete-success',
  'delete-failure',
  'reconcile-success',
  'reconcile-failure',
  'replace-success',
  'replace-failure',
  'restore-success',
  'restore-failure',
];

export const APPROVED_DISTRIBUTION_IDS = [
  'filter',
  'open-epub',
  'open-pdf',
  'switch-epub-to-pdf',
  'switch-pdf-to-epub',
];

export const APPROVED_COUNTER_IDS = [
  'consoleErrors',
  'missingAcknowledgements',
  'overlappingEngines',
  'wrongResults',
];

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9]+(?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export class EvidenceValidationError extends Error {
  constructor(message, path = '$') {
    super(`${path}: ${message}`);
    this.name = 'EvidenceValidationError';
    this.path = path;
  }
}

export function parseJsonText(text, source = 'evidence') {
  if (typeof text !== 'string') {
    throw new EvidenceValidationError('JSON input must be text', source);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) {
    throw new EvidenceValidationError(
      'JSON input exceeds the 8 MiB limit',
      source,
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new EvidenceValidationError('invalid JSON', source);
  }
  validateJsonValue(value, source, 0);
  return value;
}

export async function readJsonFile(path) {
  const fileStats = await stat(path);
  if (fileStats.size > MAX_JSON_BYTES) {
    throw new EvidenceValidationError(
      'JSON input exceeds the 8 MiB limit',
      path,
    );
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new EvidenceValidationError(
      'JSON input exceeds the 8 MiB limit',
      path,
    );
  }
  return parseJsonText(bytes.toString('utf8'), path);
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalValue(value, '$', 0));
}

export function profileSetDigest(profileSet) {
  assertRecord(profileSet, 'profileSet');
  const content = { ...profileSet };
  delete content.profileSetDigest;
  return `sha256:${createHash('sha256')
    .update(canonicalStringify(content), 'utf8')
    .digest('hex')}`;
}

export function attachProfileSetDigest(profileSet) {
  const withDigest = {
    ...profileSet,
    profileSetDigest: profileSetDigest(profileSet),
  };
  return withDigest;
}

export function assertProfileSet(value) {
  assertRecord(value, 'profileSet');
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'profileSetId',
      'profileSetDigest',
      'dataset',
      'measurement',
      'profiles',
    ],
    'profileSet',
  );
  assertEqual(value.schemaVersion, 1, 'profileSet.schemaVersion');
  assertEqual(
    value.profileSetId,
    'multi-format-performance-v1',
    'profileSet.profileSetId',
  );
  assertPattern(
    value.profileSetDigest,
    SHA256_PATTERN,
    'profileSet.profileSetDigest',
  );
  assertDataset(value.dataset);
  assertMeasurement(value.measurement);
  assertArray(value.profiles, 'profileSet.profiles');
  assertEqual(
    value.profiles.length,
    APPROVED_PROFILE_IDS.length,
    'profileSet.profiles.length',
  );
  value.profiles.forEach((profile, index) =>
    assertProfile(
      profile,
      APPROVED_PROFILE_IDS[index],
      value.dataset.recipeDigest,
    ),
  );
  const actualDigest = profileSetDigest(value);
  if (value.profileSetDigest !== actualDigest) {
    throw new EvidenceValidationError(
      `profileSetDigest must be ${actualDigest}`,
      'profileSet.profileSetDigest',
    );
  }
  return value;
}

export function assertEnvironmentRecord(value, profileSet) {
  assertRecord(value, 'environment');
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'profileSetId',
      'profileSetDigest',
      'profileId',
      'intent',
      'availability',
      'unavailableReasons',
      'git',
      'driver',
      'values',
    ],
    'environment',
  );
  assertEqual(value.schemaVersion, 1, 'environment.schemaVersion');
  assertEqual(
    value.profileSetId,
    profileSet.profileSetId,
    'environment.profileSetId',
  );
  assertEqual(
    value.profileSetDigest,
    profileSet.profileSetDigest,
    'environment.profileSetDigest',
  );
  assertOneOf(value.profileId, APPROVED_PROFILE_IDS, 'environment.profileId');
  assertOneOf(value.intent, ['primary', 'supplemental'], 'environment.intent');
  assertOneOf(
    value.availability,
    ['available', 'unavailable'],
    'environment.availability',
  );
  assertArray(value.unavailableReasons, 'environment.unavailableReasons');
  if (value.unavailableReasons.length > 32) {
    throw new EvidenceValidationError(
      'must contain at most 32 reasons',
      'environment.unavailableReasons',
    );
  }
  value.unavailableReasons.forEach((reason, index) =>
    assertString(reason, 1, 512, `environment.unavailableReasons[${index}]`),
  );
  if (
    value.availability === 'unavailable' &&
    value.unavailableReasons.length === 0
  ) {
    throw new EvidenceValidationError(
      'must explain an unavailable environment',
      'environment.unavailableReasons',
    );
  }
  if (
    value.availability === 'available' &&
    value.unavailableReasons.length !== 0
  ) {
    throw new EvidenceValidationError(
      'must be empty for an available environment',
      'environment.unavailableReasons',
    );
  }
  assertRecord(value.git, 'environment.git');
  assertExactKeys(value.git, ['commit', 'dirty'], 'environment.git');
  assertPattern(value.git.commit, GIT_SHA_PATTERN, 'environment.git.commit');
  assertBoolean(value.git.dirty, 'environment.git.dirty');
  assertString(value.driver, 1, 128, 'environment.driver');
  assertFlatValues(value.values, 'environment.values', 128);
  return value;
}

export function stableReasons(reasons) {
  if (!Array.isArray(reasons)) {
    throw new EvidenceValidationError('reasons must be an array', 'reasons');
  }
  const limited = reasons.slice(0, MAX_REASONS).map((reason, index) => {
    assertRecord(reason, `reasons[${index}]`);
    assertExactKeys(reason, ['code', 'path', 'message'], `reasons[${index}]`);
    assertString(reason.code, 1, 96, `reasons[${index}].code`);
    assertString(reason.path, 1, 512, `reasons[${index}].path`);
    assertString(reason.message, 1, 1_024, `reasons[${index}].message`);
    return { code: reason.code, path: reason.path, message: reason.message };
  });
  return limited.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message),
  );
}

export async function atomicWriteEvidence(root, relativeName, value) {
  assertString(relativeName, 1, 240, 'output');
  if (
    basename(relativeName) !== relativeName ||
    !relativeName.endsWith('.json') ||
    relativeName.includes('\\') ||
    relativeName.includes('\0')
  ) {
    throw new EvidenceValidationError(
      'output must stay inside the performance results directory',
      'output',
    );
  }
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const destination = resolve(canonicalRoot, relativeName);
  if (dirname(destination) !== canonicalRoot) {
    throw new EvidenceValidationError(
      'output must stay inside the performance results directory',
      'output',
    );
  }
  try {
    const destinationStats = await lstat(destination);
    if (destinationStats.isSymbolicLink()) {
      throw new EvidenceValidationError(
        'output cannot be a symbolic link',
        'output',
      );
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) {
      throw error;
    }
  }
  const serialized = `${canonicalStringify(value)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) {
    throw new EvidenceValidationError(
      'output exceeds the 8 MiB limit',
      'output',
    );
  }
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return destination;
}

export function assertRecord(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EvidenceValidationError('must be an object', path);
  }
  return value;
}

export function assertExactKeys(value, expectedKeys, path) {
  const expected = [...expectedKeys].sort();
  const actual = Object.keys(value).sort();
  if (canonicalStringify(actual) !== canonicalStringify(expected)) {
    throw new EvidenceValidationError(
      `must contain exactly keys ${expected.join(', ')}`,
      path,
    );
  }
}

export function assertString(value, minimum, maximum, path) {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new EvidenceValidationError(
      `must be a string between ${minimum} and ${maximum} characters`,
      path,
    );
  }
  return value;
}

export function assertArray(value, path) {
  if (!Array.isArray(value)) {
    throw new EvidenceValidationError('must be an array', path);
  }
  return value;
}

export function assertSafeInteger(value, minimum, maximum, path) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new EvidenceValidationError(
      `must be an integer between ${minimum} and ${maximum}`,
      path,
    );
  }
  return value;
}

export function assertFiniteNumber(value, minimum, maximum, path) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new EvidenceValidationError(
      `must be a finite number between ${minimum} and ${maximum}`,
      path,
    );
  }
  return value;
}

export function assertTimingArray(value, path) {
  assertArray(value, path);
  if (value.length > MAX_SAMPLES_PER_COLLECTION) {
    throw new EvidenceValidationError(
      `must contain at most ${MAX_SAMPLES_PER_COLLECTION} samples`,
      path,
    );
  }
  value.forEach((sample, index) =>
    assertFiniteNumber(sample, 0, 86_400_000, `${path}[${index}]`),
  );
  return value;
}

export function assertBoolean(value, path) {
  if (typeof value !== 'boolean') {
    throw new EvidenceValidationError('must be a boolean', path);
  }
  return value;
}

export function assertOneOf(value, allowed, path) {
  if (!allowed.includes(value)) {
    throw new EvidenceValidationError(
      `must be one of ${allowed.join(', ')}`,
      path,
    );
  }
  return value;
}

function assertDataset(value) {
  assertRecord(value, 'profileSet.dataset');
  assertExactKeys(
    value,
    [
      'recipeId',
      'seed',
      'logicalBooks',
      'exactVariants',
      'formats',
      'logicalChangeHistory',
      'recipeDigest',
    ],
    'profileSet.dataset',
  );
  assertEqual(
    value.recipeId,
    'multi-format-management-v1',
    'profileSet.dataset.recipeId',
  );
  assertString(value.seed, 1, 128, 'profileSet.dataset.seed');
  assertEqual(value.logicalBooks, 1_000, 'profileSet.dataset.logicalBooks');
  assertEqual(value.exactVariants, 2_000, 'profileSet.dataset.exactVariants');
  assertStringArrayExact(
    value.formats,
    ['epub', 'pdf'],
    'profileSet.dataset.formats',
  );
  assertEqual(
    value.logicalChangeHistory,
    500,
    'profileSet.dataset.logicalChangeHistory',
  );
  assertPattern(
    value.recipeDigest,
    SHA256_PATTERN,
    'profileSet.dataset.recipeDigest',
  );
}

function assertMeasurement(value) {
  assertRecord(value, 'profileSet.measurement');
  assertExactKeys(
    value,
    [
      'acknowledgementThresholdMs',
      'finalThresholdMs',
      'minimumAcknowledgementSamples',
      'warmupSamples',
      'minimumFinalSamples',
      'maximumSamplesPerCollection',
      'minimumWithinTargetRatio',
      'branchIds',
      'distributionIds',
      'zeroToleranceCounters',
    ],
    'profileSet.measurement',
  );
  assertEqual(
    value.acknowledgementThresholdMs,
    1_000,
    'profileSet.measurement.acknowledgementThresholdMs',
  );
  assertEqual(
    value.finalThresholdMs,
    2_000,
    'profileSet.measurement.finalThresholdMs',
  );
  assertEqual(
    value.minimumAcknowledgementSamples,
    20,
    'profileSet.measurement.minimumAcknowledgementSamples',
  );
  assertEqual(value.warmupSamples, 20, 'profileSet.measurement.warmupSamples');
  assertEqual(
    value.minimumFinalSamples,
    200,
    'profileSet.measurement.minimumFinalSamples',
  );
  assertEqual(
    value.maximumSamplesPerCollection,
    MAX_SAMPLES_PER_COLLECTION,
    'profileSet.measurement.maximumSamplesPerCollection',
  );
  assertEqual(
    value.minimumWithinTargetRatio,
    0.95,
    'profileSet.measurement.minimumWithinTargetRatio',
  );
  assertStringArrayExact(
    value.branchIds,
    APPROVED_BRANCH_IDS,
    'profileSet.measurement.branchIds',
  );
  assertStringArrayExact(
    value.distributionIds,
    APPROVED_DISTRIBUTION_IDS,
    'profileSet.measurement.distributionIds',
  );
  assertStringArrayExact(
    value.zeroToleranceCounters,
    APPROVED_COUNTER_IDS,
    'profileSet.measurement.zeroToleranceCounters',
  );
}

function assertProfile(value, expectedId, recipeDigest) {
  const path = `profileSet.profiles.${expectedId}`;
  assertRecord(value, path);
  assertExactKeys(
    value,
    [
      'id',
      'platform',
      'driver',
      'qualification',
      'unresolvedRequirements',
      'requirements',
    ],
    path,
  );
  assertEqual(value.id, expectedId, `${path}.id`);
  assertString(value.platform, 1, 64, `${path}.platform`);
  assertString(value.driver, 1, 128, `${path}.driver`);
  assertOneOf(
    value.qualification,
    ['complete', 'unresolved'],
    `${path}.qualification`,
  );
  assertArray(value.unresolvedRequirements, `${path}.unresolvedRequirements`);
  if (value.unresolvedRequirements.length > 32) {
    throw new EvidenceValidationError(
      'must contain at most 32 unresolved requirements',
      `${path}.unresolvedRequirements`,
    );
  }
  const unresolved = new Set();
  value.unresolvedRequirements.forEach((requirement, index) => {
    assertString(
      requirement,
      1,
      128,
      `${path}.unresolvedRequirements[${index}]`,
    );
    if (unresolved.has(requirement)) {
      throw new EvidenceValidationError(
        `duplicate unresolved requirement ${requirement}`,
        `${path}.unresolvedRequirements[${index}]`,
      );
    }
    unresolved.add(requirement);
  });
  if (
    (value.qualification === 'complete') !==
    (value.unresolvedRequirements.length === 0)
  ) {
    throw new EvidenceValidationError(
      'complete profiles have no unresolved requirements; unresolved profiles must list them',
      `${path}.qualification`,
    );
  }
  assertRequirements(value.requirements, `${path}.requirements`, 128);
  for (const requirement of unresolved) {
    if (!Object.hasOwn(value.requirements, requirement)) {
      throw new EvidenceValidationError(
        'must name an existing requirement',
        `${path}.unresolvedRequirements`,
      );
    }
  }
  assertEqual(
    value.requirements['dataset.recipeDigest'],
    recipeDigest,
    `${path}.requirements.dataset.recipeDigest`,
  );
}

function assertFlatValues(value, path, maximumKeys) {
  assertRecord(value, path);
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > maximumKeys) {
    throw new EvidenceValidationError(
      `must contain between 1 and ${maximumKeys} values`,
      path,
    );
  }
  for (const [key, entry] of entries) {
    assertString(key, 1, 128, `${path} key`);
    if (!IDENTIFIER_PATTERN.test(key)) {
      throw new EvidenceValidationError(
        'contains an invalid value key',
        `${path}.${key}`,
      );
    }
    if (
      entry !== null &&
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      throw new EvidenceValidationError(
        'values must be strings, finite numbers, booleans, or null',
        `${path}.${key}`,
      );
    }
    if (typeof entry === 'string') {
      assertString(entry, 0, 2_048, `${path}.${key}`);
    } else if (typeof entry === 'number') {
      assertFiniteNumber(
        entry,
        -Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        `${path}.${key}`,
      );
    }
  }
}

function assertRequirements(value, path, maximumKeys) {
  assertRecord(value, path);
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > maximumKeys) {
    throw new EvidenceValidationError(
      `must contain between 1 and ${maximumKeys} requirements`,
      path,
    );
  }
  for (const [key, entry] of entries) {
    assertString(key, 1, 128, `${path} key`);
    if (!IDENTIFIER_PATTERN.test(key)) {
      throw new EvidenceValidationError(
        'contains an invalid requirement key',
        `${path}.${key}`,
      );
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      assertExactKeys(entry, ['format'], `${path}.${key}`);
      assertOneOf(entry.format, ['sha256'], `${path}.${key}.format`);
      continue;
    }
    if (
      entry !== null &&
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      throw new EvidenceValidationError(
        'requirements must be primitive exact values or supported format constraints',
        `${path}.${key}`,
      );
    }
    if (typeof entry === 'string') {
      assertString(entry, 0, 2_048, `${path}.${key}`);
    } else if (typeof entry === 'number') {
      assertFiniteNumber(
        entry,
        -Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        `${path}.${key}`,
      );
    }
  }
}

function assertStringArrayExact(value, expected, path) {
  assertArray(value, path);
  if (canonicalStringify(value) !== canonicalStringify(expected)) {
    throw new EvidenceValidationError(
      `must equal ${expected.join(', ')}`,
      path,
    );
  }
}

function assertPattern(value, pattern, path) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new EvidenceValidationError(`must match ${pattern}`, path);
  }
}

function assertEqual(actual, expected, path) {
  if (!Object.is(actual, expected)) {
    throw new EvidenceValidationError(
      `expected ${JSON.stringify(expected)} but received ${JSON.stringify(actual)}`,
      path,
    );
  }
}

function validateJsonValue(value, path, depth) {
  canonicalValue(value, path, depth);
}

function canonicalValue(value, path, depth) {
  if (depth > MAX_JSON_DEPTH) {
    throw new EvidenceValidationError(
      `JSON nesting exceeds ${MAX_JSON_DEPTH}`,
      path,
    );
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new EvidenceValidationError('numbers must be finite', path);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      canonicalValue(entry, `${path}[${index}]`, depth + 1),
    );
  }
  if (!value || typeof value !== 'object') {
    throw new EvidenceValidationError('contains a non-JSON value', path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new EvidenceValidationError('contains a non-plain object', path);
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (key.length === 0 || key.length > 256 || key.includes('\0')) {
      throw new EvidenceValidationError('contains an invalid object key', path);
    }
    result[key] = canonicalValue(value[key], `${path}.${key}`, depth + 1);
  }
  return result;
}
