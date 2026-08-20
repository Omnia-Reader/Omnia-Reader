#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EvidenceValidationError,
  APPROVED_PROFILE_IDS,
  assertArray,
  assertEnvironmentRecord,
  assertExactKeys,
  assertFiniteNumber,
  assertOneOf,
  assertProfileSet,
  assertRecord,
  assertSafeInteger,
  assertString,
  assertTimingArray,
  canonicalStringify,
  readJsonFile,
  stableReasons,
} from './performance-contract.mjs';
import { evaluatePreflight } from './validate-profile.mjs';

const BASE_RESULT_KEYS = [
  'schemaVersion',
  'profileSetId',
  'profileSetDigest',
  'profileId',
  'command',
  'recordedAt',
  'environment',
  'acknowledgements',
  'distributions',
  'counters',
];
const COMPUTED_RESULT_KEYS = ['statistics', 'disposition', 'reasons'];

export function distributionStatistics(samplesInput, targetMs) {
  const samples = [...assertTimingArray(samplesInput, 'samplesMs')].sort(
    (left, right) => left - right,
  );
  if (samples.length === 0) {
    throw new EvidenceValidationError(
      'must contain at least one sample',
      'samplesMs',
    );
  }
  assertFiniteNumber(targetMs, 0, 86_400_000, 'targetMs');
  const middle = Math.floor(samples.length / 2);
  const p50Ms =
    samples.length % 2 === 0
      ? (samples[middle - 1] + samples[middle]) / 2
      : samples[middle];
  const p95Ms = samples[Math.ceil(samples.length * 0.95) - 1];
  const withinTarget = samples.filter((sample) => sample <= targetMs).length;
  return {
    count: samples.length,
    p50Ms,
    p95Ms,
    maxMs: samples[samples.length - 1],
    withinTargetRatio: withinTarget / samples.length,
  };
}

export function evaluateRawResult(profileSetInput, resultInput) {
  const profileSet = assertProfileSet(profileSetInput);
  assertRecord(resultInput, 'result');
  const keys = Object.keys(resultInput);
  const hasComputed = COMPUTED_RESULT_KEYS.some((key) => keys.includes(key));
  assertExactKeys(
    resultInput,
    hasComputed
      ? [...BASE_RESULT_KEYS, ...COMPUTED_RESULT_KEYS]
      : BASE_RESULT_KEYS,
    'result',
  );
  const baseResult = Object.fromEntries(
    BASE_RESULT_KEYS.map((key) => [key, resultInput[key]]),
  );
  const evaluated = evaluateRawBase(profileSet, baseResult);
  if (hasComputed) {
    const claimed = Object.fromEntries(
      COMPUTED_RESULT_KEYS.map((key) => [key, resultInput[key]]),
    );
    const actual = Object.fromEntries(
      COMPUTED_RESULT_KEYS.map((key) => [key, evaluated[key]]),
    );
    if (canonicalStringify(claimed) !== canonicalStringify(actual)) {
      throw new EvidenceValidationError(
        'computed disposition, statistics, or reasons do not match raw evidence',
        'result',
      );
    }
  }
  return evaluated;
}

export function aggregateResults(profileSetInput, resultInputs) {
  const profileSet = assertProfileSet(profileSetInput);
  assertArray(resultInputs, 'results');
  if (resultInputs.length > APPROVED_PROFILE_IDS.length) {
    const seen = new Set();
    for (const result of resultInputs) {
      if (
        result &&
        typeof result === 'object' &&
        typeof result.profileId === 'string'
      ) {
        if (seen.has(result.profileId)) {
          throw new EvidenceValidationError(
            `duplicate profile ${result.profileId}`,
            'results',
          );
        }
        seen.add(result.profileId);
      }
    }
    throw new EvidenceValidationError('too many profile results', 'results');
  }
  const evaluated = new Map();
  for (const input of resultInputs) {
    const result = evaluateRawResult(profileSet, input);
    if (evaluated.has(result.profileId)) {
      throw new EvidenceValidationError(
        `duplicate profile ${result.profileId}`,
        'results',
      );
    }
    evaluated.set(result.profileId, result);
  }
  const blocking = [];
  const results = [];
  const commits = new Set();
  for (const profileId of APPROVED_PROFILE_IDS) {
    const result = evaluated.get(profileId);
    if (!result) {
      blocking.push({
        code: 'MISSING_PROFILE',
        path: `results.${profileId}`,
        message: `No current primary PASS result exists for ${profileId}`,
      });
      continue;
    }
    commits.add(result.environment.git.commit);
    results.push({
      profileId,
      disposition: result.disposition,
      gitCommit: result.environment.git.commit,
    });
    if (result.disposition !== 'PASS') {
      blocking.push({
        code: 'PROFILE_NOT_PASSING',
        path: `results.${profileId}`,
        message: `${profileId} is ${result.disposition}`,
      });
    }
  }
  if (commits.size > 1) {
    blocking.push({
      code: 'SOURCE_REVISION_MISMATCH',
      path: 'results',
      message: 'All primary profile results must measure the same Git revision',
    });
  }
  const stableBlocking = stableReasons(blocking);
  return {
    schemaVersion: 1,
    profileSetId: profileSet.profileSetId,
    profileSetDigest: profileSet.profileSetDigest,
    status: stableBlocking.length === 0 ? 'PASS' : 'INCOMPLETE',
    results,
    blocking: stableBlocking,
  };
}

