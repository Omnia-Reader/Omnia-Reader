import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const lock = JSON.parse(
  await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'),
);

function versionAtLeast(actual, minimum) {
  const left = actual.split('.').map(Number);
  const right = minimum.split('.').map(Number);
  return right.every(
    (part, index) =>
      (left[index] ?? 0) >= part ||
      left.slice(0, index).some((value, earlier) => value > right[earlier]),
  );
}

test('locks PDF.js outside the malicious-document execution range', () => {
  const pdf = lock.packages['node_modules/pdfjs-dist'];
  assert.ok(pdf, 'pdfjs-dist must be locked');
  assert.equal(
    versionAtLeast(pdf.version, '6.2.108'),
    true,
    `pdfjs-dist ${pdf.version} is affected by GHSA-hq66-cqwq-w95j`,
  );
  assert.match(pdf.integrity ?? '', /^sha512-/);
});

test('locks every fast-uri line outside host-confusion ranges', () => {
  const resolutions = Object.entries(lock.packages)
    .filter(([path]) => path.endsWith('node_modules/fast-uri'))
    .map(([path, value]) => ({ path, version: value.version }));
  assert.ok(resolutions.length >= 2, 'expected both fast-uri major lines');

  for (const resolution of resolutions) {
    const major = Number(resolution.version.split('.')[0]);
    const minimum = major === 3 ? '3.1.5' : major === 4 ? '4.1.2' : null;
    assert.ok(minimum, `unreviewed fast-uri major at ${resolution.path}`);
    assert.equal(
      versionAtLeast(resolution.version, minimum),
      true,
      `${resolution.path} resolves vulnerable fast-uri ${resolution.version}`,
    );
  }
});
