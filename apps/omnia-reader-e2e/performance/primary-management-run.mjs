import {
  EvidenceValidationError,
  assertBoolean,
  assertEnvironmentRecord,
  assertExactKeys,
  assertFiniteNumber,
  assertProfileSet,
  assertRecord,
  assertSafeInteger,
  assertString,
  canonicalStringify,
} from './performance-contract.mjs';
import {
  MANAGEMENT_BRANCHES,
  MANAGEMENT_DISTRIBUTIONS,
  assertManagementContract,
} from './management-branches.mjs';
import { assertManagementWorkload } from './management-workload.mjs';
import { evaluatePreflight } from './validate-profile.mjs';

const RESULT_MAX_MS = 86_400_000;

export function assertSamplingIdentity(
  profileSetInput,
  environmentInput,
  workloadInput,
  value,
) {
  const profileSet = assertProfileSet(profileSetInput);
  const environment = assertEnvironmentRecord(environmentInput, profileSet);
  const workload = assertManagementWorkload(workloadInput);
  assertRecord(value, 'samplingIdentity');
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'profileSetId',
      'profileSetDigest',
      'profileId',
      'git',
      'dataset',
      'browser',
      'viewport',
      'constraints',
    ],
    'samplingIdentity',
  );
  assertSafeInteger(
    value.schemaVersion,
    1,
    1,
    'samplingIdentity.schemaVersion',
  );
  assertString(value.profileSetId, 1, 128, 'samplingIdentity.profileSetId');
  assertString(
    value.profileSetDigest,
    1,
    128,
    'samplingIdentity.profileSetDigest',
  );
  assertString(value.profileId, 1, 128, 'samplingIdentity.profileId');
  assertGit(value.git);
  assertDataset(value.dataset);
  assertBrowser(value.browser);
  assertViewport(value.viewport);
  assertConstraints(value.constraints);

  const [width, height] = expectedViewport(environment);
  const expected = {
    schemaVersion: 1,
    profileSetId: profileSet.profileSetId,
    profileSetDigest: profileSet.profileSetDigest,
    profileId: environment.profileId,
    git: { ...environment.git },
    dataset: {
      recipeDigest: workload.recipeDigest,
      workloadDigest: workload.workloadDigest,
      logicalBooks: workload.logicalBooks,
      exactVariants: workload.exactVariants,
      logicalChangeHistory: workload.logicalChangeHistory,
    },
    browser: {
      name: environment.values['runtime.browserName'],
      version: environment.values['runtime.browserVersion'],
    },
    viewport: {
      width,
      height,
      deviceScaleFactor: environment.values['environment.deviceScaleFactor'],
    },
    constraints: {
      scope: environment.values['environment.constraintScope'],
      cpuQuota: environment.values['environment.cpuQuota'],
      memoryLimitBytes: environment.values['environment.memoryLimitBytes'],
      powerMode: environment.values['environment.powerMode'],
    },
  };
  if (canonicalStringify(value) !== canonicalStringify(expected)) {
    throw new EvidenceValidationError(
      'does not match the qualified sampling environment',
      'samplingIdentity',
    );
  }
  return value;
}

