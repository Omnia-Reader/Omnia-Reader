import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  OnInit,
  inject,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { Router, RouterLink } from '@angular/router';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { MembershipReconciliation } from '@omnia-reader/reader/domain';
import {
  AUTO_SYNC_SCHEDULER,
  AutoSyncStatus,
  LIBRARY_SYNC_SERVICE,
  ObjectTransferProgress,
  REMOTE_BOOK_BACKUP_SERVICE,
  RemoteBookBackup,
  SYNC_PROVIDER_SELECTION,
  SyncProviderKind,
} from '@omnia-reader/sync/core';
import {
  GITHUB_GATEWAY,
  GitHubGatewayError,
  GitHubGatewaySession,
  GitHubRepository,
  SYNC_OPERATION_JOURNAL,
} from '@omnia-reader/sync/git';
import {
  MEGA_GATEWAY,
  MegaFolder,
  MegaGatewayError,
  MegaGatewaySession,
} from '@omnia-reader/sync/mega';
import { firstValueFrom } from 'rxjs';
import { DeleteRemoteBookDialogComponent } from './delete-remote-book-dialog.component';

@Component({
  selector: 'omnia-sync-settings-page',
  templateUrl: './sync-settings-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MatButtonModule, MatIconModule, RouterLink],
})
export class SyncSettingsPageComponent implements OnInit {
  private readonly journal = inject(SYNC_OPERATION_JOURNAL);
  private readonly repository = inject(LIBRARY_REPOSITORY);
  private readonly gitGateway = inject(GITHUB_GATEWAY);
  private readonly megaGateway = inject(MEGA_GATEWAY);
  private readonly providerSelection = inject(SYNC_PROVIDER_SELECTION);
  private readonly sync = inject(LIBRARY_SYNC_SERVICE);
  private readonly remoteBookBackups = inject(REMOTE_BOOK_BACKUP_SERVICE);
  private readonly autoSync = inject(AUTO_SYNC_SCHEDULER);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);

  pendingChanges = 0;
  loading = true;
  busy = false;
  selectedProvider: SyncProviderKind | null = null;
  gatewayAvailable: Record<SyncProviderKind, boolean> = {
    git: true,
    mega: true,
  };
  gitSession: GitHubGatewaySession = {
    configured: false,
    authenticated: false,
  };
  megaSession: MegaGatewaySession = { authenticated: false };
  repositories: readonly GitHubRepository[] = [];
  repositoryQuery = '';
  repositoryInstallationSettingsUrl: string | null = null;
  folders: readonly MegaFolder[] = [];
  remoteBackups: readonly RemoteBookBackup[] = [];
  openReconciliations: readonly MembershipReconciliation[] = [];
  errorMessage: string | null = null;
  statusMessage: string | null = null;
  transferProgress: ObjectTransferProgress | null = null;
  manualSyncController: AbortController | null = null;
  automaticSyncStatus: AutoSyncStatus = this.autoSync.status();
  lastCompletedSyncAt: string | null =
    this.automaticSyncStatus.lastSuccessAt ?? null;

  async ngOnInit(): Promise<void> {
    const authorizationOutcome = githubAuthorizationOutcome(this.router.url);
    let observedSuccess = this.automaticSyncStatus.lastSuccessAt ?? null;
    const unsubscribe = this.autoSync.subscribe((status) => {
      this.automaticSyncStatus = status;
      const nextSuccess = status.lastSuccessAt ?? null;
      if (nextSuccess !== observedSuccess) {
        observedSuccess = nextSuccess;
        this.lastCompletedSyncAt = nextSuccess;
        if (nextSuccess) {
          void this.refreshAfterAutomaticSync();
        }
      }
      this.changeDetector.markForCheck();
    });
    this.destroyRef.onDestroy(unsubscribe);
    this.destroyRef.onDestroy(() => {
      this.manualSyncController?.abort(
        new DOMException('Synchronization was cancelled', 'AbortError'),
      );
    });
    await this.refresh();
    if (authorizationOutcome) {
      this.errorMessage = authorizationOutcome.message;
      await this.router.navigateByUrl(authorizationOutcome.cleanUrl, {
        replaceUrl: true,
      });
      this.changeDetector.markForCheck();
    }
  }

  get transferProgressPercent(): number {
    return transferProgressPercent(this.transferProgress);
  }

  get transferProgressLabel(): string | null {
    return transferProgressLabel(this.transferProgress);
  }

  get automaticSyncBusy(): boolean {
    return (
      this.automaticSyncStatus.phase === 'syncing' ||
      this.automaticSyncStatus.phase === 'cancelling'
    );
  }

  get automaticTransferProgressPercent(): number {
    return transferProgressPercent(
      this.automaticSyncStatus.transferProgress ?? null,
    );
  }

  get automaticTransferProgressLabel(): string | null {
    return transferProgressLabel(
      this.automaticSyncStatus.transferProgress ?? null,
    );
  }

  get configuredDestination(): boolean {
    return this.hasConfiguredDestination();
  }

  get gitAuthenticated(): boolean {
    return this.gitSession.authenticated;
  }

  get selectedGitRepository(): GitHubRepository | null {
    return this.gitSession.authenticated ? this.gitSession.repository : null;
  }

  get filteredRepositories(): readonly GitHubRepository[] {
    const query = this.repositoryQuery.trim().toLocaleLowerCase();
    if (!query) {
      return this.repositories;
    }
    const matches = this.repositories.filter((repository) =>
      repository.fullName.toLocaleLowerCase().includes(query),
    );
    const selected = this.selectedGitRepository;
    return selected &&
      !matches.some((repository) => repository.id === selected.id)
      ? [selected, ...matches]
      : matches;
  }

  get gitLibraryStatus(): string {
    if (!this.gitAuthenticated) {
      return 'Authorize your GitHub account';
    }
    if (!this.selectedGitRepository) {
      return 'Choose or create a private repository';
    }
    if (this.automaticSyncBusy || this.manualSyncController) {
      return 'Synchronizing now';
    }
    if (this.automaticSyncStatus.phase === 'offline') {
      return 'Waiting for an internet connection';
    }
    if (this.automaticSyncStatus.phase === 'error') {
      return 'Synchronization needs attention';
    }
    if (this.automaticSyncStatus.phase === 'cancelled') {
      return 'Synchronization cancelled; local changes remain safe';
    }
    if (this.automaticSyncStatus.phase === 'scheduled') {
      return this.lastCompletedSyncAt
        ? 'Synchronization scheduled'
        : 'Initial synchronization queued';
    }
    if (this.pendingChanges > 0) {
      return `${this.pendingChanges} ${
        this.pendingChanges === 1 ? 'change' : 'changes'
      } waiting to sync`;
    }
    return this.lastCompletedSyncAt
      ? 'Library is up to date'
      : 'Ready for the first synchronization';
  }

  get gitLibraryStepComplete(): boolean {
    return (
      !!this.selectedGitRepository &&
      !!this.lastCompletedSyncAt &&
      this.pendingChanges === 0
    );
  }

  get gitLibraryStepActive(): boolean {
    return !!this.selectedGitRepository && !this.gitLibraryStepComplete;
  }

  get gitLibraryStepLabel(): string {
    if (!this.selectedGitRepository) {
      return 'Waiting for a repository';
    }
    if (this.gitLibraryStepComplete) {
      return 'Up to date';
    }
    if (this.pendingChanges > 0) {
      return `${this.pendingChanges} waiting`;
    }
    return this.automaticSyncStatus.phase === 'scheduled'
      ? 'Initial sync queued'
      : 'Ready to sync';
  }

  get gitRepositoryUrl(): string | null {
    const fullName = this.selectedGitRepository?.fullName;
    if (!fullName) {
      return null;
    }
    const parts = fullName.split('/');
    if (
      parts.length !== 2 ||
      parts.some((part) => !/^[a-z0-9._-]+$/i.test(part))
    ) {
      return null;
    }
    return `https://github.com/${parts
      .map((part) => encodeURIComponent(part))
      .join('/')}`;
  }

  async chooseProvider(provider: SyncProviderKind): Promise<void> {
    this.providerSelection.select(provider);
    this.selectedProvider = provider;
    this.errorMessage = null;
    this.statusMessage = null;
    this.repositoryInstallationSettingsUrl = null;
    await this.runBusy(async () => {
      await this.refreshProvider();
      if (this.hasConfiguredDestination()) {
        const providerName = provider === 'git' ? 'Git + LFS' : 'MEGA';
        this.statusMessage =
          `${providerName} selected. ` +
          'Automatic library synchronization queued.';
        this.autoSync.requestImmediate('destination-selected');
      }
    });
  }

  async connect(): Promise<void> {
    await this.runBusy(async () => {
      if (this.selectedProvider === 'git') {
        await this.gitGateway.beginAuthorization('/settings/sync');
      } else if (this.selectedProvider === 'mega') {
        this.megaGateway.beginAuthorization('/settings/sync');
      }
    });
  }

  async selectRepository(event: Event): Promise<void> {
    const repositoryId = Number((event.target as HTMLSelectElement).value);
    const repository = this.repositories.find(
      (candidate) => candidate.id === repositoryId,
    );
    if (!repository || !repository.canPush) {
      return;
    }
    const destinationChanged = this.selectedGitRepository?.id !== repository.id;

    await this.runBusy(async () => {
      this.gitSession = await this.gitGateway.selectRepository(repositoryId);
      if (destinationChanged) {
        this.autoSync.clearHistory('git');
      }
      await this.refreshRemoteBackups();
      this.repositoryInstallationSettingsUrl = null;
      this.statusMessage =
        `Sync repository set to ${repository.fullName}. ` +
        'Initial library synchronization queued.';
      this.autoSync.requestImmediate('destination-selected');
    });
  }

  updateRepositoryQuery(event: Event): void {
    this.repositoryQuery = (event.target as HTMLInputElement).value;
  }

  async createRepository(name: string): Promise<void> {
    await this.runBusy(async () => {
      const result = await this.gitGateway.createRepository(name);
      this.gitSession = result.session;
      this.repositories = await this.gitGateway.repositories();
      this.repositoryInstallationSettingsUrl = result.installationSettingsUrl;
      if (result.selected) {
        this.autoSync.clearHistory('git');
        await this.refreshRemoteBackups();
        this.statusMessage =
          `Created and selected private repository ${result.repository.fullName}. ` +
          'Initial library synchronization queued.';
        this.autoSync.requestImmediate('destination-selected');
      } else {
        this.statusMessage =
          `Created private repository ${result.repository.fullName}. ` +
          'Grant the Omnia Reader GitHub App access to it, then refresh the repository list.';
      }
    });
  }

  async refreshRepositories(): Promise<void> {
    await this.runBusy(async () => {
      this.repositories = await this.gitGateway.repositories();
      this.gitSession = await this.gitGateway.session();
      this.repositoryInstallationSettingsUrl = null;
      this.statusMessage = 'GitHub repositories refreshed.';
    });
  }

  async selectFolder(event: Event): Promise<void> {
    const handle = (event.target as HTMLSelectElement).value;
    const folder = this.folders.find(
      (candidate) => candidate.handle === handle,
    );
    if (!folder || !folder.canWrite) {
      return;
    }
    const destinationChanged =
      !this.megaSession.authenticated ||
      this.megaSession.folder?.handle !== folder.handle;

    await this.runBusy(async () => {
      this.megaSession = await this.megaGateway.selectFolder(handle);
      if (destinationChanged) {
        this.autoSync.clearHistory('mega');
      }
      await this.refreshRemoteBackups();
      this.statusMessage =
        `MEGA sync folder set to ${folder.path}. ` +
        'Initial library synchronization queued.';
      this.autoSync.requestImmediate('destination-selected');
    });
  }

  async syncNow(): Promise<void> {
    if (
      !this.hasConfiguredDestination() ||
      this.busy ||
      this.automaticSyncBusy
    ) {
      return;
    }

    const controller = new AbortController();
    this.manualSyncController = controller;
    this.transferProgress = null;
    await this.runBusy(async () => {
      try {
        const result = await this.sync.synchronize({
          signal: controller.signal,
          onTransferProgress: (progress) => {
            this.transferProgress = progress;
            this.changeDetector.markForCheck();
          },
        });
        await this.refreshPendingCount();
        await this.refreshRemoteBackups();
        this.autoSync.recordManualSuccess(result);
        this.statusMessage =
          `Sync complete: ${result.pulled} pulled, ${result.pushed} pushed` +
          (result.conflicts ? `, ${result.conflicts} conflicts retried` : '') +
          (result.rejected
            ? `, ${result.rejected} invalid changes skipped`
            : '') +
          '.';
      } catch (error) {
        if (!controller.signal.aborted) {
          throw error;
        }
        this.statusMessage =
          'Synchronization cancelled. Local changes are safe and remain queued.';
      } finally {
        if (this.manualSyncController === controller) {
          this.manualSyncController = null;
          this.transferProgress = null;
        }
        this.changeDetector.markForCheck();
      }
    });
  }

  cancelSync(): void {
    if (!this.manualSyncController?.signal.aborted) {
      this.statusMessage = 'Cancelling synchronization…';
      this.manualSyncController?.abort(
        new DOMException('Synchronization was cancelled', 'AbortError'),
      );
      this.changeDetector.markForCheck();
    }
  }

  cancelAutomaticSync(): void {
    if (this.autoSync.cancelActive()) {
      this.changeDetector.markForCheck();
    }
  }

  retrySynchronization(): void {
    if (
      this.hasConfiguredDestination() &&
      !this.busy &&
      !this.automaticSyncBusy
    ) {
      this.errorMessage = null;
      this.statusMessage =
        'Synchronization retry queued. Local changes remain safe while it runs.';
      this.autoSync.requestImmediate('online');
      this.changeDetector.markForCheck();
    }
  }

  async disconnect(): Promise<void> {
    await this.runBusy(async () => {
      if (this.selectedProvider === 'git') {
        await this.gitGateway.disconnect();
        this.gitSession = { configured: false, authenticated: false };
      } else if (this.selectedProvider === 'mega') {
        await this.megaGateway.disconnect();
        this.megaSession = { authenticated: false };
      }
      this.providerSelection.clear();
      this.selectedProvider = null;
      this.repositories = [];
      this.repositoryQuery = '';
      this.repositoryInstallationSettingsUrl = null;
      this.folders = [];
      this.remoteBackups = [];
      this.statusMessage =
        'Sync disconnected. Local books and reading progress are unchanged.';
    });
  }

  async requestRemoteBackupDeletion(backup: RemoteBookBackup): Promise<void> {
    if (
      this.busy ||
      this.automaticSyncBusy ||
      !this.hasConfiguredDestination()
    ) {
      return;
    }
    const confirmed = await firstValueFrom(
      this.dialog
        .open<DeleteRemoteBookDialogComponent, RemoteBookBackup, boolean>(
          DeleteRemoteBookDialogComponent,
          {
            data: backup,
            autoFocus: 'first-tabbable',
            restoreFocus: true,
            width: 'min(34rem, calc(100vw - 2rem))',
          },
        )
        .afterClosed(),
    );
    if (!confirmed) {
      return;
    }

    await this.runBusy(async () => {
      await this.remoteBookBackups.deleteBackup(backup.manifest.bookId);
      await Promise.all([
        this.refreshPendingCount(),
        this.refreshRemoteBackups(),
      ]);
      this.statusMessage =
        `Remote backup for “${backup.manifest.title}” deleted. ` +
        'Copies already stored on devices remain available.';
    });
  }

  formatRemoteBackupSize(backup: RemoteBookBackup): string {
    return formatBytes(backup.manifest.size);
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.errorMessage = null;
    try {
      this.selectedProvider = this.providerSelection.current();
      await Promise.all([
        this.refreshPendingCount(),
        this.refreshProvider(),
        this.refreshReconciliations(),
      ]);
    } catch (error) {
      this.handleError(error);
    } finally {
      this.loading = false;
      this.changeDetector.markForCheck();
    }
  }

  private async runBusy(action: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.errorMessage = null;
    this.statusMessage = null;
    this.changeDetector.markForCheck();
    try {
      await action();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.busy = false;
      this.changeDetector.markForCheck();
    }
  }

  private async refreshPendingCount(): Promise<void> {
    this.pendingChanges = (await this.journal.pending()).length;
  }

  private async refreshProvider(): Promise<void> {
    if (this.selectedProvider === 'git') {
      this.gitSession = await this.gitGateway.session();
      this.gatewayAvailable.git = this.gitSession.configured;
      this.repositories = this.gitSession.authenticated
        ? await this.gitGateway.repositories()
        : [];
    } else if (this.selectedProvider === 'mega') {
      this.megaSession = await this.megaGateway.session();
      this.folders = this.megaSession.authenticated
        ? await this.megaGateway.folders()
        : [];
    }
    if (this.hasConfiguredDestination()) {
      await this.refreshRemoteBackups();
    } else {
      this.remoteBackups = [];
    }
  }

  private async refreshAfterAutomaticSync(): Promise<void> {
    await this.refreshPendingCount().catch(() => undefined);
    await this.refreshReconciliations().catch(() => undefined);
    if (this.hasConfiguredDestination()) {
      await this.refreshRemoteBackups().catch(() => undefined);
    }
    this.changeDetector.markForCheck();
  }

  private async refreshRemoteBackups(): Promise<void> {
    this.remoteBackups = await this.remoteBookBackups.list();
  }

  private async refreshReconciliations(): Promise<void> {
    this.openReconciliations =
      await this.repository.listOpenMembershipReconciliations();
  }

  private hasConfiguredDestination(): boolean {
    return (
      (this.selectedProvider === 'git' &&
        this.gitSession.authenticated &&
        !!this.gitSession.repository) ||
      (this.selectedProvider === 'mega' &&
        this.megaSession.authenticated &&
        !!this.megaSession.folder)
    );
  }

  private handleError(error: unknown): void {
    if (
      (error instanceof GitHubGatewayError ||
        error instanceof MegaGatewayError) &&
      error.status === 429
    ) {
      this.repositoryInstallationSettingsUrl = null;
      const providerName =
        this.selectedProvider === 'git'
          ? 'GitHub'
          : this.selectedProvider === 'mega'
            ? 'MEGA'
            : 'The synchronization provider';
      this.errorMessage =
        `${providerName} is temporarily rate limiting synchronization. ` +
        `${retryAfterMessage(error)} ` +
        'Your local library is unchanged and pending changes remain safe.';
      return;
    }
    if (
      error instanceof GitHubGatewayError &&
      error.status === 503 &&
      error.message.includes('not configured')
    ) {
      this.gatewayAvailable.git = false;
      this.gitSession = { configured: false, authenticated: false };
      this.errorMessage =
        'GitHub App authentication is not configured on this sync gateway. Configure the GitHub App credentials and restart the gateway.';
      return;
    }
    if (
      error instanceof GitHubGatewayError &&
      error.status >= 500 &&
      error.status <= 504
    ) {
      this.gatewayAvailable.git = false;
      this.errorMessage =
        'The GitHub sync gateway is unavailable. For local development, start the sync-enabled app with “npm run start:full”.';
      return;
    }
    if (error instanceof GitHubGatewayError && error.status === 403) {
      this.repositoryInstallationSettingsUrl = this.gitSession.configured
        ? this.gitSession.installationUrl
        : null;
      this.errorMessage =
        'GitHub denied repository access. Grant the App Contents read and write access. To create repositories, also grant Administration read and write access, approve the updated installation permissions, then refresh the repository list. Your local library is unchanged.';
      return;
    }
    if (
      (error instanceof GitHubGatewayError ||
        error instanceof MegaGatewayError) &&
      error.status === 404
    ) {
      if (this.selectedProvider) {
        this.gatewayAvailable[this.selectedProvider] = false;
      }
      this.errorMessage =
        'This sync provider is not configured on this deployment. Its gateway must be enabled by the server administrator.';
      return;
    }
    if (
      (error instanceof GitHubGatewayError ||
        error instanceof MegaGatewayError) &&
      error.status === 401
    ) {
      if (this.selectedProvider === 'git') {
        this.gitSession = this.gitSession.configured
          ? {
              configured: true,
              authenticated: false,
              installationUrl: this.gitSession.installationUrl,
            }
          : { configured: false, authenticated: false };
      } else if (this.selectedProvider === 'mega') {
        this.megaSession = { authenticated: false };
      }
      this.errorMessage =
        'Your provider session expired. Connect again to sync.';
      return;
    }
    this.errorMessage =
      error instanceof Error
        ? error.message
        : 'Library sync is temporarily unavailable.';
    this.changeDetector.markForCheck();
  }
}

