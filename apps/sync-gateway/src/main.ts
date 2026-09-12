import { buildSyncGateway } from './app.js';
import {
  githubAdapterFromEnvironment,
  githubWebhookFromEnvironment,
  megaAdapterFromEnvironment,
} from './configuration.js';
import { gatewaySessionStoresFromEnvironment } from './shared-session-stores.js';

const port = environmentPort(process.env['PORT']);
const host = process.env['HOST'] ?? '127.0.0.1';

void start();

async function start(): Promise<void> {
  let stores:
    | Awaited<ReturnType<typeof gatewaySessionStoresFromEnvironment>>
    | undefined;
  try {
    stores = await gatewaySessionStoresFromEnvironment(process.env, {
      onRedisError: () => {
        console.error(
          'The shared synchronization session store reported an error',
        );
      },
    });
    const activeStores = stores;
    const githubWebhook = githubWebhookFromEnvironment(
      process.env,
      activeStores.githubRevocations,
    );
    const app = buildSyncGateway({
      github: githubAdapterFromEnvironment(process.env, {
        ...(activeStores.github ? { sessions: activeStores.github } : {}),
        ...(activeStores.githubRevocations
          ? { revocations: activeStores.githubRevocations }
          : {}),
        onUserTokenRevocationFailure: () => {
          console.error(
            'The GitHub user token could not be revoked remotely; the local session was removed',
          );
        },
      }),
      mega: megaAdapterFromEnvironment(process.env, {
        ...(activeStores.mega ? { sessions: activeStores.mega } : {}),
      }),
      ...(githubWebhook ? { githubWebhook } : {}),
      readiness: () => activeStores.ready(),
      logger: true,
      secureCookies: process.env['NODE_ENV'] === 'production',
    });
    let closing = false;
    const shutdown = async () => {
      if (closing) {
        return;
      }
      closing = true;
      await app.close();
      await activeStores.close();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
    await app.listen({ port, host });
  } catch (error) {
    await stores?.close();
    console.error(
      error instanceof Error
        ? `Synchronization gateway failed to start: ${error.message}`
        : 'Synchronization gateway failed to start',
    );
    process.exitCode = 1;
  }
}

function environmentPort(value: string | undefined): number {
  if (!value) {
    return 3333;
  }
  const port = Number(value);
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : 3333;
}
