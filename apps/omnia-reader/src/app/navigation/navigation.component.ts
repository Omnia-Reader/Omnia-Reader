import {
  ChangeDetectorRef,
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  inject,
} from '@angular/core';
import { NgClass } from '@angular/common';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import {
  AUTO_SYNC_SCHEDULER,
  AutoSyncStatus,
  SYNC_PROVIDER_SELECTION,
} from '@omnia-reader/sync/core';
import { BackNavigationService } from '../back-navigation.service';

@Component({
  selector: 'omnia-navigation',
  templateUrl: './navigation.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgClass, RouterOutlet, RouterLink, RouterLinkActive],
})
export class NavigationComponent implements OnDestroy {
  private readonly backNavigation = inject(BackNavigationService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly autoSync = inject(AUTO_SYNC_SCHEDULER, { optional: true });
  private readonly syncProviderSelection = inject(SYNC_PROVIDER_SELECTION, {
    optional: true,
  });
  private removeMenuBackHandler: (() => void) | null = null;
  private removeSyncStatusListener: (() => void) | null = null;
  private removeSyncProviderListener: (() => void) | null = null;

  menuOpen = false;
  desktopMenuCollapsed = false;
  automaticSyncStatus: AutoSyncStatus = this.autoSync?.status() ?? {
    phase: 'idle',
  };

  constructor() {
    this.removeSyncStatusListener =
      this.autoSync?.subscribe((status) => {
        this.automaticSyncStatus = status;
        this.changeDetector.markForCheck();
      }) ?? null;
    this.removeSyncProviderListener =
      this.syncProviderSelection?.subscribe?.(() =>
        this.changeDetector.markForCheck(),
      ) ?? null;
  }

  get mainSidenavExpanded(): boolean {
    return globalThis.matchMedia?.('(min-width: 768px)').matches
      ? !this.desktopMenuCollapsed
      : this.menuOpen;
  }

  get syncSettingsRoute(): string {
    return this.autoSync ? '/settings/sync' : '/settings';
  }

  get syncStatusLabel(): string {
    if (!this.autoSync) {
      return 'Local only';
    }
    if (!this.syncProviderSelection?.current()) {
      return 'Set up sync';
    }

    const status = this.automaticSyncStatus;
    switch (status.phase) {
      case 'syncing': {
        const percent = syncTransferPercent(status);
        return percent === null ? 'Syncing' : `Syncing ${percent}%`;
      }
      case 'cancelling':
        return 'Cancelling sync';
      case 'cancelled':
        return 'Sync cancelled';
      case 'offline':
        return 'Sync paused';
      case 'error':
        return 'Sync needs attention';
      case 'scheduled':
        return status.errorMessage ? 'Sync delayed' : 'Sync scheduled';
      default:
        return status.lastSuccessAt ? 'Synced' : 'Sync ready';
    }
  }

  get syncStatusDescription(): string {
    if (!this.autoSync) {
      return 'This build keeps books and reading activity on this device.';
    }

    const provider = this.syncProviderSelection?.current();
    if (!provider) {
      return 'Set up Git synchronization to protect and restore your library.';
    }

    const providerName = provider === 'git' ? 'Git + LFS' : 'MEGA';
    const status = this.automaticSyncStatus;
    if (status.phase === 'error') {
      return (
        status.errorMessage ??
        `${providerName} synchronization needs your attention.`
      );
    }
    if (status.phase === 'offline') {
      return 'You are offline. Local changes are safe and will sync later.';
    }
    if (status.phase === 'scheduled' && status.errorMessage) {
      return status.errorMessage;
    }
    if (status.lastSuccessAt) {
      return `${providerName} last synchronized ${formatSyncDate(
        status.lastSuccessAt,
      )}.`;
    }
    return `${providerName} synchronization is ready.`;
  }

  get syncStatusIcon(): string {
    if (!this.autoSync || !this.syncProviderSelection?.current()) {
      return 'cloud_off';
    }
    switch (this.automaticSyncStatus.phase) {
      case 'syncing':
      case 'cancelling':
        return 'sync';
      case 'offline':
        return 'cloud_off';
      case 'error':
        return 'sync_problem';
      case 'scheduled':
        return 'schedule';
      case 'cancelled':
        return 'sync_disabled';
      default:
        return this.automaticSyncStatus.lastSuccessAt
          ? 'cloud_done'
          : 'cloud_sync';
    }
  }

  get syncStatusClasses(): string {
    if (!this.autoSync || !this.syncProviderSelection?.current()) {
      return 'bg-white/10 text-white hover:bg-white/20';
    }
    switch (this.automaticSyncStatus.phase) {
      case 'error':
        return 'bg-red-100 text-red-950 hover:bg-red-50';
      case 'offline':
      case 'cancelled':
        return 'bg-amber-100 text-amber-950 hover:bg-amber-50';
      case 'syncing':
      case 'cancelling':
        return 'bg-white text-violet-800 hover:bg-violet-50';
      case 'scheduled':
        return 'bg-violet-100 text-violet-950 hover:bg-violet-50';
      default:
        return this.automaticSyncStatus.lastSuccessAt
          ? 'bg-emerald-100 text-emerald-950 hover:bg-emerald-50'
          : 'bg-white/10 text-white hover:bg-white/20';
    }
  }

  toggleMainSidenav(): void {
    if (globalThis.matchMedia?.('(min-width: 768px)').matches) {
      this.desktopMenuCollapsed = !this.desktopMenuCollapsed;
      this.changeDetector.markForCheck();
      requestAnimationFrame(() =>
        globalThis.dispatchEvent(new Event('resize')),
      );
      return;
    }
    this.toggleMenu();
  }

  toggleMenu(): void {
    if (this.menuOpen) {
      this.closeMenu();
      return;
    }

    this.menuOpen = true;
    this.removeMenuBackHandler = this.backNavigation.registerTransientHandler(
      () => {
        if (!this.menuOpen) {
          return false;
        }
        this.closeMenu();
        return true;
      },
    );
  }

  closeMenu(): void {
    if (!this.menuOpen && !this.removeMenuBackHandler) {
      return;
    }
    this.menuOpen = false;
    this.removeMenuBackHandler?.();
    this.removeMenuBackHandler = null;
    this.changeDetector.markForCheck();
  }

  ngOnDestroy(): void {
    this.closeMenu();
    this.removeSyncStatusListener?.();
    this.removeSyncStatusListener = null;
    this.removeSyncProviderListener?.();
    this.removeSyncProviderListener = null;
  }
}

function syncTransferPercent(status: AutoSyncStatus): number | null {
  const progress = status.transferProgress;
  if (!progress || progress.totalBytes <= 0) {
    return null;
  }
  return Math.round(
    Math.min(
      100,
      Math.max(0, (progress.transferredBytes / progress.totalBytes) * 100),
    ),
  );
}

function formatSyncDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString()
    : value;
}
