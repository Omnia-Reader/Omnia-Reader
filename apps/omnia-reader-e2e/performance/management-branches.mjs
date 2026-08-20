import {
  APPROVED_BRANCH_IDS,
  APPROVED_DISTRIBUTION_IDS,
  EvidenceValidationError,
  assertArray,
  assertExactKeys,
  assertRecord,
  canonicalStringify,
} from './performance-contract.mjs';

const branches = [
  branch(
    'add-local-success',
    'add-local',
    'success',
    'change',
    'missing-format file input',
    'visible add progress or busy state',
    'originating card exposes the added healthy format and one-card inventory',
    null,
  ),
  branch(
    'add-local-failure',
    'add-local',
    'failure',
    'change',
    'missing-format file input',
    'visible invalid-publication error',
    'originating inventory remains unchanged with the missing format available',
    'corrupt-or-unsupported-source',
  ),
  branch(
    'associate-success',
    'associate',
    'success',
    'click',
    'associate-books confirmation',
    'visible association progress or confirmation state',
    'one logical card exposes both healthy formats',
    null,
  ),
  branch(
    'associate-failure',
    'associate',
    'failure',
    'click',
    'associate-books confirmation',
    'visible stale-or-occupied association error',
    'both original logical cards and memberships remain unchanged',
    'stale-or-occupied-format-conflict',
  ),
  branch(
    'detach-success',
    'detach',
    'success',
    'click',
    'separate-format confirmation',
    'visible separation progress or confirmation state',
    'two durable standalone logical cards retain their publication bytes',
    null,
  ),
  branch(
    'detach-failure',
    'detach',
    'failure',
    'click',
    'separate-format confirmation',
    'visible storage transaction error',
    'the original combined logical card remains unchanged',
    'injected-storage-transaction-failure',
  ),
  branch(
    'delete-success',
    'delete',
    'success',
    'click',
    'remove-format confirmation',
    'visible deletion progress or confirmation state',
    'the selected variant is absent and its sibling remains healthy',
    null,
  ),
  branch(
    'delete-failure',
    'delete',
    'failure',
    'click',
    'remove-format confirmation',
    'visible storage transaction error',
    'the original sibling-preserving inventory remains unchanged',
    'injected-storage-transaction-failure',
  ),
  branch(
    'reconcile-success',
    'reconcile',
    'success',
    'click',
    'membership-resolution confirmation',
    'visible reconciliation progress or confirmation state',
    'the explicit child resolution is durable and the conflict is absent',
    null,
  ),
  branch(
    'reconcile-failure',
    'reconcile',
    'failure',
    'click',
    'membership-resolution confirmation',
    'visible stale-head rejection',
    'the conflict and original memberships remain unchanged',
    'stale-head-rejection',
  ),
  branch(
    'replace-success',
    'replace',
    'success',
    'change',
    'replacement publication file input',
    'visible replacement progress or confirmation state',
    'the exact unavailable variant is healthy with verified replacement bytes',
    null,
  ),
  branch(
    'replace-failure',
    'replace',
    'failure',
    'change',
    'replacement publication file input',
    'visible identity-size-or-format mismatch error',
    'the unavailable variant and stored metadata remain unchanged',
    'identity-size-or-format-mismatch',
  ),
  branch(
    'restore-success',
    'restore',
    'success',
    'change',
    'backup archive file input',
    'visible restore validation or progress state',
    'the complete canonical conflict report or restored inventory is visible',
    null,
  ),
  branch(
    'restore-failure',
    'restore',
    'failure',
    'change',
    'backup archive file input',
    'visible malformed-archive or stale-precommit error',
    'the pre-restore library revision and inventory remain unchanged',
    'malformed-archive-or-stale-precommit',
  ),
];

const distributions = [
  distribution(
    'filter',
    'input',
    'library search input',
    'summary and visible cards match the entered filter',
  ),
  distribution(
    'open-epub',
    'click',
    'healthy EPUB format badge',
    'selected EPUB state and visible first iframe content',
  ),
  distribution(
    'open-pdf',
    'click',
    'healthy PDF format badge',
    'selected PDF state and visible first-page canvas',
  ),
  distribution(
    'switch-epub-to-pdf',
    'click',
    'reader PDF format control',
    'selected PDF state and visible first-page canvas with no EPUB engine',
  ),
  distribution(
    'switch-pdf-to-epub',
    'click',
    'reader EPUB format control',
    'selected EPUB state and visible iframe content with no PDF engine',
  ),
];

export const MANAGEMENT_BRANCHES = deepFreeze(branches);
export const MANAGEMENT_DISTRIBUTIONS = deepFreeze(distributions);

export function assertManagementContract(value) {
  assertRecord(value, 'managementContract');
  assertExactKeys(value, ['branches', 'distributions'], 'managementContract');
  assertArray(value.branches, 'managementContract.branches');
  assertArray(value.distributions, 'managementContract.distributions');
  if (
    canonicalStringify(value.branches) !==
    canonicalStringify(MANAGEMENT_BRANCHES)
  ) {
    throw new EvidenceValidationError(
      `must contain exactly the frozen branches ${APPROVED_BRANCH_IDS.join(', ')}`,
      'managementContract.branches',
    );
  }
  if (
    canonicalStringify(value.distributions) !==
    canonicalStringify(MANAGEMENT_DISTRIBUTIONS)
  ) {
    throw new EvidenceValidationError(
      `must contain exactly the frozen distributions ${APPROVED_DISTRIBUTION_IDS.join(', ')}`,
      'managementContract.distributions',
    );
  }
  return value;
}

function branch(
  id,
  action,
  outcome,
  activationEvent,
  activationControl,
  acknowledgementState,
  finalState,
  failureMechanism,
) {
  return {
    id,
    action,
    outcome,
    activation: { event: activationEvent, control: activationControl },
    acknowledgement: { semanticState: acknowledgementState },
    finalState: { semanticState: finalState },
    failureMechanism,
  };
}

function distribution(id, activationEvent, activationControl, finalState) {
  return {
    id,
    activation: { event: activationEvent, control: activationControl },
    finalState: { semanticState: finalState },
    warmups: 20,
    minimumSamples: 200,
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
