/* eslint-disable playwright/expect-expect -- Node tests assert through node:assert. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APPROVED_BRANCH_IDS,
  APPROVED_DISTRIBUTION_IDS,
  EvidenceValidationError,
  MAX_JSON_BYTES,
  canonicalStringify,
  readJsonFile,
} from './performance-contract.mjs';
import {
  MANAGEMENT_BRANCHES,
  MANAGEMENT_DISTRIBUTIONS,
  assertManagementContract,
} from './management-branches.mjs';
import {
  FROZEN_RECIPE_DIGEST,
  assertManagementWorkload,
  createManagementWorkload,
  managementWorkloadDigest,
} from './management-workload.mjs';

test('generates the exact deterministic 1,000-book workload identity', async () => {
  const first = createManagementWorkload();
  const second = createManagementWorkload();
  const profileSet = await readJsonFile(
    'specs/001-multi-format-books/performance/profiles-v1.json',
  );

  assert.equal(canonicalStringify(first), canonicalStringify(second));
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.recipeId, 'multi-format-management-v1');
  assert.equal(first.recipeDigest, FROZEN_RECIPE_DIGEST);
  assert.equal(first.recipeDigest, profileSet.dataset.recipeDigest);
  assert.equal(first.seed, 'omnia-reader-multi-format-v1');
  assert.equal(first.logicalBooks, 1_000);
  assert.equal(first.exactVariants, 2_000);
  assert.deepEqual(first.formats, ['epub', 'pdf']);
  assert.equal(first.logicalChangeHistory, 500);
  assert.equal(first.items.length, 1_000);
  assert.equal(
    first.items.reduce((total, item) => total + item.historyDepth, 0),
    500,
  );
  assert.equal(first.workloadDigest, managementWorkloadDigest(first));
  assert.ok(Buffer.byteLength(canonicalStringify(first)) < MAX_JSON_BYTES);
  assert.equal(assertManagementWorkload(first), first);
});

test('creates ordered unique logical and exact-variant descriptors', () => {
  const workload = createManagementWorkload();
  const logicalIds = new Set();
  const variantIds = new Set();

  workload.items.forEach((item, ordinal) => {
    assert.equal(item.ordinal, ordinal);
    assert.match(item.logicalBookId, /^logical:sha256:[a-f0-9]{64}$/);
    assert.match(item.title, /^Omnia Performance Book \d{4}$/);
    assert.equal(item.historyDepth, ordinal < 500 ? 1 : 0);
    assert.equal(item.epub.format, 'epub');
    assert.equal(item.epub.mediaType, 'application/epub+zip');
    assert.match(item.epub.fileName, /^omnia-performance-\d{4}\.epub$/);
    assert.equal(item.pdf.format, 'pdf');
    assert.equal(item.pdf.mediaType, 'application/pdf');
    assert.match(item.pdf.fileName, /^omnia-performance-\d{4}\.pdf$/);
    assert.match(item.epub.variantKey, /^variant:sha256:[a-f0-9]{64}$/);
    assert.match(item.pdf.variantKey, /^variant:sha256:[a-f0-9]{64}$/);
    assert.equal(logicalIds.has(item.logicalBookId), false);
    assert.equal(variantIds.has(item.epub.variantKey), false);
    assert.equal(variantIds.has(item.pdf.variantKey), false);
    logicalIds.add(item.logicalBookId);
    variantIds.add(item.epub.variantKey);
    variantIds.add(item.pdf.variantKey);
  });

  assert.equal(logicalIds.size, 1_000);
  assert.equal(variantIds.size, 2_000);
});

test('rejects unknown, incomplete, duplicated, drifted, or noncanonical workloads', () => {
  const valid = createManagementWorkload();
  const invalid = [
    { ...structuredClone(valid), unknown: true },
    { ...structuredClone(valid), logicalBooks: 999 },
    { ...structuredClone(valid), exactVariants: 1_999 },
    { ...structuredClone(valid), logicalChangeHistory: 499 },
    { ...structuredClone(valid), recipeDigest: `sha256:${'0'.repeat(64)}` },
    { ...structuredClone(valid), workloadDigest: `sha256:${'0'.repeat(64)}` },
    { ...structuredClone(valid), items: valid.items.slice(0, -1) },
  ];

  const duplicate = structuredClone(valid);
  duplicate.items[1] = structuredClone(duplicate.items[0]);
  invalid.push(duplicate);

  const changedSeed = structuredClone(valid);
  changedSeed.items[0].epub.contentSeed = 'semantic-drift';
  changedSeed.workloadDigest = managementWorkloadDigest(changedSeed);
  invalid.push(changedSeed);

  const reordered = structuredClone(valid);
  [reordered.items[0], reordered.items[1]] = [
    reordered.items[1],
    reordered.items[0],
  ];
  reordered.workloadDigest = managementWorkloadDigest(reordered);
  invalid.push(reordered);

  for (const candidate of invalid) {
    assert.throws(
      () => assertManagementWorkload(candidate),
      EvidenceValidationError,
    );
  }
});

test('freezes exactly fourteen management branches and five distributions', () => {
  assert.deepEqual(
    MANAGEMENT_BRANCHES.map(({ id }) => id),
    APPROVED_BRANCH_IDS,
  );
  assert.deepEqual(
    MANAGEMENT_DISTRIBUTIONS.map(({ id }) => id),
    APPROVED_DISTRIBUTION_IDS,
  );
  assert.equal(new Set(MANAGEMENT_BRANCHES.map(({ id }) => id)).size, 14);
  assert.equal(new Set(MANAGEMENT_DISTRIBUTIONS.map(({ id }) => id)).size, 5);
  assertManagementContract({
    branches: MANAGEMENT_BRANCHES,
    distributions: MANAGEMENT_DISTRIBUTIONS,
  });

  for (const branch of MANAGEMENT_BRANCHES) {
    assert.ok(['click', 'change', 'input'].includes(branch.activation.event));
    assert.ok(branch.activation.control.length > 0);
    assert.ok(branch.acknowledgement.semanticState.length > 0);
    assert.ok(branch.finalState.semanticState.length > 0);
    assert.equal(
      branch.outcome === 'success',
      branch.failureMechanism === null,
    );
  }
  for (const distribution of MANAGEMENT_DISTRIBUTIONS) {
    assert.equal(distribution.warmups, 20);
    assert.equal(distribution.minimumSamples, 200);
    assert.ok(['click', 'input'].includes(distribution.activation.event));
    assert.ok(distribution.finalState.semanticState.length > 0);
  }
});

test('rejects branch and distribution omissions, duplicates, drift, and unknown fields', () => {
  const valid = {
    branches: structuredClone(MANAGEMENT_BRANCHES),
    distributions: structuredClone(MANAGEMENT_DISTRIBUTIONS),
  };
  const invalid = [
    { ...structuredClone(valid), unknown: true },
    { ...structuredClone(valid), branches: valid.branches.slice(1) },
    {
      ...structuredClone(valid),
      distributions: valid.distributions.slice(0, -1),
    },
  ];

  const duplicate = structuredClone(valid);
  duplicate.branches[1] = structuredClone(duplicate.branches[0]);
  invalid.push(duplicate);

  const changedBoundary = structuredClone(valid);
  changedBoundary.branches[0].acknowledgement.semanticState = 'any busy state';
  invalid.push(changedBoundary);

  const unknownField = structuredClone(valid);
  unknownField.distributions[0].unknown = true;
  invalid.push(unknownField);

  for (const candidate of invalid) {
    assert.throws(
      () => assertManagementContract(candidate),
      EvidenceValidationError,
    );
  }
});
