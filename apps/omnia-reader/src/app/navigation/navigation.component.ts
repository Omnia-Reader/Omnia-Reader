import {
  ChangeDetectorRef,
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  inject,
} from '@angular/core';
import { NgClass } from '@angular/common';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AUTO_SYNC_SCHEDULER, AutoSyncStatus } from '@omnia-reader/sync/core';
import { BackNavigationService } from '../back-navigation.service';
import { SyncConnectionStatusService } from '../sync-connection-status.service';

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
  private readonly syncConnection = inject(SyncConnectionStatusService);
  private removeMenuBackHandler: (() => void) | null = null;
  private removeSyncStatusListener: (() => void) | null = null;

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
    void this.syncConnection.refresh();
  }

  get mainSidenavExpanded(): boolean {
    return globalThis.matchMedia?.('(min-width: 768px)').matches
      ? !this.desktopMenuCollapsed
      : this.menuOpen;
  }

  get syncSettingsRoute(): string {
    return this.autoSync ? '/settings/sync' : '/settings';
  }

  get syncMaturityLabel(): string | null {
    return this.syncConnection.snapshot().providerMaturityLabel ?? null;
  }

  get syncMaturityDescription(): string {
    const connection = this.syncConnection.snapshot();
    return connection.providerMaturityLabel &&
      connection.providerMaturityConsequence
      ? `${connection.providerMaturityLabel} provider. ${connection.providerMaturityConsequence}`
      : '';
  }

  get syncStatusAriaLabel(): string {
    return [
      `${this.syncStatusLabel}.`,
      this.syncMaturityDescription,
      'View sync details.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  get syncStatusTitle(): string {
    return [this.syncStatusDescription, this.syncMaturityDescription]
      .filter(Boolean)
      .join(' ');
  }

  get syncStatusLabel(): string {
    if (!this.autoSync) {
      return 'Local only';
    }
    switch (this.syncConnection.snapshot().state) {
      case 'local-only':
        return 'Set up sync';
      case 'checking':
        return 'Checking sync';
      case 'gateway-unavailable':
        return 'Sync unavailable';
      case 'provider-unconfigured':
        return 'Configure provider';
      case 'authorization-required':
        return `Connect ${this.syncConnection.snapshot().providerLabel}`;
      case 'destination-required':
        return this.syncConnection.snapshot().provider === 'git'
          ? 'Choose repository'
          : 'Choose folder';
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

    const connection = this.syncConnection.snapshot();
    if (connection.state === 'local-only') {
      return 'Set up Git synchronization to protect and restore your library.';
    }

    if (connection.state === 'checking') {
      return 'Checking the current synchronization connection.';
    }
    if (connection.state === 'gateway-unavailable') {
      return `${connection.providerLabel ?? 'The synchronization'} gateway is unavailable. Your local library is safe.`;
    }
    if (connection.state === 'provider-unconfigured') {
      return `${connection.providerLabel ?? 'The synchronization provider'} is not configured on this gateway.`;
    }
    if (connection.state === 'authorization-required') {
      return `Connect ${connection.providerLabel ?? 'your provider'} to continue synchronization.`;
    }
    if (connection.state === 'destination-required') {
      return connection.accountLabel
        ? `${connection.providerLabel} account ${connection.accountLabel} is connected. Choose a sync destination.`
        : `Choose a ${connection.providerLabel} sync destination.`;
    }

    const providerName = connection.providerLabel ?? 'Library';
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
      return `${providerName} ${connection.accountLabel ?? ''} · ${connection.destinationLabel ?? ''}. Last synchronized ${formatSyncDate(status.lastSuccessAt)}.`;
    }
    return `${providerName} synchronization is ready for ${connection.destinationLabel}.`;
  }

  get syncStatusIcon(): string {
    const readiness = this.syncConnection.snapshot().state;
    if (!this.autoSync || readiness === 'local-only') {
      return 'cloud_off';
    }
    if (readiness !== 'ready') {
      return readiness === 'checking' ? 'sync' : 'sync_problem';
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
    const readiness = this.syncConnection.snapshot().state;
    if (!this.autoSync || readiness === 'local-only') {
      return 'bg-white/10 text-white hover:bg-white/20';
    }
    if (readiness !== 'ready') {
      return readiness === 'checking'
        ? 'bg-white/10 text-white hover:bg-white/20'
        : 'bg-amber-100 text-amber-950 hover:bg-amber-50';
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
