import assert from 'node:assert/strict';
import test from 'node:test';

import { validateLicenses } from './verify-release.mjs';

const reviewedRustDependencyExpressions = [
  'Apache-2.0 AND ISC',
  'Apache-2.0 OR ISC OR MIT',
  'BSD-2-Clause OR Apache-2.0 OR MIT',
  'CDLA-Permissive-2.0',
  'ISC AND (Apache-2.0 OR ISC)',
  'ISC AND (Apache-2.0 OR ISC) AND Apache-2.0 AND MIT AND BSD-3-Clause AND (Apache-2.0 OR ISC OR MIT) AND (Apache-2.0 OR ISC OR MIT-0)',
];

test('accepts only the reviewed Rust dependency license expressions', () => {
  assert.doesNotThrow(() =>
    validateLicenses(
      reviewedRustDependencyExpressions.map((expression, index) => ({
        name: `reviewed-rust-dependency-${index}`,
        expressions: [expression],
      })),
      'Rust dependency review fixture',
    ),
  );

  assert.throws(
    () =>
      validateLicenses(
        [
          {
            name: 'unreviewed-rust-dependency',
            expressions: ['Apache-2.0 OR ISC OR MIT OR GPL-3.0-only'],
          },
        ],
        'Rust dependency review fixture',
      ),
    /unreviewed dependency licenses/,
  );
});
