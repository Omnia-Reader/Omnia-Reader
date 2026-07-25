import {
  githubAdapterFromEnvironment,
  megaAdapterFromEnvironment,
} from './configuration.js';
import { GitHubSyncGatewayAdapter } from './github-adapter.js';
import { MegaSyncGatewayAdapter } from './mega-adapter.js';
import { UnconfiguredSyncGatewayAdapter } from './unconfigured-adapter.js';

describe('githubAdapterFromEnvironment', () => {
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
  });

  it('constructs the live adapter only from a complete configuration', () => {
    expect(githubAdapterFromEnvironment(environment())).toBeInstanceOf(
      GitHubSyncGatewayAdapter,
    );
  });
});

describe('megaAdapterFromEnvironment', () => {
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
