import {
  githubAdapterFromEnvironment,
  githubWebhookFromEnvironment,
  megaAdapterFromEnvironment,
} from './configuration.js';
import { MemoryGitHubAuthorizationRevocationStore } from './github-authorization-revocations.js';
import { GitHubSyncGatewayAdapter } from './github-adapter.js';
import { MegaSyncGatewayAdapter } from './mega-adapter.js';
import { UnconfiguredSyncGatewayAdapter } from './unconfigured-adapter.js';

describe('githubAdapterFromEnvironment', () => {
  it('refuses an implicit process-local session store in production', () => {
    expect(() =>
      githubAdapterFromEnvironment({
        ...environment(),
        NODE_ENV: 'production',
      }),
    ).toThrow('production session store is unavailable');
  });

  it('fails closed when GitHub synchronization is not configured', () => {
    expect(githubAdapterFromEnvironment({})).toBeInstanceOf(
      UnconfiguredSyncGatewayAdapter,
    );
    expect(
      githubAdapterFromEnvironment({
        OMNIA_SYNC_SESSION_KEY: Buffer.alloc(32, 7).toString('base64'),
      }),
    ).toBeInstanceOf(UnconfiguredSyncGatewayAdapter);
  });

  it('rejects partial or insecure provider configuration', () => {
    expect(() =>
      githubAdapterFromEnvironment({
        OMNIA_GITHUB_CLIENT_ID: 'client',
      }),
    ).toThrow('GitHub synchronization configuration is incomplete');

    expect(() =>
      githubAdapterFromEnvironment(
        environment({ OMNIA_GITHUB_CALLBACK_URL: 'http://reader.example/cb' }),
      ),
    ).toThrow('callback URL must use HTTPS');

    expect(() =>
      githubAdapterFromEnvironment(
        environment({
          OMNIA_GITHUB_INSTALLATION_URL:
            'http://github.example/apps/omnia-reader/installations/new',
        }),
      ),
    ).toThrow('installation URL must use HTTPS');

    expect(() =>
      githubAdapterFromEnvironment(
        environment({ OMNIA_GITHUB_REQUEST_TIMEOUT_MS: '999' }),
      ),
    ).toThrow('OMNIA_GITHUB_REQUEST_TIMEOUT_MS is invalid');
    expect(() =>
      githubAdapterFromEnvironment(
        environment({ OMNIA_GITHUB_TRANSFER_TIMEOUT_MS: 'not-a-duration' }),
      ),
    ).toThrow('OMNIA_GITHUB_TRANSFER_TIMEOUT_MS is invalid');
  });

  it('constructs the live adapter only from a complete configuration', () => {
    expect(
      githubAdapterFromEnvironment(
        environment({
          OMNIA_GITHUB_REQUEST_TIMEOUT_MS: '60000',
          OMNIA_GITHUB_TRANSFER_TIMEOUT_MS: '21600000',
        }),
      ),
    ).toBeInstanceOf(GitHubSyncGatewayAdapter);
  });
});