async function main(arguments_) {
  const [operation, profilePath, ...resultPaths] = arguments_;
  if (!operation || !profilePath) {
    throw usageError();
  }
  const profileSet = assertProfileSet(await readJsonFile(profilePath));
  if (operation === 'evaluate') {
    if (resultPaths.length !== 1) {
      throw usageError();
    }
    const result = evaluateRawResult(
      profileSet,
      await readJsonFile(resultPaths[0]),
    );
    process.stdout.write(`${canonicalStringify(result)}\n`);
    process.exitCode = result.disposition === 'PASS' ? 0 : 2;
    return;
  }
  if (operation === 'aggregate') {
    if (resultPaths.length === 0) {
      throw usageError();
    }
    const inputs = await Promise.all(
      resultPaths.map((path) => readJsonFile(path)),
    );
    const aggregate = aggregateResults(profileSet, inputs);
    process.stdout.write(`${canonicalStringify(aggregate)}\n`);
    process.exitCode = aggregate.status === 'PASS' ? 0 : 2;
    return;
  }
  throw usageError();
}

function evaluateRawBase(profileSet, result) {
  assertEqual(result.schemaVersion, 1, 'result.schemaVersion');
  assertEqual(
    result.profileSetId,
    profileSet.profileSetId,
    'result.profileSetId',
  );
  assertEqual(
    result.profileSetDigest,
    profileSet.profileSetDigest,
    'result.profileSetDigest',
  );
  assertOneOf(result.profileId, APPROVED_PROFILE_IDS, 'result.profileId');
  assertString(result.command, 1, 2_048, 'result.command');
  assertCanonicalTimestamp(result.recordedAt, 'result.recordedAt');
  assertEnvironmentRecord(result.environment, profileSet);
  assertEqual(
    result.environment.profileId,
    result.profileId,
    'result.environment.profileId',
  );
  const preflight = evaluatePreflight(profileSet, result.environment);
  const acknowledgements = parseAcknowledgements(
    result.acknowledgements,
    profileSet,
  );
  const distributions = parseDistributions(result.distributions, profileSet);
  const counters = parseCounters(result.counters, profileSet);
  const reasons = [];
  const statistics = [];

  if (preflight.status === 'UNVERIFIED') {
    if (acknowledgements.size > 0 || distributions.size > 0) {
      throw new EvidenceValidationError(
        'UNVERIFIED evidence cannot claim measurements',
        'result',
      );
    }
    assertZeroCounters(counters, 'result.counters');
    return evaluatedResult(result, statistics, 'UNVERIFIED', preflight.reasons);
  }

  if (preflight.status === 'SUPPLEMENTAL') {
    if (acknowledgements.size === 0 && distributions.size === 0) {
      assertZeroCounters(counters, 'result.counters');
    } else {
      collectStatistics(distributions, profileSet, statistics);
    }
    return evaluatedResult(
      result,
      statistics,
      'SUPPLEMENTAL',
      preflight.reasons,
    );
  }

  for (const branchId of profileSet.measurement.branchIds) {
    const samples = acknowledgements.get(branchId);
    if (!samples) {
      reasons.push(
        reason(
          'MISSING_BRANCH',
          `acknowledgements.${branchId}`,
          `Missing acknowledgement branch ${branchId}`,
        ),
      );
      continue;
    }
    if (samples.length < profileSet.measurement.minimumAcknowledgementSamples) {
      reasons.push(
        reason(
          'INSUFFICIENT_ACKNOWLEDGEMENTS',
          `acknowledgements.${branchId}`,
          `${branchId} requires at least ${profileSet.measurement.minimumAcknowledgementSamples} samples`,
        ),
      );
    }
    if (
      samples.some(
        (sample) => sample > profileSet.measurement.acknowledgementThresholdMs,
      )
    ) {
      reasons.push(
        reason(
          'ACKNOWLEDGEMENT_EXCEEDED',
          `acknowledgements.${branchId}`,
          `${branchId} contains a sample over ${profileSet.measurement.acknowledgementThresholdMs} ms`,
        ),
      );
    }
  }

  for (const distributionId of profileSet.measurement.distributionIds) {
    const distribution = distributions.get(distributionId);
    if (!distribution) {
      reasons.push(
        reason(
          'MISSING_DISTRIBUTION',
          `distributions.${distributionId}`,
          `Missing final distribution ${distributionId}`,
        ),
      );
      continue;
    }
    if (
      distribution.warmupsMs.length !== profileSet.measurement.warmupSamples
    ) {
      reasons.push(
        reason(
          'INVALID_WARMUP_COUNT',
          `distributions.${distributionId}.warmupsMs`,
          `${distributionId} requires exactly ${profileSet.measurement.warmupSamples} discarded warm-ups`,
        ),
      );
    }
    if (
      distribution.samplesMs.length < profileSet.measurement.minimumFinalSamples
    ) {
      reasons.push(
        reason(
          'INSUFFICIENT_FINAL_SAMPLES',
          `distributions.${distributionId}.samplesMs`,
          `${distributionId} requires at least ${profileSet.measurement.minimumFinalSamples} samples`,
        ),
      );
    }
    if (distribution.samplesMs.length > 0) {
      const summary = distributionStatistics(
        distribution.samplesMs,
        profileSet.measurement.finalThresholdMs,
      );
      verifyProducerSummary(distribution.summary, summary, distributionId);
      statistics.push({ distributionId, ...summary });
      if (summary.p95Ms > profileSet.measurement.finalThresholdMs) {
        reasons.push(
          reason(
            'P95_EXCEEDED',
            `distributions.${distributionId}.samplesMs`,
            `${distributionId} p95 ${summary.p95Ms} ms exceeds ${profileSet.measurement.finalThresholdMs} ms`,
          ),
        );
      }
      if (
        summary.withinTargetRatio <
        profileSet.measurement.minimumWithinTargetRatio
      ) {
        reasons.push(
          reason(
            'WITHIN_TARGET_RATIO_MISSED',
            `distributions.${distributionId}.samplesMs`,
            `${distributionId} within-target ratio ${summary.withinTargetRatio} is below ${profileSet.measurement.minimumWithinTargetRatio}`,
          ),
        );
      }
    }
  }

  for (const counterId of profileSet.measurement.zeroToleranceCounters) {
    const count = counters[counterId];
    if (count !== 0) {
      reasons.push(
        reason(
          'ZERO_TOLERANCE_VIOLATION',
          `counters.${counterId}`,
          `${counterId} must be zero but was ${count}`,
        ),
      );
    }
  }
  const stable = stableReasons(reasons);
  return evaluatedResult(
    result,
    statistics,
    stable.length === 0 ? 'PASS' : 'FAIL',
    stable,
  );
}

