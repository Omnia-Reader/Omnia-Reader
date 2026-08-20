import {
  EvidenceValidationError,
  assertEnvironmentRecord,
  assertProfileSet,
  stableReasons,
} from './performance-contract.mjs';

export function evaluatePreflight(profileSetInput, environmentInput) {
  const profileSet = assertProfileSet(profileSetInput);
  const environment = assertEnvironmentRecord(environmentInput, profileSet);
  const profile = profileSet.profiles.find(
    (entry) => entry.id === environment.profileId,
  );
  if (!profile) {
    throw new EvidenceValidationError(
      'selected profile does not exist',
      'environment.profileId',
    );
  }
  const allowedKeys = new Set(Object.keys(profile.requirements));
  for (const key of Object.keys(environment.values)) {
    if (!allowedKeys.has(key)) {
      throw new EvidenceValidationError(
        'contains an unreviewed environment value',
        `environment.values.${key}`,
      );
    }
  }

  const reasons = [];
  if (profile.qualification === 'unresolved') {
    for (const requirement of profile.unresolvedRequirements) {
      reasons.push({
        code: 'PROFILE_IDENTITY_UNRESOLVED',
        path: `profile.requirements.${requirement}`,
        message: `${profile.id} cannot qualify primary evidence until ${requirement} is frozen in a new profile-set version`,
      });
    }
  }
  if (environment.availability === 'unavailable') {
    environment.unavailableReasons.forEach((message, index) =>
      reasons.push({
        code: 'ENVIRONMENT_UNAVAILABLE',
        path: `unavailableReasons[${index}]`,
        message,
      }),
    );
  }
  if (environment.intent === 'supplemental') {
    reasons.push({
      code: 'SUPPLEMENTAL_INTENT',
      path: 'intent',
      message:
        'The environment was explicitly captured as non-primary evidence',
    });
  }
  if (environment.git.dirty) {
    reasons.push({
      code: 'DIRTY_WORKTREE',
      path: 'git.dirty',
      message: 'Primary evidence requires a clean Git worktree',
    });
  }
  if (environment.driver !== profile.driver) {
    reasons.push(mismatchReason('driver', profile.driver, environment.driver));
  }
  for (const [key, expected] of Object.entries(profile.requirements)) {
    const actual = environment.values[key];
    if (!matchesRequirement(actual, expected)) {
      reasons.push(mismatchReason(`values.${key}`, expected, actual));
    }
  }

  let status;
  if (
    environment.availability === 'unavailable' ||
    profile.qualification === 'unresolved'
  ) {
    status = 'UNVERIFIED';
  } else if (environment.intent === 'supplemental' || environment.git.dirty) {
    status = 'SUPPLEMENTAL';
  } else if (reasons.length > 0) {
    status = 'UNVERIFIED';
  } else {
    status = 'READY';
  }
  return {
    schemaVersion: 1,
    profileSetId: profileSet.profileSetId,
    profileSetDigest: profileSet.profileSetDigest,
    profileId: environment.profileId,
    status,
    mayMeasure: status === 'READY',
    git: { ...environment.git },
    reasons: stableReasons(reasons),
  };
}

function mismatchReason(path, expected, actual) {
  return {
    code: 'PROFILE_MISMATCH',
    path,
    message: `Expected ${displayValue(expected)} but received ${displayValue(actual)}`,
  };
}

function matchesRequirement(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (expected.format === 'sha256') {
      return typeof actual === 'string' && /^sha256:[a-f0-9]{64}$/.test(actual);
    }
    return false;
  }
  return Object.is(actual, expected);
}

function displayValue(value) {
  return value === undefined ? '<missing>' : JSON.stringify(value);
}
