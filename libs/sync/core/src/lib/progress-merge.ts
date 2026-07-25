import {
  isReadingProgress,
  ReadingProgress,
} from '@omnia-reader/reader/domain';

export interface ProgressMergeResult {
  current: ReadingProgress | null;
  furthestTotalProgression: number;
  documents: readonly ReadingProgress[];
}

export function mergeDeviceProgress(
  documents: readonly ReadingProgress[],
): ProgressMergeResult {
  const valid = documents.filter(isReadingProgress);
  const current =
    [...valid].sort((left, right) => {
      const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
      return byUpdatedAt || right.deviceId.localeCompare(left.deviceId);
    })[0] ?? null;

  return {
    current,
    furthestTotalProgression: valid.reduce(
      (maximum, progress) =>
        Math.max(maximum, progress.furthestTotalProgression),
      0,
    ),
    documents: valid,
  };
}

export { isReadingProgress };
