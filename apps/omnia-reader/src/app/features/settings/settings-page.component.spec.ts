import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  LIBRARY_QUARANTINE_REPOSITORY,
  LibraryBackupService,
} from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPageComponent } from './settings-page.component';

describe('SettingsPageComponent', () => {
  const backups = {
    backupFileName: vi.fn(),
    exportArchive: vi.fn(),
    exportArchiveTo: vi.fn(),
    importArchive: vi.fn(),
  };
  const platform = {
    kind: 'web',
    supportsStreamingFileSave: false,
    createFileSave: vi.fn(),
    getStorageStatus: vi.fn(),
    requestPersistentStorage: vi.fn(),
  };
  const quarantineRepository = {
    listQuarantinedRecords: vi.fn(),
  };

  beforeEach(async () => {
    backups.exportArchive.mockReset();
    backups.exportArchiveTo.mockReset();
    backups.backupFileName.mockReset();
    backups.backupFileName.mockReturnValue(
      'omnia-reader-backup-2026-07-25.omnia-backup',
    );
    backups.importArchive.mockReset();
    platform.supportsStreamingFileSave = false;
    platform.createFileSave.mockReset();
    platform.getStorageStatus.mockReset();
    platform.getStorageStatus.mockResolvedValue({
      persistence: 'best-effort',
      usageBytes: 5 * 1024 * 1024,
      quotaBytes: 100 * 1024 * 1024,
    });
    platform.requestPersistentStorage.mockReset();
    quarantineRepository.listQuarantinedRecords.mockReset();
    quarantineRepository.listQuarantinedRecords.mockResolvedValue([]);
    await TestBed.configureTestingModule({
      imports: [SettingsPageComponent],
      providers: [
        provideRouter([]),
        { provide: LibraryBackupService, useValue: backups },
        { provide: PLATFORM_PORT, useValue: platform },
        {
          provide: LIBRARY_QUARANTINE_REPOSITORY,
          useValue: quarantineRepository,
        },
      ],
    }).compileComponents();
  });

  it('labels the hidden backup archive input', () => {
    const fixture = TestBed.createComponent(SettingsPageComponent);
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '#backup-archive-input',
    ) as HTMLInputElement;
    const label = fixture.nativeElement.querySelector(
      'label[for="backup-archive-input"]',
    ) as HTMLLabelElement;

    expect(input).toBeTruthy();
    expect(label.textContent?.trim()).toBe('Portable library backup archive');
    expect(label.control).toBe(input);
  });

  it('links to authenticated cross-device library synchronization', async () => {
    const fixture = TestBed.createComponent(SettingsPageComponent);

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('a[href="/settings/sync"]'),
    ).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain(
      'Cross-device library sync',
    );
  });

  it('shows local storage durability, quota usage, and a protection action', async () => {
    const fixture = TestBed.createComponent(SettingsPageComponent);

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Offline library storage',
    );
    expect(fixture.nativeElement.textContent).toContain('Best effort');
    expect(fixture.nativeElement.textContent).toContain(
      '5.0 MiB of 100.0 MiB used',
    );
    const meter = fixture.nativeElement.querySelector(
      'meter[aria-label="Offline library storage usage"]',
    ) as HTMLMeterElement;
    expect(meter.value).toBe(5);
    expect(
      fixture.nativeElement.querySelector(
        'button[aria-describedby="storage-persistence-description"]',
      ).textContent,
    ).toContain('Protect offline library');
  });

  it('requests persistent browser storage and reports the granted state', async () => {
    platform.requestPersistentStorage.mockResolvedValue({
      persistence: 'persistent',
      usageBytes: 5 * 1024 * 1024,
      quotaBytes: 100 * 1024 * 1024,
    });
    const fixture = TestBed.createComponent(SettingsPageComponent);

    fixture.detectChanges();
    await fixture.whenStable();
    await fixture.componentInstance.requestPersistentStorage();
    fixture.detectChanges();

    expect(platform.requestPersistentStorage).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.textContent).toContain('Protected');
    expect(fixture.nativeElement.textContent).toContain(
      'Offline library storage is now protected',
    );
    expect(
      fixture.nativeElement.querySelector(
        'button[aria-describedby="storage-persistence-description"]',
      ),
    ).toBeNull();
  });

  it('keeps backup guidance when persistent storage is unavailable', async () => {
    platform.getStorageStatus.mockResolvedValue({
      persistence: 'unavailable',
    });
    const fixture = TestBed.createComponent(SettingsPageComponent);

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Unavailable');
    expect(fixture.nativeElement.textContent).toContain(
      'Keep a current portable backup',
    );
    expect(
      fixture.nativeElement.querySelector(
        'button[aria-describedby="storage-persistence-description"]',
      ),
    ).toBeNull();
  });

  it('exports the complete library as a downloaded archive', async () => {
    const blob = new Blob(['backup'], { type: 'application/zip' });
    backups.exportArchive.mockResolvedValue({
      blob,
      fileName: 'omnia-reader-backup.omnia-backup',
      bookCount: 2,
    });
    const createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:test-backup');
    const revokeObjectUrl = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(SettingsPageComponent);

    await fixture.componentInstance.exportBackup();
    fixture.detectChanges();

    expect(backups.exportArchive).toHaveBeenCalledOnce();
    expect(createObjectUrl).toHaveBeenCalledWith(blob);
    expect(fixture.nativeElement.textContent).toContain(
      'Backup saved with 2 publications.',
    );
    createObjectUrl.mockRestore();
    revokeObjectUrl.mockRestore();
  });

  it('streams a backup into a platform save destination when supported', async () => {
    platform.supportsStreamingFileSave = true;
    const writable = new WritableStream<Uint8Array>();
    platform.createFileSave.mockResolvedValue({ writable });
    backups.exportArchiveTo.mockImplementation(
      async (
        destination: WritableStream<Uint8Array>,
        _now: Date,
        options: {
          onProgress(progress: {
            completedBooks: number;
            totalBooks: number;
            processedBytes: number;
            totalBytes: number;
          }): void;
        },
      ) => {
        expect(destination).toBe(writable);
        options.onProgress({
          completedBooks: 2,
          totalBooks: 2,
          processedBytes: 4096,
          totalBytes: 4096,
        });
        return {
          fileName: 'omnia-reader-backup.omnia-backup',
          bookCount: 2,
        };
      },
    );
    const fixture = TestBed.createComponent(SettingsPageComponent);

    await fixture.componentInstance.exportBackup();
    fixture.detectChanges();

    expect(platform.createFileSave).toHaveBeenCalledWith({
      suggestedName: 'omnia-reader-backup-2026-07-25.omnia-backup',
      mediaType: 'application/vnd.omnia-reader.backup+zip',
      extensions: [],
    });
    expect(backups.exportArchiveTo).toHaveBeenCalledOnce();
    expect(backups.exportArchive).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain(
      'Backup saved with 2 publications.',
    );
  });

  it('cancels an active streaming export without reporting an error', async () => {
    platform.supportsStreamingFileSave = true;
    platform.createFileSave.mockResolvedValue({
      writable: new WritableStream<Uint8Array>(),
    });
    backups.exportArchiveTo.mockImplementation(
      (
        _destination: WritableStream<Uint8Array>,
        _now: Date,
        options: { signal: AbortSignal },
      ) =>
        new Promise((_, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(options.signal.reason),
            { once: true },
          );
        }),
    );
    const fixture = TestBed.createComponent(SettingsPageComponent);

    const exporting = fixture.componentInstance.exportBackup();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.backupExportActive).toBe(true),
    );
    fixture.componentInstance.cancelBackupExport();
    await exporting;
    fixture.detectChanges();

    expect(fixture.componentInstance.errorMessage).toBeNull();
    expect(fixture.nativeElement.textContent).toContain(
      'Backup export cancelled.',
    );
  });

  it('restores a selected archive and reports merge results', async () => {
    backups.importArchive.mockResolvedValue({
      booksAdded: 1,
      booksUpdated: 2,
      progressRestored: 3,
      progressDocumentsRestored: 6,
      preferencesRestored: 1,
      bookmarksRestored: 4,
      annotationsRestored: 5,
    });
    const fixture = TestBed.createComponent(SettingsPageComponent);
    const file = new File(['backup'], 'library.omnia-backup', {
      type: 'application/zip',
    });
    const input = {
      files: { item: () => file },
      value: 'C:\\fakepath\\library.omnia-backup',
    };

    await fixture.componentInstance.importBackup({
      target: input,
    } as unknown as Event);
    fixture.detectChanges();

    expect(input.value).toBe('');
    expect(backups.importArchive).toHaveBeenCalledWith(file);
    expect(fixture.nativeElement.textContent).toContain(
      'Backup restored: 1 added, 2 updated, 3 progress records restored, 6 device progress records restored, 4 bookmarks restored, 5 annotations restored.',
    );
  });

  it('surfaces archive validation errors without reporting success', async () => {
    backups.importArchive.mockRejectedValue(
      new Error('Backup publication failed integrity validation'),
    );
    const fixture = TestBed.createComponent(SettingsPageComponent);

    await fixture.componentInstance.importBackup({
      target: {
        files: {
          item: () => new File(['bad'], 'bad.omnia-backup'),
        },
        value: 'bad.omnia-backup',
      },
    } as unknown as Event);
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]');
    expect(alert.textContent).toContain(
      'Backup publication failed integrity validation',
    );
    expect(fixture.componentInstance.statusMessage).toBeNull();
  });

  it('lists and exports quarantined records without deleting them', async () => {
    const records = [
      {
        id: 9,
        storeName: 'progress',
        recordKey: 'corrupt-progress',
        value: { schemaVersion: 99 },
        reason: 'Reading progress failed publication or schema validation',
        quarantinedAt: '2026-07-25T11:00:00.000Z',
      },
    ];
    quarantineRepository.listQuarantinedRecords.mockResolvedValue(records);
    const createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:test-recovery');
    const revokeObjectUrl = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(SettingsPageComponent);

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Recovered local data');
    expect(fixture.nativeElement.textContent).toContain(
      'Reading progress failed publication or schema validation',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Original key: corrupt-progress',
    );

    await fixture.componentInstance.exportQuarantinedRecords();
    fixture.detectChanges();

    expect(quarantineRepository.listQuarantinedRecords).toHaveBeenCalledTimes(
      2,
    );
    expect(createObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'application/vnd.omnia-reader.quarantine+json',
      }),
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Recovery data exported with 1 quarantined record.',
    );
    expect(records).toHaveLength(1);
    createObjectUrl.mockRestore();
    revokeObjectUrl.mockRestore();
  });
});
