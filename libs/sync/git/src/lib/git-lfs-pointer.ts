export const GIT_LFS_VERSION = 'https://git-lfs.github.com/spec/v1';

export interface GitLfsPointer {
  version: typeof GIT_LFS_VERSION;
  sha256: string;
  size: number;
}

export const OMNIA_GIT_ATTRIBUTES = [
  '.omnia-reader/v1/library/**/*.epub filter=lfs diff=lfs merge=lfs -text',
  '.omnia-reader/v1/library/**/*.pdf filter=lfs diff=lfs merge=lfs -text',
  '',
].join('\n');

export function serializeGitLfsPointer(sha256: string, size: number): string {
  if (!isSha256(sha256) || !Number.isSafeInteger(size) || size < 0) {
    throw new TypeError('A valid SHA-256 digest and byte length are required');
  }
  return [
    `version ${GIT_LFS_VERSION}`,
    `oid sha256:${sha256}`,
    `size ${size}`,
    '',
  ].join('\n');
}

export function parseGitLfsPointer(value: string): GitLfsPointer | null {
  if (
    new TextEncoder().encode(value).byteLength >= 1024 ||
    value.includes('\r') ||
    !value.endsWith('\n')
  ) {
    return null;
  }
  const lines = value.slice(0, -1).split('\n');
  if (lines.length !== 3) {
    return null;
  }
  const version = lines[0];
  const oid = lines[1];
  const sizeLine = lines[2];
  if (
    version !== `version ${GIT_LFS_VERSION}` ||
    !oid?.startsWith('oid sha256:') ||
    !sizeLine?.startsWith('size ')
  ) {
    return null;
  }
  const sha256 = oid.slice('oid sha256:'.length);
  const sizeValue = sizeLine.slice('size '.length);
  if (!isSha256(sha256) || !/^(0|[1-9][0-9]*)$/.test(sizeValue)) {
    return null;
  }
  const size = Number(sizeValue);
  if (!Number.isSafeInteger(size)) {
    return null;
  }
  return { version: GIT_LFS_VERSION, sha256, size };
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
