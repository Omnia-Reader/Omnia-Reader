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
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import {
  AUTO_SYNC_SCHEDULER,
  AutoSyncStatus,
  LIBRARY_SYNC_SERVICE,
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

@Component({
  selector: 'omnia-sync-settings-page',
  templateUrl: './sync-settings-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MatButtonModule, MatIconModule, RouterLink],
})
export class SyncSettingsPageComponent implements OnInit {
  private readonly journal = inject(SYNC_OPERATION_JOURNAL);
  private readonly gitGateway = inject(GITHUB_GATEWAY);
  private readonly megaGateway = inject(MEGA_GATEWAY);
  private readonly providerSelection = inject(SYNC_PROVIDER_SELECTION);
  private readonly sync = inject(LIBRARY_SYNC_SERVICE);
  private readonly autoSync = inject(AUTO_SYNC_SCHEDULER);
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
  gitSession: GitHubGatewaySession = { authenticated: false };
  megaSession: MegaGatewaySession = { authenticated: false };
  repositories: readonly GitHubRepository[] = [];
  repositoryInstallationSettingsUrl: string | null = null;
  folders: readonly MegaFolder[] = [];
  errorMessage: string | null = null;
  statusMessage: string | null = null;
  automaticSyncStatus: AutoSyncStatus = this.autoSync.status();

  async ngOnInit(): Promise<void> {
    const unsubscribe = this.autoSync.subscribe((status) => {
      this.automaticSyncStatus = status;
      this.changeDetector.markForCheck();
    });
    this.destroyRef.onDestroy(unsubscribe);
    await this.refresh();
  }

  async chooseProvider(provider: SyncProviderKind): Promise<void> {
    this.providerSelection.select(provider);
    this.selectedProvider = provider;
    this.errorMessage = null;
    this.statusMessage = null;
    this.repositoryInstallationSettingsUrl = null;
    await this.runBusy(() => this.refreshProvider());
  }

  connect(): void {
    if (this.selectedProvider === 'git') {
      this.gitGateway.beginAuthorization('/settings/sync');
    } else if (this.selectedProvider === 'mega') {
      this.megaGateway.beginAuthorization('/settings/sync');
    }
  }

  async selectRepository(event: Event): Promise<void> {
    const repositoryId = Number((event.target as HTMLSelectElement).value);
    const repository = this.repositories.find(
      (candidate) => candidate.id === repositoryId,
    );
    if (!repository || !repository.canPush) {
      return;
    }

    await this.runBusy(async () => {
      this.gitSession = await this.gitGateway.selectRepository(repositoryId);
      this.repositoryInstallationSettingsUrl = null;
      this.statusMessage =
        `Sync repository set to ${repository.fullName}. ` +
        'Initial library synchronization queued.';
      this.autoSync.requestImmediate('destination-selected');
    });
  }

  async createRepository(name: string): Promise<void> {
    await this.runBusy(async () => {
      const result = await this.gitGateway.createRepository(name);
      this.gitSession = result.session;
      this.repositories = await this.gitGateway.repositories();
      this.repositoryInstallationSettingsUrl = result.installationSettingsUrl;
      if (result.selected) {
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

    await this.runBusy(async () => {
      this.megaSession = await this.megaGateway.selectFolder(handle);
      this.statusMessage =
        `MEGA sync folder set to ${folder.path}. ` +
        'Initial library synchronization queued.';
      this.autoSync.requestImmediate('destination-selected');
    });
  }

  async syncNow(): Promise<void> {
    if (!this.hasConfiguredDestination()) {
      return;
    }

    await this.runBusy(async () => {
      const result = await this.sync.synchronize();
      await this.refreshPendingCount();
      this.statusMessage =
        `Sync complete: ${result.pulled} pulled, ${result.pushed} pushed` +
        (result.conflicts ? `, ${result.conflicts} conflicts retried` : '') +
        (result.rejected
          ? `, ${result.rejected} invalid changes skipped`
          : '') +
        '.';
    });
  }

  async disconnect(): Promise<void> {
    await this.runBusy(async () => {
      if (this.selectedProvider === 'git') {
        await this.gitGateway.disconnect();
        this.gitSession = { authenticated: false };
      } else if (this.selectedProvider === 'mega') {
        await this.megaGateway.disconnect();
        this.megaSession = { authenticated: false };
      }
      this.providerSelection.clear();
      this.selectedProvider = null;
      this.repositories = [];
      this.repositoryInstallationSettingsUrl = null;
      this.folders = [];
      this.statusMessage =
        'Sync disconnected. Local books and reading progress are unchanged.';
    });
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.errorMessage = null;
    try {
      this.selectedProvider = this.providerSelection.current();
      await Promise.all([this.refreshPendingCount(), this.refreshProvider()]);
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
      this.repositories = this.gitSession.authenticated
        ? await this.gitGateway.repositories()
        : [];
    } else if (this.selectedProvider === 'mega') {
      this.megaSession = await this.megaGateway.session();
      this.folders = this.megaSession.authenticated
        ? await this.megaGateway.folders()
        : [];
    }
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
        this.gitSession = { authenticated: false };
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