export async function runPrimaryManagementMeasurement(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EvidenceValidationError('must be an object', 'options');
  }
  const {
    profileSet: profileSetInput,
    environment: environmentInput,
    workload: workloadInput,
    samplingIdentity,
    command,
    runBranchSample,
    runDistributionSample,
    readCounters,
    recordedAt,
  } = options;
  const profileSet = assertProfileSet(profileSetInput);
  const environment = assertEnvironmentRecord(environmentInput, profileSet);
  const workload = assertManagementWorkload(workloadInput);
  assertManagementContract({
    branches: MANAGEMENT_BRANCHES,
    distributions: MANAGEMENT_DISTRIBUTIONS,
  });
  const preflight = evaluatePreflight(profileSet, environment);
  if (preflight.status !== 'READY' || preflight.mayMeasure !== true) {
    throw new EvidenceValidationError(
      'primary measurement requires READY preflight',
      'environment',
    );
  }
  assertSamplingIdentity(profileSet, environment, workload, samplingIdentity);
  assertString(command, 1, 2_048, 'options.command');
  assertFunction(runBranchSample, 'options.runBranchSample');
  assertFunction(runDistributionSample, 'options.runDistributionSample');
  assertFunction(readCounters, 'options.readCounters');
  if (recordedAt !== undefined)
    assertFunction(recordedAt, 'options.recordedAt');

  const acknowledgements = [];
  for (const branch of MANAGEMENT_BRANCHES) {
    const samplesMs = [];
    for (
      let sampleIndex = 0;
      sampleIndex < profileSet.measurement.minimumAcknowledgementSamples;
      sampleIndex += 1
    ) {
      const sample = await runBranchSample({ branch, sampleIndex });
      const validated = assertBranchSample(
        sample,
        `branch.${branch.id}[${sampleIndex}]`,
      );
      samplesMs.push(validated.acknowledgementMs);
    }
    acknowledgements.push({ branchId: branch.id, samplesMs });
  }

  const distributions = [];
  for (const distribution of MANAGEMENT_DISTRIBUTIONS) {
    const warmupsMs = [];
    const samplesMs = [];
    for (
      let sampleIndex = 0;
      sampleIndex < profileSet.measurement.warmupSamples;
      sampleIndex += 1
    ) {
      const sample = await runDistributionSample({
        distribution,
        phase: 'warmup',
        sampleIndex,
      });
      warmupsMs.push(
        assertDistributionSample(
          sample,
          `distribution.${distribution.id}.warmup[${sampleIndex}]`,
        ).finalResultMs,
      );
    }
    for (
      let sampleIndex = 0;
      sampleIndex < profileSet.measurement.minimumFinalSamples;
      sampleIndex += 1
    ) {
      const sample = await runDistributionSample({
        distribution,
        phase: 'sample',
        sampleIndex,
      });
      samplesMs.push(
        assertDistributionSample(
          sample,
          `distribution.${distribution.id}.sample[${sampleIndex}]`,
        ).finalResultMs,
      );
    }
    distributions.push({
      distributionId: distribution.id,
      warmupsMs,
      samplesMs,
    });
  }

  const counters = assertCounters(await readCounters(), profileSet);
  const timestamp = recordedAt ? await recordedAt() : new Date().toISOString();
  assertCanonicalTimestamp(timestamp, 'result.recordedAt');
  return {
    schemaVersion: 1,
    profileSetId: profileSet.profileSetId,
    profileSetDigest: profileSet.profileSetDigest,
    profileId: environment.profileId,
    command,
    recordedAt: timestamp,
    environment,
    acknowledgements,
    distributions,
    counters,
  };
}

function assertBranchSample(value, path) {
  assertRecord(value, path);
  assertExactKeys(value, ['acknowledgementMs', 'finalResultMs'], path);
  const acknowledgementMs = assertFiniteNumber(
    value.acknowledgementMs,
    0,
    RESULT_MAX_MS,
    `${path}.acknowledgementMs`,
  );
  const finalResultMs = assertFiniteNumber(
    value.finalResultMs,
    acknowledgementMs,
    RESULT_MAX_MS,
    `${path}.finalResultMs`,
  );
  return { acknowledgementMs, finalResultMs };
}

function assertDistributionSample(value, path) {
  assertRecord(value, path);
  assertExactKeys(value, ['finalResultMs'], path);
  return {
    finalResultMs: assertFiniteNumber(
      value.finalResultMs,
      0,
      RESULT_MAX_MS,
      `${path}.finalResultMs`,
    ),
  };
}

function assertCounters(value, profileSet) {
  assertRecord(value, 'counters');
  assertExactKeys(
    value,
    profileSet.measurement.zeroToleranceCounters,
    'counters',
  );
  return Object.fromEntries(
    profileSet.measurement.zeroToleranceCounters.map((counterId) => [
      counterId,
      assertSafeInteger(
        value[counterId],
        0,
        1_000_000,
        `counters.${counterId}`,
      ),
    ]),
  );
}

