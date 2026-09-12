import { MegaGatewayError } from '@omnia-reader/sync/mega';
import { vi } from 'vitest';
import {
  NativeGitHubGateway,
  NativeMegaGateway,
  NativeSyncListen,
} from './native-sync-gateways';
import { NativeSyncCommand, NativeSyncInvoke } from './native-sync-transport';

const REQUEST_ID = 'native-request-1234';
const BROKER_STATUS = {
  gatewayOrigin: 'https://sync.test',
  persistenceMode: 'session-only' as const,
  persistenceVersion: null,
  restartRequiresReauthentication: true as const,
};
const REPOSITORY = {
  id: 7,
  fullName: 'reader/library',
  private: true,
  defaultBranch: 'main',
  canPush: true,
};
const GITHUB_SESSION = {
  configured: true,
  authenticated: true,
  installationUrl: 'https://github.test/apps/omnia-reader',
  user: {
    id: 42,
    login: 'reader',
    avatarUrl: 'https://avatars.test/reader.png',
  },
  repository: REPOSITORY,
};
const FOLDER = {
  handle: 'folder-1',
  name: 'Omnia Reader',
  path: '/Omnia Reader',
  canWrite: true,
};

describe('native provider gateways', () => {
  it('uses only typed GitHub Settings commands and validates their results', async () => {
    const invoke = nativeInvoke({
      sync_github_session: GITHUB_SESSION,
      sync_github_repositories: [REPOSITORY],
      sync_github_select_repository: GITHUB_SESSION,
      sync_github_create_repository: {
        repository: REPOSITORY,
        selected: true,
        session: GITHUB_SESSION,
        installationSettingsUrl: null,
      },
      sync_github_disconnect: undefined,
    });
    const gateway = new NativeGitHubGateway({ invoke });

    await expect(gateway.session()).resolves.toEqual(GITHUB_SESSION);
    await expect(gateway.repositories()).resolves.toEqual([REPOSITORY]);
    await expect(gateway.selectRepository(7)).resolves.toEqual(GITHUB_SESSION);
    await expect(gateway.createRepository(' library ')).resolves.toMatchObject({
      repository: REPOSITORY,
      selected: true,
    });
    await expect(gateway.disconnect()).resolves.toBeUndefined();

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'sync_github_session',
      'sync_github_repositories',
      'sync_github_select_repository',
      'sync_github_create_repository',
      'sync_github_disconnect',
    ]);
    expect(invoke.mock.calls[2]?.[1]).toEqual({
      requestId: 'settings-3',
      repositoryId: 7,
    });
    expect(invoke.mock.calls[3]?.[1]).toEqual({
      requestId: 'settings-4',
      name: 'library',
    });
    expect(
      invoke.mock.calls.some(
        ([, body]) => !(body instanceof Uint8Array) && 'url' in body,
      ),
    ).toBe(false);
  });

  it('uses only typed MEGA Settings commands and rejects malformed IPC', async () => {
    const invoke = nativeInvoke({
      sync_mega_session: {
        authenticated: true,
        account: 'reader@example.test',
        folder: FOLDER,
      },
      sync_mega_folders: [FOLDER],
      sync_mega_select_folder: {
        authenticated: true,
        account: 'reader@example.test',
        folder: FOLDER,
      },
      sync_mega_disconnect: undefined,
    });
    const gateway = new NativeMegaGateway({ invoke });

    await expect(gateway.session()).resolves.toMatchObject({
      authenticated: true,
      folder: FOLDER,
    });
    await expect(gateway.folders()).resolves.toEqual([FOLDER]);
    await expect(gateway.selectFolder('folder-1')).resolves.toMatchObject({
      authenticated: true,
      folder: FOLDER,
    });
    await expect(gateway.disconnect()).resolves.toBeUndefined();
    expect(invoke.mock.calls[2]?.[1]).toEqual({
      requestId: 'settings-3',
      handle: 'folder-1',
    });

    const malformed = new NativeMegaGateway({
      invoke: nativeInvoke({
        sync_mega_session: {
          authenticated: true,
          account: 'provider-secret-canary',
          folder: { ...FOLDER, unexpected: 'provider-secret-canary' },
        },
      }),
    });
    await expect(malformed.session()).rejects.not.toThrow(
      'provider-secret-canary',
    );
  });

  it('registers the listener before opening an exact system-browser URL', async () => {
    let callback: ((event: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn<() => void>();
    const listen = vi.fn<NativeSyncListen>(async (_event, listener) => {
      callback = listener;
      return unlisten;
    });
    const openExternal = vi.fn(async () => undefined);
    const invoke = vi.fn<NativeSyncInvoke>(async (command, body) => {
      if (command === 'sync_broker_status') {
        return BROKER_STATUS;
      }
      if (command === 'sync_authorization_begin') {
        expect(callback).toBeDefined();
        return {
          authorizationUrl: `https://sync.test/api/sync/github/native/auth/start?requestId=${String((body as Record<string, unknown>)['requestId'])}`,
        };
      }
      return undefined;
    });
    const gateway = new NativeGitHubGateway({
      invoke,
      listen,
      openExternal,
      randomId: () => REQUEST_ID,
    });

    const authorization = gateway.beginAuthorization();
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));
    callback?.({
      payload: {
        requestId: REQUEST_ID,
        provider: 'git',
        outcome: 'authorized',
      },
    });
    await expect(authorization).resolves.toBeUndefined();

    expect(openExternal).toHaveBeenCalledWith(
      `https://sync.test/api/sync/github/native/auth/start?requestId=${REQUEST_ID}`,
    );
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('sync_authorization_cancel', {
      requestId: REQUEST_ID,
    });
  });

  it('rejects an authorization URL from a different origin before opening it', async () => {
    const openExternal = vi.fn(async () => undefined);
    const gateway = new NativeGitHubGateway({
      invoke: vi.fn<NativeSyncInvoke>(async (command, body) =>
        command === 'sync_broker_status'
          ? BROKER_STATUS
          : command === 'sync_authorization_begin'
            ? {
                authorizationUrl: `https://attacker.invalid/api/sync/github/native/auth/start?requestId=${String((body as Record<string, unknown>)['requestId'])}`,
              }
            : undefined,
      ),
      listen: vi.fn<NativeSyncListen>(async () => () => undefined),
      openExternal,
      randomId: () => REQUEST_ID,
    });

    await expect(gateway.beginAuthorization()).rejects.toMatchObject({
      status: 502,
      message: 'The synchronization service returned an invalid response.',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('cancels a pending authorization and sanitizes native failures', async () => {
    let callback: ((event: { payload: unknown }) => void) | undefined;
    const listen = vi.fn<NativeSyncListen>(async (_event, listener) => {
      callback = listener;
      return () => undefined;
    });
    const invoke = vi.fn<NativeSyncInvoke>(async (command, body) =>
      command === 'sync_broker_status'
        ? BROKER_STATUS
        : command === 'sync_authorization_begin'
          ? {
              authorizationUrl: `https://sync.test/api/sync/mega/native/auth/start?requestId=${String((body as Record<string, unknown>)['requestId'])}`,
            }
          : undefined,
    );
    const gateway = new NativeMegaGateway({
      invoke,
      listen,
      openExternal: vi.fn(async () => undefined),
      randomId: () => REQUEST_ID,
    });

    const authorization = gateway.beginAuthorization();
    const rejected =
      expect(authorization).rejects.toBeInstanceOf(MegaGatewayError);
    await vi.waitFor(() => expect(callback).toBeDefined());
    await gateway.cancelAuthorization();
    await rejected;
    expect(invoke).toHaveBeenCalledWith('sync_authorization_cancel', {
      requestId: REQUEST_ID,
    });

    const failed = new NativeGitHubGateway({
      invoke: vi.fn<NativeSyncInvoke>(async () => {
        throw { code: 'transport-unavailable', message: 'secret-canary' };
      }),
      listen: vi.fn<NativeSyncListen>(async () => () => undefined),
      openExternal: vi.fn(async () => undefined),
      randomId: () => REQUEST_ID,
    });
    await expect(failed.beginAuthorization()).rejects.toMatchObject({
      status: 503,
      message: 'The native synchronization service is unavailable.',
    });
    await expect(failed.beginAuthorization()).rejects.not.toThrow(
      'secret-canary',
    );
  });
});

function nativeInvoke(
  responses: Partial<Record<NativeSyncCommand, unknown>>,
): ReturnType<typeof vi.fn<NativeSyncInvoke>> {
  return vi.fn<NativeSyncInvoke>(async (command) => responses[command]);
}
