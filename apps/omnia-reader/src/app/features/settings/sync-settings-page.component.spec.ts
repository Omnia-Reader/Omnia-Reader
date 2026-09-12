import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideRouter, Router } from '@angular/router';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import {
  AUTO_SYNC_SCHEDULER,
  AutoSyncStatus,
  LIBRARY_SYNC_SERVICE,
  ObjectTransferProgress,
  REMOTE_BOOK_BACKUP_SERVICE,
  RemoteBookBackup,
  SYNC_PROVIDER_SELECTION,
  SyncWorkerOptions,
  SyncProviderKind,
  SyncProviderSelection,
} from '@omnia-reader/sync/core';
import {
  GITHUB_GATEWAY,
  GitHubGateway,
  GitHubGatewayError,
  SYNC_OPERATION_JOURNAL,
} from '@omnia-reader/sync/git';
import { MEGA_GATEWAY, MegaGateway } from '@omnia-reader/sync/mega';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { SyncSettingsPageComponent } from './sync-settings-page.component';

describe('SyncSettingsPageComponent', () => {
  const installationUrl =
    'https://github.test/apps/omnia-reader/installations/new';
  let selected: SyncProviderKind | null;
  let selection: SyncProviderSelection;
  let git: GitHubGateway;
  let mega: MegaGateway;
  const synchronize = vi.fn().mockResolvedValue({
    pulled: 2,
    pushed: 1,
    conflicts: 0,
    rejected: 0,
  });
  const autoSync = {
    status: vi.fn().mockReturnValue({ phase: 'idle' }),
    subscribe: vi.fn(),
    requestImmediate: vi.fn(),
    cancelActive: vi.fn(),
    recordManualSuccess: vi.fn(),
    clearHistory: vi.fn(),
  };
  const remoteBackup: RemoteBookBackup = {
    manifest: {
      schemaVersion: 2,
      bookId: 'sha256:remote-book',
      format: 'epub',
      fileName: 'remote-book.epub',
      mediaType: 'application/epub+zip',
      title: 'Remote book',
      authors: ['Reader Example'],
      size: 2048,
      sha256: 'a'.repeat(64),
      objectPath:
        '.omnia-reader/library/remote-book--aaaaaaaaaaaa/remote-book.epub',
      importedAt: '2026-07-26T12:00:00.000Z',
      updatedAt: '2026-07-26T12:00:00.000Z',
      appVersion: '1.0.0',
    },
    revision: 'revision-1',
  };
  const listRemoteBackups = vi.fn();
  const deleteRemoteBackup = vi.fn();
  const dialogOpen = vi.fn();
  const pending = vi.fn();
  const listOpenMembershipReconciliations = vi.fn();
  let autoSyncListener: ((status: AutoSyncStatus) => void) | null;

  beforeEach(async () => {
    listOpenMembershipReconciliations.mockReset().mockResolvedValue([]);
    synchronize.mockReset().mockResolvedValue({
      pulled: 2,
      pushed: 1,
      conflicts: 0,
      rejected: 0,
    });
    autoSyncListener = null;
    autoSync.status.mockReset().mockReturnValue({ phase: 'idle' });
    autoSync.subscribe
      .mockReset()
      .mockImplementation((listener: (status: AutoSyncStatus) => void) => {
        autoSyncListener = listener;
        listener({ phase: 'idle' });
        return vi.fn();
      });
    autoSync.requestImmediate.mockReset();
    autoSync.cancelActive.mockReset().mockReturnValue(true);
    autoSync.recordManualSuccess.mockReset();
    autoSync.clearHistory.mockReset();
    listRemoteBackups.mockReset().mockResolvedValue([remoteBackup]);
    deleteRemoteBackup.mockReset().mockResolvedValue(null);
    dialogOpen.mockReset().mockReturnValue({
      afterClosed: () => of(false),
    });
    pending.mockReset().mockResolvedValue([]);
    selected = 'mega';
    selection = {
      current: () => selected,
      select: vi.fn((provider: SyncProviderKind) => {
        selected = provider;
      }),
      clear: vi.fn(() => {
        selected = null;
      }),
    };
    git = gatewayStub({
      session: vi.fn().mockResolvedValue({
        configured: true,
        authenticated: false,
        installationUrl,
      }),
      repositories: vi.fn().mockResolvedValue([]),
    }) as unknown as GitHubGateway;
    mega = gatewayStub({
      session: vi.fn().mockResolvedValue({
        authenticated: true,
        account: 'reader@example.test',
        folder: {
          handle: 'folder',
          name: 'Omnia Reader',
          path: '/Omnia Reader',
          canWrite: true,
        },
      }),
      folders: vi.fn().mockResolvedValue([
        {
          handle: 'folder',
          name: 'Omnia Reader',
          path: '/Omnia Reader',
          canWrite: true,
        },
      ]),
      selectFolder: vi.fn().mockResolvedValue({
        authenticated: true,
        account: 'reader@example.test',
        folder: {
          handle: 'folder',
          name: 'Omnia Reader',
          path: '/Omnia Reader',
          canWrite: true,
        },
      }),
    }) as unknown as MegaGateway;

    await TestBed.configureTestingModule({
      imports: [SyncSettingsPageComponent],
      providers: [
        provideRouter([]),
        {
          provide: SYNC_OPERATION_JOURNAL,
          useValue: { pending },
        },
        {
          provide: LIBRARY_REPOSITORY,
          useValue: { listOpenMembershipReconciliations },
        },
        { provide: SYNC_PROVIDER_SELECTION, useValue: selection },
        { provide: GITHUB_GATEWAY, useValue: git },
        { provide: MEGA_GATEWAY, useValue: mega },
        { provide: LIBRARY_SYNC_SERVICE, useValue: { synchronize } },
        {
          provide: REMOTE_BOOK_BACKUP_SERVICE,
          useValue: {
            list: listRemoteBackups,
            deleteBackup: deleteRemoteBackup,
          },
        },
        { provide: AUTO_SYNC_SCHEDULER, useValue: autoSync },
        { provide: MatDialog, useValue: { open: dialogOpen } },
      ],
    }).compileComponents();
  });

  it('loads the selected MEGA destination and synchronizes books with progress', async () => {
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('reader@example.test');
    expect(fixture.nativeElement.textContent).toContain('/Omnia Reader');

    await fixture.componentInstance.syncNow();

    expect(synchronize).toHaveBeenCalled();
    expect(autoSync.recordManualSuccess).toHaveBeenCalledWith({
      pulled: 2,
      pushed: 1,
      conflicts: 0,
      rejected: 0,
    });
    expect(fixture.componentInstance.statusMessage).toContain('2 pulled');
  });

  it('does not relist unchanged remote backups after a fast manual sync', async () => {
    selected = 'git';
    const repository = {
      id: 7,
      fullName: 'reader/library',
      private: true,
      defaultBranch: 'main',
      canPush: true,
    };
    vi.mocked(git.session).mockResolvedValue({
      configured: true,
      authenticated: true,
      installationUrl,
      user: { id: 42, login: 'reader', avatarUrl: '' },
      repository,
    });
    vi.mocked(git.repositories).mockResolvedValue([repository]);
    synchronize.mockResolvedValueOnce({
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      rejected: 0,
      unchanged: true,
    });
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );
    expect(listRemoteBackups).toHaveBeenCalledTimes(1);

    await fixture.componentInstance.syncNow();

    expect(listRemoteBackups).toHaveBeenCalledTimes(1);
    expect(autoSync.recordManualSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ unchanged: true }),
    );
  });

  it('shows the scheduled automatic retry after provider rate limiting', async () => {
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    autoSyncListener?.({
      phase: 'scheduled',
      reason: 'startup',
      scheduledFor: '2026-07-27T12:02:00.000Z',
      errorMessage:
        'The synchronization provider is temporarily rate limiting requests. Local changes are safe and automatic synchronization will retry.',
    });
    fixture.detectChanges();

    const status = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="automatic-sync-status"]',
    );
    expect(status?.textContent).toContain('temporarily rate limiting requests');
    expect(status?.textContent).toContain('Next attempt');
    expect(status?.textContent).not.toContain(
      'will sync after reading settles',
    );
  });

  it('changes the active transport before loading another provider', async () => {
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance.chooseProvider('git');

    expect(selection.select).toHaveBeenCalledWith('git');
    expect(git.session).toHaveBeenCalled();
    expect(fixture.componentInstance.selectedProvider).toBe('git');
  });

  it('explains missing GitHub App configuration without leaving Settings', async () => {
    selected = 'git';
    vi.mocked(git.session).mockResolvedValue({
      configured: false,
      authenticated: false,
    });
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );
    fixture.detectChanges();

    const warning = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLElement>('[data-testid="github-sync-unconfigured"]');
    const connectButton = [
      ...fixture.nativeElement.querySelectorAll('button'),
    ].find((button: HTMLButtonElement) =>
      button.textContent?.includes('Connect GitHub'),
    ) as HTMLButtonElement | undefined;

    expect(warning?.textContent).toContain('GitHub App setup required');
    expect(warning?.textContent).toContain('npm run start:full');
    expect(connectButton).toBeUndefined();
    expect(git.beginAuthorization).not.toHaveBeenCalled();
  });

  it('keeps a failed gateway connection inside Settings with a recovery action', async () => {
    selected = 'git';
    vi.mocked(git.beginAuthorization).mockRejectedValue(
      new GitHubGatewayError(500, 'GitHub sync gateway request failed (500)'),
    );
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    await fixture.componentInstance.connect();
    fixture.detectChanges();

    expect(fixture.componentInstance.errorMessage).toContain(
      'npm run start:full',
    );
    expect(fixture.componentInstance.gatewayAvailable.git).toBe(false);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="sync-error"]',
      )?.textContent,
    ).toContain('GitHub sync gateway is unavailable');
  });

  it('waits for packaged authorization, refreshes the native session, and restores focus', async () => {
    selected = 'git';
    let completeAuthorization = (): void => undefined;
    const authorization = new Promise<void>((resolve) => {
      completeAuthorization = resolve;
    });
    vi.mocked(git.beginAuthorization).mockReturnValue(authorization);
    git.cancelAuthorization = vi.fn().mockResolvedValue(undefined);
    vi.mocked(git.session)
      .mockResolvedValueOnce({
        configured: true,
        authenticated: false,
        installationUrl,
      })
      .mockResolvedValue({
        configured: true,
        authenticated: true,
        installationUrl,
        user: { id: 42, login: 'reader', avatarUrl: '' },
        repository: null,
      });
    vi.mocked(git.repositories).mockResolvedValue([]);
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    const connecting = fixture.componentInstance.connect();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.authorizationPending).toBe(true),
    );
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="native-authorization-pending"]',
      )?.textContent,
    ).toContain('system browser');

    completeAuthorization();
    await connecting;
    fixture.detectChanges();
    expect(vi.mocked(git.session).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fixture.componentInstance.gitSession.authenticated).toBe(true);
    expect(fixture.componentInstance.statusMessage).toContain(
      'Provider connected',
    );
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="sync-recovery-focus"]',
        ),
      ),
    );
  });

  it('cancels packaged authorization without losing local data and restores the connect action', async () => {
    selected = 'git';
    let rejectAuthorization = (error: unknown): void => {
      void error;
    };
    vi.mocked(git.beginAuthorization).mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectAuthorization = reject;
      }),
    );
    git.cancelAuthorization = vi.fn(async () => {
      rejectAuthorization(
        new GitHubGatewayError(499, 'Provider-controlled cancellation'),
      );
    });
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    const connecting = fixture.componentInstance.connect();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.authorizationPending).toBe(true),
    );
    await fixture.componentInstance.cancelAuthorization();
    await connecting;
    fixture.detectChanges();

    expect(git.cancelAuthorization).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.statusMessage).toContain(
      'local library is unchanged',
    );
    expect(fixture.componentInstance.statusMessage).not.toContain(
      'Provider-controlled',
    );
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="sync-connect"]',
        ),
      ),
    );
  });

  it('offers reconnect after a packaged authorization handoff expires', async () => {
    selected = 'git';
    git.cancelAuthorization = vi.fn().mockResolvedValue(undefined);
    vi.mocked(git.beginAuthorization).mockRejectedValue(
      new GitHubGatewayError(401, 'provider-secret-canary'),
    );
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    await fixture.componentInstance.connect();
    fixture.detectChanges();

    expect(fixture.componentInstance.errorMessage).toContain('Connect again');
    expect(fixture.componentInstance.errorMessage).not.toContain(
      'provider-secret-canary',
    );
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="sync-connect"]',
      ),
    ).toBeTruthy();
  });

  it('offers reconnection after GitHub revokes the provider session', async () => {
    selected = 'git';
    vi.mocked(git.session).mockResolvedValue({
      configured: true,
      authenticated: true,
      installationUrl,
      user: { id: 42, login: 'reader', avatarUrl: '' },
      repository: {
        id: 99,
        fullName: 'reader/library',
        private: true,
        defaultBranch: 'main',
        canPush: true,
      },
    });
    vi.mocked(git.repositories).mockRejectedValue(
      new GitHubGatewayError(401, 'Provider-controlled revocation detail'),
    );
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );
    fixture.detectChanges();

    const alert = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="sync-error"]',
    );
    const connectButton = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ].find((button) =>
      button.textContent?.includes('Authorize GitHub account'),
    );

    expect(alert?.textContent).toContain(
      'Your provider session expired. Connect again to sync.',
    );
    expect(alert?.textContent).not.toContain('Provider-controlled');
    expect(fixture.componentInstance.gitSession).toEqual({
      configured: true,
      authenticated: false,
      installationUrl,
    });
    expect(connectButton).toBeTruthy();
    expect(autoSync.requestImmediate).not.toHaveBeenCalled();
  });

  it('shows a safe retry delay when GitHub rate limits repository access', async () => {
    selected = 'git';
    vi.mocked(git.session).mockResolvedValue({
      configured: true,
      authenticated: true,
      installationUrl,
      user: { id: 42, login: 'reader', avatarUrl: '' },
      repository: null,
    });
    vi.mocked(git.repositories).mockRejectedValue(
      new GitHubGatewayError(429, 'Provider-controlled rate-limit detail', 120),
    );
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );
    fixture.detectChanges();

    const alert = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="sync-error"]',
    );
    expect(alert?.textContent).toContain(
      'GitHub is temporarily rate limiting synchronization',
    );
    expect(alert?.textContent).toContain('Try again in about 2 minutes');
    expect(alert?.textContent).toContain('pending changes remain safe');
    expect(alert?.textContent).not.toContain('Provider-controlled');
    expect(fixture.componentInstance.gatewayAvailable.git).toBe(true);
    expect(
      fixture.componentInstance.repositoryInstallationSettingsUrl,
    ).toBeNull();
    expect(autoSync.requestImmediate).not.toHaveBeenCalled();
  });

  it.each([
    {
      outcome: 'github-denied',
      message:
        'GitHub authorization was cancelled. Your local library is unchanged.',
    },
    {
      outcome: 'github-invalid',
      message:
        'GitHub authorization could not be verified. Please connect GitHub again.',
    },
    {
      outcome: 'github-failed',
      message: 'GitHub authorization could not be completed. Please try again.',
    },
  ])(
    'shows $outcome without retaining OAuth status in the URL',
    async ({ outcome, message }) => {
      const router = TestBed.inject(Router);
      vi.spyOn(router, 'url', 'get').mockReturnValue(
        `/settings/sync?syncAuth=${outcome}`,
      );
      const navigate = vi
        .spyOn(router, 'navigateByUrl')
        .mockResolvedValue(true);
      const fixture = TestBed.createComponent(SyncSettingsPageComponent);
      fixture.detectChanges();
      await vi.waitFor(() =>
        expect(fixture.componentInstance.loading).toBe(false),
      );
      fixture.detectChanges();

      expect(fixture.componentInstance.errorMessage).toBe(message);
      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="sync-error"]',
        )?.textContent,
      ).toContain(message);
      expect(navigate).toHaveBeenCalledWith('/settings/sync', {
        replaceUrl: true,
      });
    },
  );

  it('separates GitHub App installation from account authorization', async () => {
    selected = 'git';
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );
    fixture.detectChanges();

    const onboarding = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLElement>('[data-testid="github-onboarding"]');
    const installLink = onboarding?.querySelector<HTMLAnchorElement>('a');

    expect(onboarding?.textContent).toContain('Install or manage GitHub App');
    expect(onboarding?.textContent).toContain('Authorize GitHub account');
    expect(installLink?.href).toBe(installationUrl);
    expect(installLink?.target).toBe('');
  });

  it('shows a guided GitHub setup state and filters large repository lists', async () => {
    selected = 'git';
    const repositories = Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      fullName:
        index === 4 ? 'reader/favorite-library' : `reader/archive-${index + 1}`,
      private: true,
      defaultBranch: 'main',
      canPush: true,
    }));
    vi.mocked(git.session).mockResolvedValue({
      configured: true,
      authenticated: true,
      installationUrl,
      user: { id: 42, login: 'reader', avatarUrl: '' },
      repository: null,
    });
    vi.mocked(git.repositories).mockResolvedValue(repositories);
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );
    fixture.detectChanges();

    const progress = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="github-setup-progress"]',
    );
    expect(progress?.textContent).toContain('✓ 1 · Account');
    expect(progress?.textContent).toContain('2 · Repository');
    expect(progress?.textContent).toContain('Choose a destination');

    const filter = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLInputElement>(
      '[data-testid="github-repository-filter"]',
    );
    if (!filter) {
      throw new Error('Expected the repository filter to be rendered');
    }
    filter.value = 'favorite';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.componentInstance.filteredRepositories).toEqual([
      repositories[4],
    ]);
    expect(fixture.nativeElement.textContent).toContain(
      'Showing 1 of 6 repositories',
    );
  });

  it('refreshes queued changes and remote backups after automatic sync succeeds', async () => {
    pending.mockResolvedValueOnce([{}]).mockResolvedValueOnce([]);
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.pendingChanges).toBe(1),
    );

    autoSyncListener?.({
      phase: 'idle',
      lastSuccessAt: '2026-07-27T14:00:00.000Z',
      lastResult: {
        pulled: 3,
        pushed: 2,
        conflicts: 1,
        rejected: 0,
      },
    });

    await vi.waitFor(() =>
      expect(fixture.componentInstance.pendingChanges).toBe(0),
    );
    fixture.detectChanges();
    expect(fixture.componentInstance.lastCompletedSyncAt).toBe(
      '2026-07-27T14:00:00.000Z',
    );
    expect(pending).toHaveBeenCalledTimes(2);
    expect(listRemoteBackups).toHaveBeenCalledTimes(2);
    const result = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="last-sync-result"]',
    );
    expect(result?.textContent).toContain('Received');
    expect(result?.textContent).toContain('3');
    expect(result?.textContent).toContain('Sent');
    expect(result?.textContent).toContain('2');
    expect(result?.textContent).toContain('Conflicts retried');
  });

  it('does not relist remote backups after an unchanged automatic sync', async () => {
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );
    expect(listRemoteBackups).toHaveBeenCalledTimes(1);

    autoSyncListener?.({
      phase: 'idle',
      reason: 'startup',
      lastSuccessAt: '2026-07-27T14:00:00.000Z',
      lastResult: {
        pulled: 0,
        pushed: 0,
        conflicts: 0,
        rejected: 0,
        unchanged: true,
      },
    });

    await vi.waitFor(() => expect(pending).toHaveBeenCalledTimes(2));
    expect(listRemoteBackups).toHaveBeenCalledTimes(1);
  });

  it('offers an immediate manual retry when automatic sync needs attention', async () => {
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    autoSyncListener?.({
      phase: 'error',
      reason: 'online',
      errorMessage: 'The previous attempt failed.',
    });
    fixture.detectChanges();
    const retry = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ].find((button) => button.textContent?.includes('Retry now'));
    retry?.click();

    expect(autoSync.requestImmediate).toHaveBeenCalledWith('online');
    expect(fixture.componentInstance.statusMessage).toContain(
      'Synchronization retry queued',
    );
  });

  it('does not claim a selected repository is synchronized before the first success', async () => {
    selected = 'git';
    const repository = {
      id: 7,
      fullName: 'reader/private-library',
      private: true,
      defaultBranch: 'main',
      canPush: true,
    };
    vi.mocked(git.session).mockResolvedValue({
      configured: true,
      authenticated: true,
      installationUrl,
      user: { id: 42, login: 'reader', avatarUrl: '' },
      repository,
    });
    vi.mocked(git.repositories).mockResolvedValue([repository]);
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );
    fixture.detectChanges();

    expect(fixture.componentInstance.gitLibraryStepComplete).toBe(false);
    expect(fixture.componentInstance.gitLibraryStatus).toBe(
      'Ready for the first synchronization',
    );
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="github-setup-progress"]',
      )?.textContent,
    ).toContain('Ready to sync');

    autoSyncListener?.({
      phase: 'idle',
      lastSuccessAt: '2026-07-27T15:30:00.000Z',
    });
    await vi.waitFor(() =>
      expect(fixture.componentInstance.gitLibraryStepComplete).toBe(true),
    );
    fixture.detectChanges();
    expect(fixture.componentInstance.gitLibraryStatus).toBe(
      'Library is up to date',
    );
    expect(fixture.nativeElement.textContent).toContain('Last synchronized');
  });

  it('hides repository creation after a GitHub repository is selected', async () => {
    selected = 'git';
    const repository = {
      id: 7,
      fullName: 'reader/private-library',
      private: true,
      defaultBranch: 'main',
      canPush: true,
    };
    vi.mocked(git.session).mockResolvedValue({
      configured: true,
      authenticated: true,
      installationUrl,
      user: { id: 42, login: 'reader', avatarUrl: '' },
      repository,
    });
    vi.mocked(git.repositories).mockResolvedValue([repository]);
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    expect(
      page.querySelector('[data-testid="create-github-repository"]'),
    ).toBeNull();
    expect(page.textContent).toContain('Manage repository access');
    expect(page.textContent).toContain('Refresh repositories');
  });

  it('offers installation recovery when no repositories are accessible', async () => {
    selected = 'git';
    vi.mocked(git.session).mockResolvedValue({
      configured: true,
      authenticated: true,
      installationUrl,
      user: { id: 42, login: 'reader', avatarUrl: '' },
      repository: null,
    });
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );
    fixture.detectChanges();

    const warning = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLElement>('[data-testid="github-no-repositories"]');
    const creation = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLElement>('[data-testid="create-github-repository"]');

    expect(warning?.textContent).toContain('No repositories are available');
    expect(creation?.textContent).toContain('Create a sync repository');
    expect(warning?.querySelector<HTMLAnchorElement>('a')?.href).toBe(
      installationUrl,
    );
  });

  it('restores the only writable GitHub repository with clear feedback', async () => {
    selected = 'git';
    const repository = {
      id: 7,
      fullName: 'reader/library',
      private: true,
      defaultBranch: 'main',
      canPush: true,
    };
    const withoutRepository = {
      configured: true as const,
      authenticated: true as const,
      installationUrl,
      user: { id: 42, login: 'reader', avatarUrl: '' },
      repository: null,
    };
    const restored = { ...withoutRepository, repository };
    vi.mocked(git.session).mockResolvedValue(withoutRepository);
    vi.mocked(git.repositories).mockResolvedValue([repository]);
    vi.mocked(git.selectRepository).mockResolvedValue(restored);

    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    expect(git.selectRepository).toHaveBeenCalledWith(repository.id);
    expect(fixture.componentInstance.gitSession).toEqual(restored);
    expect(fixture.componentInstance.statusMessage).toContain(
      'Restored sync repository reader/library',
    );
    expect(autoSync.requestImmediate).toHaveBeenCalledWith(
      'destination-selected',
    );
  });

  it('requires an explicit choice when multiple writable repositories exist', async () => {
    selected = 'git';
    vi.mocked(git.session).mockResolvedValue({
      configured: true,
      authenticated: true,
      installationUrl,
      user: { id: 42, login: 'reader', avatarUrl: '' },
      repository: null,
    });
    vi.mocked(git.repositories).mockResolvedValue([
      {
        id: 7,
        fullName: 'reader/first',
        private: true,
        defaultBranch: 'main',
        canPush: true,
      },
      {
        id: 8,
        fullName: 'reader/second',
        private: true,
        defaultBranch: 'main',
        canPush: true,
      },
    ]);

    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    expect(git.selectRepository).not.toHaveBeenCalled();
    expect(fixture.componentInstance.selectedGitRepository).toBeNull();
  });

  it('queues automatic synchronization when the selected provider already has a destination', async () => {
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    await fixture.componentInstance.chooseProvider('mega');

    expect(selection.select).toHaveBeenCalledWith('mega');
    expect(autoSync.requestImmediate).toHaveBeenCalledWith(
      'destination-selected',
    );
    expect(fixture.componentInstance.statusMessage).toContain(
      'Automatic library synchronization queued',
    );
  });

  it('prevents provider changes until the initial session refresh completes', async () => {
    let releaseSession!: () => void;
    vi.mocked(mega.session).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseSession = resolve;
      });
      return {
        authenticated: true,
        account: 'reader@example.test',
        folder: {
          handle: 'folder',
          name: 'Omnia Reader',
          path: '/Omnia Reader',
          canWrite: true,
        },
      };
    });
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(releaseSession).toBeTypeOf('function'));
    fixture.detectChanges();

    const providerButtons = [
      ...(
        fixture.nativeElement as HTMLElement
      ).querySelectorAll<HTMLButtonElement>('fieldset button'),
    ];
    expect(providerButtons).toHaveLength(2);
    expect(providerButtons.every((button) => button.disabled)).toBe(true);

    releaseSession();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );
    fixture.detectChanges();
    expect(providerButtons.every((button) => button.disabled)).toBe(false);
  });

  it('labels provider maturity and consequences with keyboard and narrow touch-safe cards', async () => {
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const fieldset = root.querySelector('fieldset');
    const git = root.querySelector<HTMLButtonElement>(
      '[data-testid="sync-provider-git"]',
    );
    const mega = root.querySelector<HTMLButtonElement>(
      '[data-testid="sync-provider-mega"]',
    );
    expect(fieldset?.querySelector('.grid')?.classList).toContain(
      'grid-cols-1',
    );
    for (const button of [git, mega]) {
      expect(button?.type).toBe('button');
      expect(button?.classList).toContain('min-h-24');
      const descriptions = button?.getAttribute('aria-describedby')?.split(' ');
      expect(descriptions).toHaveLength(2);
      expect(descriptions?.every((id) => !!root.querySelector(`#${id}`))).toBe(
        true,
      );
    }
    expect(git?.textContent).toContain('Git + LFS');
    expect(git?.textContent).toContain('Experimental');
    expect(git?.textContent).toContain('keep another backup');
    expect(mega?.textContent).toContain('MEGA');
    expect(mega?.textContent).toContain('Experimental');
    expect(mega?.textContent).toContain('keep another backup');
  });

  it('queues a complete library sync after selecting a destination', async () => {
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    await fixture.componentInstance.selectFolder({
      target: { value: 'folder' },
    } as unknown as Event);

    expect(autoSync.requestImmediate).toHaveBeenCalledWith(
      'destination-selected',
    );
    expect(fixture.componentInstance.statusMessage).toContain(
      'Initial library synchronization queued',
    );
  });

  it('creates and selects a private GitHub repository before syncing', async () => {
    const repository = {
      id: 99,
      fullName: 'reader/omnia-reader-library',
      private: true,
      defaultBranch: 'main',
      canPush: true,
    };
    const authenticatedSession = {
      configured: true as const,
      authenticated: true as const,
      installationUrl,
      user: { id: 42, login: 'reader', avatarUrl: '' },
      repository,
    };
    selected = 'git';
    vi.mocked(git.session).mockResolvedValue(authenticatedSession);
    vi.mocked(git.repositories).mockResolvedValue([repository]);
    vi.mocked(git.createRepository).mockResolvedValue({
      repository,
      selected: true,
      session: authenticatedSession,
      installationSettingsUrl: null,
    });
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    await fixture.componentInstance.createRepository('omnia-reader-library');

    expect(git.createRepository).toHaveBeenCalledWith('omnia-reader-library');
    expect(fixture.componentInstance.gitSession).toEqual(authenticatedSession);
    expect(autoSync.clearHistory).toHaveBeenCalledWith('git');
    expect(autoSync.requestImmediate).toHaveBeenCalledWith(
      'destination-selected',
    );
    expect(fixture.componentInstance.statusMessage).toContain(
      'Created and selected private repository',
    );
  });

  it('offers GitHub App permission recovery after repository creation is forbidden', async () => {
    selected = 'git';
    vi.mocked(git.session).mockResolvedValue({
      configured: true,
      authenticated: true,
      installationUrl,
      user: { id: 42, login: 'reader', avatarUrl: '' },
      repository: null,
    });
    vi.mocked(git.createRepository).mockRejectedValue(
      new GitHubGatewayError(403, 'Provider-controlled permission detail'),
    );
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    await fixture.componentInstance.createRepository('omnia-reader-library');
    fixture.detectChanges();

    expect(fixture.componentInstance.errorMessage).toContain(
      'Grant the App Contents read and write access',
    );
    expect(fixture.componentInstance.errorMessage).toContain(
      'Administration read and write access',
    );
    expect(fixture.componentInstance.errorMessage).toContain(
      'Your local library is unchanged',
    );
    expect(fixture.componentInstance.errorMessage).not.toContain(
      'Provider-controlled',
    );
    const recoveryLink = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLAnchorElement>(
      '[data-testid="github-permission-recovery"]',
    );
    expect(recoveryLink?.href).toBe(installationUrl);
    expect(autoSync.requestImmediate).not.toHaveBeenCalled();
  });

  it('shows byte progress and safely cancels a manual synchronization', async () => {
    let options: SyncWorkerOptions | undefined;
    synchronize.mockImplementationOnce(
      async (receivedOptions?: SyncWorkerOptions) => {
        options = receivedOptions;
        receivedOptions?.onTransferProgress?.({
          direction: 'upload',
          path: '.omnia-reader/v1/books/id/publication.epub',
          transferredBytes: 512,
          totalBytes: 1024,
        });
        await new Promise<void>((_resolve, reject) => {
          receivedOptions?.signal?.addEventListener(
            'abort',
            () => reject(receivedOptions.signal?.reason),
            { once: true },
          );
        });
        return {
          pulled: 0,
          pushed: 0,
          conflicts: 0,
          rejected: 0,
        };
      },
    );
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    const syncPromise = fixture.componentInstance.syncNow();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.transferProgress).toMatchObject({
        transferredBytes: 512,
      } satisfies Partial<ObjectTransferProgress>),
    );
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Uploading publication: 512 bytes of 1.0 KiB (50%)',
    );
    fixture.componentInstance.cancelSync();
    await syncPromise;
    fixture.detectChanges();

    expect(options?.signal?.aborted).toBe(true);
    expect(fixture.componentInstance.manualSyncController).toBeNull();
    expect(fixture.componentInstance.statusMessage).toContain(
      'Synchronization cancelled',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Local changes are safe and remain queued',
    );
  });

  it('shows automatic transfer progress and safely cancels it', async () => {
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    autoSyncListener?.({
      phase: 'syncing',
      reason: 'book-change',
      transferProgress: {
        direction: 'download',
        path: '.omnia-reader/v1/books/id/publication.pdf',
        transferredBytes: 512,
        totalBytes: 1024,
      },
    });
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Downloading publication: 512 bytes of 1.0 KiB (50%)',
    );
    const cancelButton = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ].find((button) =>
      button.textContent?.includes('Cancel automatic sync'),
    ) as HTMLButtonElement | undefined;
    expect(cancelButton).toBeDefined();
    cancelButton?.click();
    expect(autoSync.cancelActive).toHaveBeenCalledTimes(1);

    autoSyncListener?.({
      phase: 'cancelled',
      reason: 'book-change',
    });
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Automatic synchronization cancelled',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Local changes are safe and remain queued',
    );
  });

  it('lists publication backups stored in the selected destination', async () => {
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );
    fixture.detectChanges();

    const backupSection = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLElement>('[data-testid="remote-book-backups"]');
    expect(backupSection?.textContent).toContain('Remote book');
    expect(backupSection?.textContent).toContain('Reader Example');
    expect(backupSection?.textContent).toContain('2.0 KiB');
  });

  it('deletes a remote backup only after explicit confirmation', async () => {
    dialogOpen.mockReturnValue({
      afterClosed: () => of(true),
    });
    listRemoteBackups
      .mockResolvedValueOnce([remoteBackup])
      .mockResolvedValueOnce([]);
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    await fixture.componentInstance.requestRemoteBackupDeletion(remoteBackup);
    fixture.detectChanges();

    expect(deleteRemoteBackup).toHaveBeenCalledWith('sha256:remote-book');
    expect(fixture.componentInstance.remoteBackups).toEqual([]);
    expect(fixture.componentInstance.statusMessage).toContain(
      'Copies already stored on devices remain available',
    );
  });

  it('keeps a remote backup when deletion is cancelled', async () => {
    const fixture = TestBed.createComponent(SyncSettingsPageComponent);
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.loading).toBe(false),
    );

    await fixture.componentInstance.requestRemoteBackupDeletion(remoteBackup);

    expect(deleteRemoteBackup).not.toHaveBeenCalled();
  });
});

function gatewayStub(overrides: Record<string, unknown>) {
  return {
    list: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    headObject: vi.fn(),
    downloadObject: vi.fn(),
    uploadObject: vi.fn(),
    deleteObject: vi.fn(),
    selectRepository: vi.fn(),
    createRepository: vi.fn(),
    selectFolder: vi.fn(),
    disconnect: vi.fn(),
    beginAuthorization: vi.fn(),
    ...overrides,
  };
}
