import { expect, test } from '@playwright/test';

test('serves the application shell with the production security policy', async ({
  request,
}) => {
  const response = await request.get('/');
  expect(response.ok()).toBe(true);

  const headers = response.headers();
  expect(headers['content-security-policy']).toContain("object-src 'none'");
  expect(headers['content-security-policy']).toContain("form-action 'none'");
  expect(headers['content-security-policy']).toContain(
    "frame-ancestors 'none'",
  );
  expect(headers['content-security-policy']).toContain(
    "img-src 'self' data: blob: https://avatars.githubusercontent.com",
  );
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(headers['permissions-policy']).toContain('camera=()');
  expect(headers['permissions-policy']).toContain('microphone=()');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');

  const readerLinkTarget = await request.get('/reader-link-target.html');
  expect(readerLinkTarget.ok()).toBe(true);
  const readerLinkHeaders = readerLinkTarget.headers();
  expect(readerLinkHeaders['content-security-policy']).not.toContain(
    'frame-ancestors',
  );
  expect(readerLinkHeaders['x-frame-options']).toBeUndefined();
});