function assertGit(value) {
  assertRecord(value, 'samplingIdentity.git');
  assertExactKeys(value, ['commit', 'dirty'], 'samplingIdentity.git');
  assertString(value.commit, 40, 64, 'samplingIdentity.git.commit');
  assertBoolean(value.dirty, 'samplingIdentity.git.dirty');
}

function assertDataset(value) {
  assertRecord(value, 'samplingIdentity.dataset');
  assertExactKeys(
    value,
    [
      'recipeDigest',
      'workloadDigest',
      'logicalBooks',
      'exactVariants',
      'logicalChangeHistory',
    ],
    'samplingIdentity.dataset',
  );
  assertString(
    value.recipeDigest,
    1,
    128,
    'samplingIdentity.dataset.recipeDigest',
  );
  assertString(
    value.workloadDigest,
    1,
    128,
    'samplingIdentity.dataset.workloadDigest',
  );
  assertSafeInteger(
    value.logicalBooks,
    0,
    1_000_000,
    'samplingIdentity.dataset.logicalBooks',
  );
  assertSafeInteger(
    value.exactVariants,
    0,
    1_000_000,
    'samplingIdentity.dataset.exactVariants',
  );
  assertSafeInteger(
    value.logicalChangeHistory,
    0,
    1_000_000,
    'samplingIdentity.dataset.logicalChangeHistory',
  );
}

function assertBrowser(value) {
  assertRecord(value, 'samplingIdentity.browser');
  assertExactKeys(value, ['name', 'version'], 'samplingIdentity.browser');
  assertString(value.name, 1, 128, 'samplingIdentity.browser.name');
  assertString(value.version, 1, 128, 'samplingIdentity.browser.version');
}

function assertViewport(value) {
  assertRecord(value, 'samplingIdentity.viewport');
  assertExactKeys(
    value,
    ['width', 'height', 'deviceScaleFactor'],
    'samplingIdentity.viewport',
  );
  assertSafeInteger(value.width, 1, 16_384, 'samplingIdentity.viewport.width');
  assertSafeInteger(
    value.height,
    1,
    16_384,
    'samplingIdentity.viewport.height',
  );
  assertFiniteNumber(
    value.deviceScaleFactor,
    0.1,
    16,
    'samplingIdentity.viewport.deviceScaleFactor',
  );
}

function assertConstraints(value) {
  assertRecord(value, 'samplingIdentity.constraints');
  assertExactKeys(
    value,
    ['scope', 'cpuQuota', 'memoryLimitBytes', 'powerMode'],
    'samplingIdentity.constraints',
  );
  assertString(value.scope, 1, 128, 'samplingIdentity.constraints.scope');
  assertFiniteNumber(
    value.cpuQuota,
    0.01,
    1_024,
    'samplingIdentity.constraints.cpuQuota',
  );
  assertSafeInteger(
    value.memoryLimitBytes,
    1,
    Number.MAX_SAFE_INTEGER,
    'samplingIdentity.constraints.memoryLimitBytes',
  );
  assertString(
    value.powerMode,
    1,
    128,
    'samplingIdentity.constraints.powerMode',
  );
}

function expectedViewport(environment) {
  const value = environment.values['environment.viewport'];
  if (typeof value !== 'string' || !/^\d+x\d+$/.test(value)) {
    throw new EvidenceValidationError(
      'must be WIDTHxHEIGHT for desktop sampling',
      'environment.values.environment.viewport',
    );
  }
  return value.split('x').map(Number);
}

function assertFunction(value, path) {
  if (typeof value !== 'function') {
    throw new EvidenceValidationError('must be a function', path);
  }
}

function assertCanonicalTimestamp(value, path) {
  assertString(value, 20, 64, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new EvidenceValidationError(
      'must be a canonical UTC timestamp',
      path,
    );
  }
}
