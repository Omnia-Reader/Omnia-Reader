import assert from 'node:assert/strict';
import test from 'node:test';

import { validateLicenses } from './verify-release.mjs';

const reviewedRustTlsExpressions = [
  'Apache-2.0 AND ISC',
  'Apache-2.0 OR ISC OR MIT',
  'CDLA-Permissive-2.0',
  'ISC AND (Apache-2.0 OR ISC)',
  'ISC AND (Apache-2.0 OR ISC) AND Apache-2.0 AND MIT AND BSD-3-Clause AND (Apache-2.0 OR ISC OR MIT) AND (Apache-2.0 OR ISC OR MIT-0)',
];

test('accepts only the reviewed Rust TLS license expressions', () => {
  assert.doesNotThrow(() =>
    validateLicenses(
      reviewedRustTlsExpressions.map((expression, index) => ({
        name: `reviewed-rust-tls-${index}`,
        expressions: [expression],
      })),
      'Rust TLS review fixture',
    ),
  );

  assert.throws(
    () =>
      validateLicenses(
        [
          {
            name: 'unreviewed-rust-tls',
            expressions: ['Apache-2.0 OR ISC OR MIT OR GPL-3.0-only'],
          },
        ],
        'Rust TLS review fixture',
      ),
    /unreviewed dependency licenses/,
  );
});
