import { createHash } from 'node:crypto';
import {
  EvidenceValidationError,
  assertArray,
  assertExactKeys,
  assertRecord,
  canonicalStringify,
} from './performance-contract.mjs';

export const FROZEN_RECIPE_DIGEST =
  'sha256:0894f7a3c2ba59242b79447ca3e87836036135e489a8830aa4c6b52e8c76c7ae';

const RECIPE_ID = 'multi-format-management-v1';
const SEED = 'omnia-reader-multi-format-v1';
const LOGICAL_BOOKS = 1_000;
const EXACT_VARIANTS = 2_000;
const LOGICAL_CHANGE_HISTORY = 500;
const WORKLOAD_KEYS = [
  'schemaVersion',
  'recipeId',
  'recipeDigest',
  'workloadDigest',
  'seed',
  'logicalBooks',
  'exactVariants',
  'formats',
  'logicalChangeHistory',
  'items',
];

export function createManagementWorkload() {
  const workload = {
    schemaVersion: 1,
    recipeId: RECIPE_ID,
    recipeDigest: FROZEN_RECIPE_DIGEST,
    workloadDigest: '',
    seed: SEED,
    logicalBooks: LOGICAL_BOOKS,
    exactVariants: EXACT_VARIANTS,
    formats: ['epub', 'pdf'],
    logicalChangeHistory: LOGICAL_CHANGE_HISTORY,
    items: Array.from({ length: LOGICAL_BOOKS }, (_, ordinal) =>
      createItem(ordinal),
    ),
  };
  workload.workloadDigest = managementWorkloadDigest(workload);
  return workload;
}

export function managementWorkloadDigest(workloadInput) {
  assertRecord(workloadInput, 'workload');
  const content = { ...workloadInput };
  delete content.workloadDigest;
  return `sha256:${createHash('sha256')
    .update(canonicalStringify(content), 'utf8')
    .digest('hex')}`;
}

export function assertManagementWorkload(value) {
  assertRecord(value, 'workload');
  assertExactKeys(value, WORKLOAD_KEYS, 'workload');
  assertArray(value.items, 'workload.items');
  if (value.items.length !== LOGICAL_BOOKS) {
    throw new EvidenceValidationError(
      `must contain exactly ${LOGICAL_BOOKS} logical books`,
      'workload.items',
    );
  }
  const expected = createManagementWorkload();

  if (value.workloadDigest !== managementWorkloadDigest(value)) {
    throw new EvidenceValidationError(
      'workloadDigest does not match canonical workload content',
      'workload.workloadDigest',
    );
  }
  if (canonicalStringify(value) !== canonicalStringify(expected)) {
    throw new EvidenceValidationError(
      'must equal the frozen deterministic management workload',
      'workload',
    );
  }
  return value;
}

function createItem(ordinal) {
  const padded = String(ordinal).padStart(4, '0');
  return {
    ordinal,
    logicalBookId: `logical:${digest(`${SEED}:logical:${ordinal}`)}`,
    title: `Omnia Performance Book ${padded}`,
    epub: createVariant(ordinal, padded, 'epub'),
    pdf: createVariant(ordinal, padded, 'pdf'),
    historyDepth: ordinal < LOGICAL_CHANGE_HISTORY ? 1 : 0,
  };
}

function createVariant(ordinal, padded, format) {
  const mediaType =
    format === 'epub' ? 'application/epub+zip' : 'application/pdf';
  const contentSeed = `${SEED}:${ordinal}:${format}`;
  return {
    variantKey: `variant:${digest(contentSeed)}`,
    format,
    fileName: `omnia-performance-${padded}.${format}`,
    mediaType,
    contentSeed,
  };
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
