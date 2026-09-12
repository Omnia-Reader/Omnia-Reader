import { expect, test } from '@playwright/test';
import {
  isExpectedPublicationSecurityConsoleMessage,
  isExpectedSandboxEnforcementMessage,
} from './browser-failure-helpers';

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

test('accepts only Firefox font failures caused by neutralized remote URLs', () => {
  expect(
    isExpectedPublicationSecurityConsoleMessage(
      '[JavaScript Error: "downloadable font: font load failed (font-family: "Remote fixture font" style:normal weight:400 stretch:100 src index:0): status=2147500037 source: data:,"]',
    ),
  ).toBe(true);
  expect(
    isExpectedPublicationSecurityConsoleMessage(
      '[JavaScript Error: "downloadable font: font load failed (font-family: "Embedded fixture font" style:normal weight:400 stretch:100 src index:0): status=2147500037 source: blob:http://localhost/font"]',
    ),
  ).toBe(false);
  expect(
    isExpectedPublicationSecurityConsoleMessage(
      'downloadable font: font load failed source: data:,',
    ),
  ).toBe(false);
});
