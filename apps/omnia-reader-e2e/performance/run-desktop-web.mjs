import {
  EvidenceValidationError,
  atomicWriteEvidence,
  canonicalStringify,
} from './performance-contract.mjs';
import { evaluateRawResult } from './performance-evidence.mjs';
import { evaluatePreflight } from './validate-profile.mjs';

export class DesktopQualificationError extends Error {
  constructor(preflight) {
    super(
      `desktop-web-v1 is not qualified for primary measurement: ${preflight.status}`,
    );
    this.name = 'DesktopQualificationError';
    this.preflight = preflight;
  }
}

export async function runQualifiedDesktopMeasurement(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EvidenceValidationError('must be an object', 'options');
  }
  const { profileSet, environment, resultsRoot, outputName, measure } = options;
  if (typeof measure !== 'function') {
    throw new EvidenceValidationError(
      'must be a measurement function',
      'options.measure',
    );
  }
  if (environment?.profileId !== 'desktop-web-v1') {
    throw new EvidenceValidationError(
      'must select desktop-web-v1',
      'options.environment.profileId',
    );
  }

  const preflight = evaluatePreflight(profileSet, environment);
  if (preflight.status !== 'READY' || preflight.mayMeasure !== true) {
    throw new DesktopQualificationError(preflight);
  }

  const rawResult = await measure({ profileSet, environment, preflight });
  if (
    !rawResult ||
    typeof rawResult !== 'object' ||
    Array.isArray(rawResult) ||
    canonicalStringify(rawResult.environment) !==
      canonicalStringify(environment)
  ) {
    throw new EvidenceValidationError(
      'environment changed after preflight',
      'result.environment',
    );
  }
  const result = evaluateRawResult(profileSet, rawResult);
  if (!['PASS', 'FAIL'].includes(result.disposition)) {
    throw new EvidenceValidationError(
      'qualified primary measurement must evaluate to PASS or FAIL',
      'result.disposition',
    );
  }
  const outputPath = await atomicWriteEvidence(resultsRoot, outputName, result);
  return {
    preflight,
    result,
    outputPath,
    exitCode: result.disposition === 'PASS' ? 0 : 2,
  };
}
