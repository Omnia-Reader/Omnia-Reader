import { expect, test } from '@playwright/test';
import { isExpectedSandboxEnforcementMessage } from './browser-failure-helpers';

test('accepts only Chromium script-blocking diagnostics from scriptless publication sandboxes', () => {
  expect(
    isExpectedSandboxEnforcementMessage(
      "Blocked script execution in 'blob:http://localhost:4200/publication' because the document's frame is sandboxed and the 'allow-scripts' permission is not set.",
    ),
  ).toBe(true);
  expect(
    isExpectedSandboxEnforcementMessage(
      "Blocked script execution in 'blob:http://localhost:4200/publication' because the document's frame is sandboxed.",
    ),
  ).toBe(false);
  expect(
    isExpectedSandboxEnforcementMessage(
      'Uncaught TypeError: Blocked script execution in publication renderer',
    ),
  ).toBe(false);
});