describe('githubWebhookFromEnvironment', () => {
  it('keeps the webhook optional', () => {
    expect(
      githubWebhookFromEnvironment(environment(), undefined),
    ).toBeUndefined();
  });

  it('requires complete GitHub configuration and a shared revocation store', () => {
    const revocations = new MemoryGitHubAuthorizationRevocationStore();

    expect(() =>
      githubWebhookFromEnvironment(
        {
          OMNIA_GITHUB_WEBHOOK_SECRET: 'w'.repeat(32),
          OMNIA_GITHUB_CLIENT_ID: 'client',
        },
        revocations,
      ),
    ).toThrow('GitHub webhook configuration requires complete');
    expect(() =>
      githubWebhookFromEnvironment(
        environment({ OMNIA_GITHUB_WEBHOOK_SECRET: 'w'.repeat(32) }),
        undefined,
      ),
    ).toThrow('GitHub webhook configuration requires complete');
  });

  it('rejects a low-entropy or oversized webhook secret', () => {
    const revocations = new MemoryGitHubAuthorizationRevocationStore();

    expect(() =>
      githubWebhookFromEnvironment(
        environment({ OMNIA_GITHUB_WEBHOOK_SECRET: 'too-short' }),
        revocations,
      ),
    ).toThrow('GitHub webhook secret is invalid');
    expect(() =>
      githubWebhookFromEnvironment(
        environment({ OMNIA_GITHUB_WEBHOOK_SECRET: 'w'.repeat(1025) }),
        revocations,
      ),
    ).toThrow('GitHub webhook secret is invalid');
  });

  it('constructs the webhook from a strong secret and shared store', () => {
    const revocations = new MemoryGitHubAuthorizationRevocationStore();
    const webhook = githubWebhookFromEnvironment(
      environment({ OMNIA_GITHUB_WEBHOOK_SECRET: 'w'.repeat(32) }),
      revocations,
    );

    expect(webhook).toEqual({
      secret: 'w'.repeat(32),
      revocations,
    });
  });
});

describe('megaAdapterFromEnvironment', () => {
  it('refuses an implicit process-local session store in production', () => {
    expect(() =>
      megaAdapterFromEnvironment({
        ...megaEnvironment(),
        NODE_ENV: 'production',
      }),
    ).toThrow('production session store is unavailable');
  });

  it('fails closed when MEGA synchronization is not configured', () => {
    expect(megaAdapterFromEnvironment({})).toBeInstanceOf(
      UnconfiguredSyncGatewayAdapter,
    );
    expect(
      megaAdapterFromEnvironment({
        OMNIA_SYNC_SESSION_KEY: Buffer.alloc(32, 7).toString('base64'),
      }),
    ).toBeInstanceOf(UnconfiguredSyncGatewayAdapter);
  });

  it('rejects partial or insecure bridge configuration', () => {
    expect(() =>
      megaAdapterFromEnvironment({
        OMNIA_MEGA_SDK_BRIDGE_URL: 'https://bridge.example',
      }),
    ).toThrow('MEGA synchronization configuration is incomplete');

    expect(() =>
      megaAdapterFromEnvironment(
        megaEnvironment({
          OMNIA_MEGA_SDK_BRIDGE_URL: 'http://bridge.example',
        }),
      ),
    ).toThrow('bridge URL must use HTTPS or loopback HTTP');

    expect(() =>
      megaAdapterFromEnvironment(
        megaEnvironment({
          OMNIA_MEGA_LOGIN_URL:
            'http://reader.example/api/sync/mega/auth/login',
        }),
      ),
    ).toThrow('login URL must use HTTPS');
  });

  it('constructs the official-SDK adapter from complete configuration', () => {
    expect(megaAdapterFromEnvironment(megaEnvironment())).toBeInstanceOf(
      MegaSyncGatewayAdapter,
    );
  });
});

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OMNIA_GITHUB_APP_ID: '1234',
    OMNIA_GITHUB_CLIENT_ID: 'client',
    OMNIA_GITHUB_CLIENT_SECRET: 'secret',
    OMNIA_GITHUB_PRIVATE_KEY: 'private-key',
    OMNIA_GITHUB_CALLBACK_URL:
      'https://reader.example/api/sync/github/auth/callback',
    OMNIA_GITHUB_INSTALLATION_URL:
      'https://github.com/apps/omnia-reader/installations/new',
    OMNIA_SYNC_SESSION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ...overrides,
  };
}

function megaEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OMNIA_MEGA_SDK_BRIDGE_URL: 'https://mega-bridge.example',
    OMNIA_MEGA_SDK_BRIDGE_TOKEN: 'bridge-token',
    OMNIA_MEGA_LOGIN_URL: 'https://reader.example/api/sync/mega/auth/login',
    OMNIA_SYNC_SESSION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ...overrides,
  };
}