function parseAcknowledgements(value, profileSet) {
  assertArray(value, 'result.acknowledgements');
  if (value.length > profileSet.measurement.branchIds.length) {
    throw new EvidenceValidationError(
      'contains too many branches',
      'result.acknowledgements',
    );
  }
  const entries = new Map();
  value.forEach((entry, index) => {
    const path = `result.acknowledgements[${index}]`;
    assertRecord(entry, path);
    assertExactKeys(entry, ['branchId', 'samplesMs'], path);
    assertOneOf(
      entry.branchId,
      profileSet.measurement.branchIds,
      `${path}.branchId`,
    );
    if (entries.has(entry.branchId)) {
      throw new EvidenceValidationError(
        `duplicate branch ${entry.branchId}`,
        `${path}.branchId`,
      );
    }
    entries.set(
      entry.branchId,
      assertTimingArray(entry.samplesMs, `${path}.samplesMs`),
    );
  });
  return entries;
}

function parseDistributions(value, profileSet) {
  assertArray(value, 'result.distributions');
  if (value.length > profileSet.measurement.distributionIds.length) {
    throw new EvidenceValidationError(
      'contains too many distributions',
      'result.distributions',
    );
  }
  const entries = new Map();
  value.forEach((entry, index) => {
    const path = `result.distributions[${index}]`;
    assertRecord(entry, path);
    const hasSummary = Object.hasOwn(entry, 'summary');
    assertExactKeys(
      entry,
      hasSummary
        ? ['distributionId', 'warmupsMs', 'samplesMs', 'summary']
        : ['distributionId', 'warmupsMs', 'samplesMs'],
      path,
    );
    assertOneOf(
      entry.distributionId,
      profileSet.measurement.distributionIds,
      `${path}.distributionId`,
    );
    if (entries.has(entry.distributionId)) {
      throw new EvidenceValidationError(
        `duplicate distribution ${entry.distributionId}`,
        `${path}.distributionId`,
      );
    }
    const distribution = {
      warmupsMs: assertTimingArray(entry.warmupsMs, `${path}.warmupsMs`),
      samplesMs: assertTimingArray(entry.samplesMs, `${path}.samplesMs`),
      summary: hasSummary
        ? assertSummary(entry.summary, `${path}.summary`)
        : null,
    };
    entries.set(entry.distributionId, distribution);
  });
  return entries;
}

