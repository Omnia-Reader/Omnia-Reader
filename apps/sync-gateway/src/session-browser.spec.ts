import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';
import { buildSyncGateway } from './app.js';
import type { SyncGatewayAdapter } from './gateway-contract.js';
import { EncryptedFileSessionStore } from './session-store.js';
import { UnconfiguredSyncGatewayAdapter } from './unconfigured-adapter.js';

describe.skipIf(process.env['OMNIA_SESSION_BROWSER_TEST'] !== '1')(
  'persistent authorization cookie',
  () => {
    for (const browserType of [chromium, firefox, webkit]) {
      it(`${browserType.name()} restores authorization after browser and store restart`, async () => {
        const directory = await mkdtemp(
          join(tmpdir(), 'omnia-session-browser-'),
        );
        const filePath = join(directory, 'sessions.json');
        const key = Buffer.alloc(32, 7);
        let now = Date.now();
        let store = new EncryptedFileSessionStore(key, {
          filePath,
          now: () => now,
        });
        const state = { authenticated: true, repository: { id: 42 } };
        let firstConnection = true;
        const github: SyncGatewayAdapter = new UnconfiguredSyncGatewayAdapter(
          'github',
        );
        // One initial connection only: a missing restored record must fail.
        github.session = async (sessionId: string) => {
          if (firstConnection) {
            firstConnection = false;
            await store.set(sessionId, state);
          }
          return (await store.get(sessionId)) ?? { authenticated: false };
        };
        const app = buildSyncGateway({
          github,
          mega: new UnconfiguredSyncGatewayAdapter('mega'),
          secureCookies: false,
        });
        let context:
          | Awaited<ReturnType<typeof chromium.launchPersistentContext>>
          | undefined;
        try {
          const origin = await app.listen({ host: '127.0.0.1', port: 0 });
          const profile = join(directory, 'profile');
          context = await browserType.launchPersistentContext(profile, {
            headless: true,
          });
          const page = await context.newPage();
          await page.goto(`${origin}/api/sync/github/session`);
          expect(JSON.parse(await page.locator('body').innerText())).toEqual(
            state,
          );
          const original = (await context.cookies())[0];
          expect(original.httpOnly).toBe(true);
          expect(original.expires).toBeGreaterThan(
            Date.now() / 1000 + 29 * 86400,
          );
          await context.close();
          context = undefined;
          now += 24 * 60 * 60 * 1000;
          store = new EncryptedFileSessionStore(key, {
            filePath,
            now: () => now,
          });
          context = await browserType.launchPersistentContext(profile, {
            headless: true,
          });
          const reopened = await context.newPage();
          await reopened.goto(`${origin}/api/sync/github/session`);
          expect(
            JSON.parse(await reopened.locator('body').innerText()),
          ).toEqual(state);
          expect((await context.cookies())[0].value).toBe(original.value);
          expect(await reopened.evaluate('document.cookie')).toBe('');
        } finally {
          await context?.close();
          await app.close();
          await rm(directory, { recursive: true, force: true });
        }
      }, 30000);
    }
  },
);