function retryAfterMessage(error: unknown): string {
  const seconds =
    error && typeof error === 'object' && 'retryAfterSeconds' in error
      ? error.retryAfterSeconds
      : undefined;
  if (
    typeof seconds !== 'number' ||
    !Number.isSafeInteger(seconds) ||
    seconds < 1 ||
    seconds > 86_400
  ) {
    return 'Try again later.';
  }
  if (seconds < 60) {
    return `Try again in about ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `Try again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

interface GitHubAuthorizationOutcome {
  cleanUrl: string;
  message: string;
}

function githubAuthorizationOutcome(
  routerUrl: string,
): GitHubAuthorizationOutcome | null {
  const url = new URL(routerUrl, 'https://omnia-reader.invalid');
  const outcome = url.searchParams.get('syncAuth');
  const message =
    outcome === 'github-denied'
      ? 'GitHub authorization was cancelled. Your local library is unchanged.'
      : outcome === 'github-invalid'
        ? 'GitHub authorization could not be verified. Please connect GitHub again.'
        : outcome === 'github-failed'
          ? 'GitHub authorization could not be completed. Please try again.'
          : null;
  if (!message) {
    return null;
  }
  url.searchParams.delete('syncAuth');
  return {
    cleanUrl: `${url.pathname}${url.search}${url.hash}`,
    message,
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 bytes';
  }
  if (bytes < 1024) {
    return `${Math.ceil(bytes)} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function transferProgressPercent(
  progress: ObjectTransferProgress | null,
): number {
  if (!progress || progress.totalBytes <= 0) {
    return 0;
  }
  return Math.min(
    100,
    Math.max(0, (progress.transferredBytes / progress.totalBytes) * 100),
  );
}

function transferProgressLabel(
  progress: ObjectTransferProgress | null,
): string | null {
  if (!progress) {
    return null;
  }
  const action =
    progress.direction === 'upload'
      ? 'Uploading publication'
      : 'Downloading publication';
  if (progress.totalBytes <= 0) {
    return `${action}: ${formatBytes(progress.transferredBytes)} transferred`;
  }
  return (
    `${action}: ${formatBytes(progress.transferredBytes)} of ` +
    `${formatBytes(progress.totalBytes)}` +
    ` (${Math.round(transferProgressPercent(progress))}%)`
  );
}