function parseCounters(value, profileSet) {
  assertRecord(value, 'result.counters');
  assertExactKeys(
    value,
    profileSet.measurement.zeroToleranceCounters,
    'result.counters',
  );
  for (const counterId of profileSet.measurement.zeroToleranceCounters) {
    assertSafeInteger(
      value[counterId],
      0,
      1_000_000,
      `result.counters.${counterId}`,
    );
  }
  return value;
}

function assertSummary(value, path) {
  assertRecord(value, path);
  assertExactKeys(
    value,
    ['count', 'p50Ms', 'p95Ms', 'maxMs', 'withinTargetRatio'],
    path,
  );
  assertSafeInteger(value.count, 1, 10_000, `${path}.count`);
  assertFiniteNumber(value.p50Ms, 0, 86_400_000, `${path}.p50Ms`);
  assertFiniteNumber(value.p95Ms, 0, 86_400_000, `${path}.p95Ms`);
  assertFiniteNumber(value.maxMs, 0, 86_400_000, `${path}.maxMs`);
  assertFiniteNumber(
    value.withinTargetRatio,
    0,
    1,
    `${path}.withinTargetRatio`,
  );
  return value;
}

function verifyProducerSummary(claimed, actual, distributionId) {
  if (claimed && canonicalStringify(claimed) !== canonicalStringify(actual)) {
    throw new EvidenceValidationError(
      'producer summary does not match recomputed raw evidence',
      `result.distributions.${distributionId}.summary`,
    );
  }
}

function collectStatistics(distributions, profileSet, statistics) {
  for (const distributionId of profileSet.measurement.distributionIds) {
    const distribution = distributions.get(distributionId);
    if (distribution?.samplesMs.length) {
      const summary = distributionStatistics(
        distribution.samplesMs,
        profileSet.measurement.finalThresholdMs,
      );
      verifyProducerSummary(distribution.summary, summary, distributionId);
      statistics.push({ distributionId, ...summary });
    }
  }
}

function assertZeroCounters(counters, path) {
  if (Object.values(counters).some((count) => count !== 0)) {
    throw new EvidenceValidationError(
      'non-measured evidence cannot claim error or result counters',
      path,
    );
  }
}

function evaluatedResult(result, statistics, disposition, reasons) {
  return {
    ...result,
    statistics,
    disposition,
    reasons: stableReasons(reasons),
  };
}

function assertCanonicalTimestamp(value, path) {
  assertString(value, 24, 24, path);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new EvidenceValidationError(
      'must be a canonical UTC timestamp',
      path,
    );
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

function reason(code, path, message) {
  return { code, path, message };
}

function usageError() {
  return new EvidenceValidationError(
    'usage: performance-evidence.mjs evaluate <profile-set.json> <raw-result.json> | aggregate <profile-set.json> <result.json>...',
    'arguments',
  );
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
