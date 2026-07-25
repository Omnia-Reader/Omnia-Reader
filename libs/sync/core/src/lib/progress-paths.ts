import { ReadingProgress } from '@omnia-reader/reader/domain';
import { SYNC_ROOT } from './library-sync-manifest';

export const PROGRESS_ROOT = `${SYNC_ROOT}/progress`;

export function progressDocumentPath(
  progress: Pick<ReadingProgress, 'bookId' | 'deviceId'>,
): string {
  return `${PROGRESS_ROOT}/${encodePathSegment(
    progress.bookId,
  )}/${encodePathSegment(progress.deviceId)}.json`;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%2F/g, '%252F');
}
