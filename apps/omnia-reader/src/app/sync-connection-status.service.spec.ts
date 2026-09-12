import { TestBed } from '@angular/core/testing';
import { SYNC_PROVIDER_SELECTION } from '@omnia-reader/sync/core';
import { GITHUB_GATEWAY, GitHubGatewayError } from '@omnia-reader/sync/git';
import { MEGA_GATEWAY } from '@omnia-reader/sync/mega';
import { SyncConnectionStatusService } from './sync-connection-status.service';

describe('SyncConnectionStatusService', () => {
  let provider: 'git' | 'mega' | null;
  let providerListener: (() => void) | null;
  const git = { session: vi.fn(), repositories: vi.fn() };
  const mega = { session: vi.fn() };

  beforeEach(() => {
    provider = 'git';
    providerListener = null;
    git.session.mockReset();
    git.repositories.mockReset().mockResolvedValue([]);
    mega.session.mockReset();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SYNC_PROVIDER_SELECTION,
          useValue: {
            current: () => provider,
            subscribe: (listener: () => void) => {
              providerListener = listener;
              return () => undefined;
            },
          },
        },
        { provide: GITHUB_GATEWAY, useValue: git },
        { provide: MEGA_GATEWAY, useValue: mega },
      ],
    });
  });

  it('distinguishes authorization, destination, and ready GitHub states', async () => {
    git.session.mockResolvedValueOnce({
      configured: true,
      authenticated: false,
      installationUrl: 'https://github.test/install',
    });
    const service = TestBed.inject(SyncConnectionStatusService);
    await service.refresh();
    expect(service.snapshot()).toMatchObject({
      state: 'authorization-required',
      provider: 'git',
    });

    git.session.mockResolvedValueOnce({
      configured: true,
      authenticated: true,
      installationUrl: 'https://github.test/install',
      user: { id: 1, login: 'reader', avatarUrl: '' },
      repository: null,
    });
    git.repositories.mockResolvedValueOnce([]);
    await service.refresh();
    expect(service.snapshot()).toMatchObject({
      state: 'destination-required',
      accountLabel: 'reader',
    });

    git.session.mockResolvedValueOnce({
      configured: true,
      authenticated: true,
      installationUrl: 'https://github.test/install',
      user: { id: 1, login: 'reader', avatarUrl: '' },
      repository: {
        id: 11,
        fullName: 'reader/library',
        private: true,
        defaultBranch: 'main',
        canPush: true,
      },
    });
    await service.refresh();
    expect(service.snapshot()).toEqual({
      state: 'ready',
      provider: 'git',
      providerLabel: 'GitHub',
      providerMaturity: 'experimental',
      providerMaturityLabel: 'Experimental',
      providerMaturityConsequence:
        'Release validation is incomplete; keep another backup.',
      accountLabel: 'reader',
      destinationLabel: 'reader/library',
    });
  });

  it('reports local-only, provider setup, and gateway failures safely', async () => {
    provider = null;
    const service = TestBed.inject(SyncConnectionStatusService);
    await service.refresh();
    expect(service.snapshot().state).toBe('local-only');

    provider = 'git';
    git.session.mockResolvedValueOnce({
      configured: false,
      authenticated: false,
    });
    await service.refresh();
    expect(service.snapshot().state).toBe('provider-unconfigured');

    git.session.mockRejectedValueOnce(
      new GitHubGatewayError(500, 'sensitive upstream detail'),
    );
    await service.refresh();
    expect(service.snapshot()).toMatchObject({
      state: 'gateway-unavailable',
      provider: 'git',
      providerMaturity: 'experimental',
      providerMaturityLabel: 'Experimental',
    });
    expect(JSON.stringify(service.snapshot())).not.toContain('sensitive');
  });

  it('does not claim destination setup is possible when repository discovery fails', async () => {
    git.session.mockResolvedValueOnce({
      configured: true,
      authenticated: true,
      installationUrl: 'https://github.test/install',
      user: { id: 1, login: 'reader', avatarUrl: '' },
      repository: null,
    });
    git.repositories.mockRejectedValueOnce(
      new GitHubGatewayError(500, 'provider detail'),
    );
    const service = TestBed.inject(SyncConnectionStatusService);

    await service.refresh();

    expect(service.snapshot()).toMatchObject({
      state: 'gateway-unavailable',
      provider: 'git',
    });
  });

  it('discards stale refreshes and refreshes when provider selection changes', async () => {
    let resolveFirst!: (value: unknown) => void;
    git.session.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    const service = TestBed.inject(SyncConnectionStatusService);
    const first = service.refresh();

    provider = 'mega';
    mega.session.mockResolvedValueOnce({
      authenticated: true,
      account: 'reader@example.test',
      folder: {
        handle: 'folder',
        name: 'Books',
        path: '/Books',
        canWrite: true,
      },
    });
    providerListener?.();
    await vi.waitFor(() => expect(service.snapshot().state).toBe('ready'));

    resolveFirst({
      configured: true,
      authenticated: false,
      installationUrl: 'https://github.test/install',
    });
    await first;
    expect(service.snapshot()).toMatchObject({
      state: 'ready',
      provider: 'mega',
      destinationLabel: '/Books',
    });
  });

  it('coalesces overlapping inspection for the same provider', async () => {
    let resolveSession!: (value: unknown) => void;
    git.session.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );
    const service = TestBed.inject(SyncConnectionStatusService);

    const first = service.refresh();
    const second = service.refresh();

    expect(second).toBe(first);
    expect(git.session).toHaveBeenCalledOnce();
    resolveSession({
      configured: true,
      authenticated: false,
      installationUrl: 'https://github.test/install',
    });
    await first;
  });

  it('keeps maturity independent from successful history and recovery state', async () => {
    git.session.mockResolvedValueOnce({
      configured: true,
      authenticated: true,
      installationUrl: 'https://github.test/install',
      user: { id: 1, login: 'reader', avatarUrl: '' },
      repository: {
        id: 11,
        fullName: 'reader/library',
        private: true,
        defaultBranch: 'main',
        canPush: true,
      },
    });
    const service = TestBed.inject(SyncConnectionStatusService);
    await service.refresh();
    expect(service.snapshot().providerMaturityLabel).toBe('Experimental');

    git.session.mockRejectedValueOnce(
      new GitHubGatewayError(401, 'provider-secret-canary'),
    );
    await service.refresh();
    expect(service.snapshot()).toMatchObject({
      state: 'gateway-unavailable',
      providerMaturity: 'experimental',
      providerMaturityLabel: 'Experimental',
      providerMaturityConsequence:
        'Release validation is incomplete; keep another backup.',
    });
    expect(JSON.stringify(service.snapshot())).not.toContain('secret-canary');
  });
});
