import {
  LogicalBookFormatPreference,
  LogicalBookRecord,
  MembershipReconciliation,
} from '@omnia-reader/reader/domain';

export const LOGICAL_CHECKPOINT_CHANGE_INTERVAL = 500;
export const LOGICAL_CHECKPOINT_PAGE_SIZE = 100;
export const LOGICAL_CHECKPOINT_MAX_RECORDS = 20_000;

export interface LogicalBookCheckpointPage {
  schemaVersion: 1;
  checkpointId: string;
  page: number;
  books: LogicalBookRecord[];
  preferences: LogicalBookFormatPreference[];
  reconciliations: MembershipReconciliation[];
}

export interface LogicalBookCheckpointPageDescriptor {
  page: number;
  path: string;
  size: number;
  sha256: string;
}

export interface LogicalBookCheckpointIndex {
  schemaVersion: 1;
  checkpointId: string;
  includedHeads: string[];
  includedChangeIds: string[];
  pages: LogicalBookCheckpointPageDescriptor[];
  createdAt: string;
}

export interface PreparedLogicalBookCheckpoint {
  index: LogicalBookCheckpointIndex;
  pages: Array<{
    descriptor: LogicalBookCheckpointPageDescriptor;
    content: string;
  }>;
}

export async function createLogicalBookCheckpoint(input: {
  checkpointId: string;
  heads: readonly string[];
  changeIds: readonly string[];
  books: readonly LogicalBookRecord[];
  preferences: readonly LogicalBookFormatPreference[];
  reconciliations: readonly MembershipReconciliation[];
  createdAt: string;
}): Promise<PreparedLogicalBookCheckpoint> {
  const recordCount =
    input.books.length +
    input.preferences.length +
    input.reconciliations.length;
  if (recordCount > LOGICAL_CHECKPOINT_MAX_RECORDS) {
    throw new Error(
      'Logical checkpoint exceeds the safe local compaction bound',
    );
  }
  const pageCount = Math.max(
    1,
    Math.ceil(input.books.length / LOGICAL_CHECKPOINT_PAGE_SIZE),
  );
  const pages: PreparedLogicalBookCheckpoint['pages'] = [];
  for (let page = 0; page < pageCount; page += 1) {
    const value: LogicalBookCheckpointPage = {
      schemaVersion: 1,
      checkpointId: input.checkpointId,
      page,
      books: [...input.books]
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(
          page * LOGICAL_CHECKPOINT_PAGE_SIZE,
          (page + 1) * LOGICAL_CHECKPOINT_PAGE_SIZE,
        ),
      preferences:
        page === 0
          ? [...input.preferences].sort((left, right) =>
              left.logicalBookId.localeCompare(right.logicalBookId),
            )
          : [],
      reconciliations:
        page === 0
          ? [...input.reconciliations].sort((left, right) =>
              left.conflictId.localeCompare(right.conflictId),
            )
          : [],
    };
    const content = `${JSON.stringify(value, null, 2)}\n`;
    const bytes = new TextEncoder().encode(content);
    const descriptor = {
      page,
      path: `.omnia-reader/v1/logical-books/checkpoints/${encodeURIComponent(
        input.checkpointId,
      )}/page-${String(page).padStart(4, '0')}.json`,
      size: bytes.byteLength,
      sha256: await sha256(bytes),
    };
    pages.push({ descriptor, content });
  }
  return {
    pages,
    index: {
      schemaVersion: 1,
      checkpointId: input.checkpointId,
      includedHeads: [...new Set(input.heads)].sort(),
      includedChangeIds: [...new Set(input.changeIds)].sort(),
      pages: pages.map((page) => page.descriptor),
      createdAt: input.createdAt,
    },
  };
}

export function shouldCreateLogicalBookCheckpoint(
  changeCount: number,
): boolean {
  return changeCount >= LOGICAL_CHECKPOINT_CHANGE_INTERVAL;
}

export async function verifyLogicalBookCheckpointPage(
  descriptor: LogicalBookCheckpointPageDescriptor,
  content: string,
): Promise<LogicalBookCheckpointPage> {
  const bytes = new TextEncoder().encode(content);
  if (
    bytes.byteLength !== descriptor.size ||
    (await sha256(bytes)) !== descriptor.sha256
  ) {
    throw new Error('Logical checkpoint page failed integrity validation');
  }
  const value = JSON.parse(content) as LogicalBookCheckpointPage;
  if (
    value.schemaVersion !== 1 ||
    value.page !== descriptor.page ||
    !Array.isArray(value.books) ||
    !Array.isArray(value.preferences) ||
    !Array.isArray(value.reconciliations)
  ) {
    throw new Error('Logical checkpoint page failed schema validation');
  }
  return value;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
