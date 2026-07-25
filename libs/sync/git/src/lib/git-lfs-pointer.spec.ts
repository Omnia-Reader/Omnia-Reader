import { describe, expect, it } from 'vitest';
import {
  GIT_LFS_VERSION,
  OMNIA_GIT_ATTRIBUTES,
  parseGitLfsPointer,
  serializeGitLfsPointer,
} from './git-lfs-pointer';

describe('Git LFS pointer', () => {
  const sha256 =
    '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393';

  it('writes the canonical v1 pointer format', () => {
    const pointer = serializeGitLfsPointer(sha256, 12345);

    expect(pointer).toBe(
      `version ${GIT_LFS_VERSION}\n` +
        `oid sha256:${sha256}\n` +
        'size 12345\n',
    );
    expect(parseGitLfsPointer(pointer)).toEqual({
      version: GIT_LFS_VERSION,
      sha256,
      size: 12345,
    });
  });

  it.each([
    'version https://example.test/spec/v1\noid sha256:a\nsize 1\n',
    `version ${GIT_LFS_VERSION}\r\noid sha256:${sha256}\r\nsize 1\r\n`,
    `version ${GIT_LFS_VERSION}\nsize 1\noid sha256:${sha256}\n`,
    `version ${GIT_LFS_VERSION}\noid sha256:${sha256}\nsize 01\n`,
    `version ${GIT_LFS_VERSION}\noid sha256:${sha256}\nsize 1`,
  ])('rejects a non-canonical pointer', (pointer) => {
    expect(parseGitLfsPointer(pointer)).toBeNull();
  });

  it('provides LFS tracking rules only for synchronized publications', () => {
    expect(OMNIA_GIT_ATTRIBUTES).toContain(
      '.omnia-reader/v1/books/**/*.epub filter=lfs',
    );
    expect(OMNIA_GIT_ATTRIBUTES).toContain(
      '.omnia-reader/v1/books/**/*.pdf filter=lfs',
    );
    expect(OMNIA_GIT_ATTRIBUTES).not.toContain('*.json');
  });
});
