import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  inject,
  OnInit,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import {
  LIBRARY_BACKUP_MEDIA_TYPE,
  LIBRARY_QUARANTINE_REPOSITORY,
  LibraryBackupService,
  LibraryBackupExportProgress,
  LibraryQuarantineService,
  QuarantinedLibraryRecord,
} from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';

@Component({
  selector: 'omnia-settings-page',
  templateUrl: './settings-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatCardModule, MatIconModule, RouterLink],
  providers: [
    {
      provide: LibraryQuarantineService,
      useFactory: () =>
        new LibraryQuarantineService(inject(LIBRARY_QUARANTINE_REPOSITORY)),
    },
  ],
})
export class SettingsPageComponent implements OnInit {
  private readonly backups = inject(LibraryBackupService);
  private readonly quarantine = inject(LibraryQuarantineService);
  private readonly platform = inject(PLATFORM_PORT);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private backupAbortController: AbortController | null = null;

  busy = false;
  backupProgressMessage: string | null = null;
  backupExportActive = false;
  errorMessage: string | null = null;
  statusMessage: string | null = null;
  quarantineLoading = true;
  quarantineErrorMessage: string | null = null;
  quarantinedRecords: readonly QuarantinedLibraryRecord[] = [];

  async ngOnInit(): Promise<void> {
    try {
      this.quarantinedRecords = await this.quarantine.listRecords();
    } catch (error) {
      this.quarantineErrorMessage =
        error instanceof Error
          ? error.message
          : 'Unable to inspect recovered local data.';
    } finally {
      this.quarantineLoading = false;
      this.changeDetector.markForCheck();
    }
  }

  async exportBackup(): Promise<void> {
    await this.runBusy(async () => {
      const now = new Date();
      const controller = new AbortController();
      this.backupAbortController = controller;
      this.backupExportActive = true;
      const options = {
        signal: controller.signal,
        onProgress: (progress: LibraryBackupExportProgress) => {
          this.backupProgressMessage = describeBackupProgress(progress);
          this.changeDetector.markForCheck();
        },
      };

      let backup: { fileName: string; bookCount: number };
      try {
        if (this.platform.supportsStreamingFileSave) {
          const destination = await this.platform.createFileSave({
            suggestedName: this.backups.backupFileName(now),
            mediaType: LIBRARY_BACKUP_MEDIA_TYPE,
            extensions: [],
          });
          if (!destination) {
            this.statusMessage = 'Backup export cancelled.';
            return;
          }
          backup = await this.backups.exportArchiveTo(
            destination.writable,
            now,
            options,
          );
        } else {
          const exported = await this.backups.exportArchive(now, options);
          downloadBlob(exported.blob, exported.fileName);
          backup = exported;
        }
      } finally {
        this.backupAbortController = null;
        this.backupExportActive = false;
        this.backupProgressMessage = null;
        this.changeDetector.markForCheck();
      }
      this.statusMessage =
        backup.bookCount === 1
          ? 'Backup saved with 1 publication.'
          : `Backup saved with ${backup.bookCount} publications.`;
    });
  }

  cancelBackupExport(): void {
    this.backupAbortController?.abort(
      new DOMException('Backup export was cancelled', 'AbortError'),
    );
  }

  async importBackup(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.item(0);
    input.value = '';
    if (!file) {
      return;
    }

    await this.runBusy(async () => {
      const result = await this.backups.importArchive(file);
      this.statusMessage =
        `Backup restored: ${result.booksAdded} added, ` +
        `${result.booksUpdated} updated, ` +
        `${result.progressRestored} progress records restored, ` +
        `${result.progressDocumentsRestored} device progress records restored, ` +
        `${result.bookmarksRestored} bookmarks restored, ` +
        `${result.annotationsRestored} annotations restored.`;
    });
  }

  async exportQuarantinedRecords(): Promise<void> {
    await this.runBusy(async () => {
      const exported = await this.quarantine.exportRecords();
      downloadBlob(exported.blob, exported.fileName);
      this.statusMessage =
        exported.recordCount === 1
          ? 'Recovery data exported with 1 quarantined record.'
          : `Recovery data exported with ${exported.recordCount} quarantined records.`;
    }, 'The recovered-data export failed.');
  }

  describeRecordKey(recordKey: IDBValidKey): string {
    if (recordKey instanceof Date) {
      return recordKey.toISOString();
    }
    if (recordKey instanceof ArrayBuffer) {
      return `Binary key (${recordKey.byteLength} bytes)`;
    }
    if (Array.isArray(recordKey)) {
      return recordKey.map((part) => this.describeRecordKey(part)).join(' / ');
    }
    return String(recordKey);
  }

  private async runBusy(
    action: () => Promise<void>,
    fallbackMessage = 'The library backup operation failed.',
  ): Promise<void> {
    this.busy = true;
    this.errorMessage = null;
    this.statusMessage = null;
    this.changeDetector.markForCheck();
    try {
      await action();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.statusMessage = 'Backup export cancelled.';
      } else {
        this.errorMessage =
          error instanceof Error ? error.message : fallbackMessage;
      }
    } finally {
      this.busy = false;
      this.changeDetector.markForCheck();
    }
  }
}

function describeBackupProgress(progress: LibraryBackupExportProgress): string {
  if (progress.totalBooks === 0) {
    return 'Preparing empty library backup…';
  }
  return (
    `Exporting publication ${progress.completedBooks} of ${progress.totalBooks}` +
    ` (${formatBytes(progress.processedBytes)} of ${formatBytes(progress.totalBytes)})…`
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
