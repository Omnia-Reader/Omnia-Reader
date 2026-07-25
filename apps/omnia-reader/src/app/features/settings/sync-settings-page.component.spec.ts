import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  AUTO_SYNC_SCHEDULER,
  LIBRARY_SYNC_SERVICE,
  SYNC_PROVIDER_SELECTION,
  SyncProviderKind,
  SyncProviderSelection,
} from '@omnia-reader/sync/core';
import {
  GITHUB_GATEWAY,
  GitHubGateway,
  SYNC_OPERATION_JOURNAL,
} from '@omnia-reader/sync/git';
import { MEGA_GATEWAY, MegaGateway } from '@omnia-reader/sync/mega';
import { vi } from 'vitest';
import { SyncSettingsPageComponent } from './sync-settings-page.component';

describe('SyncSettingsPageComponent', () => {
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
    subscribe: vi.fn((listener: (status: { phase: string }) => void) => {
      listener({ phase: 'idle' });
      return vi.fn();
    }),
    requestImmediate: vi.fn(),
  };

  beforeEach(async () => {
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
      session: vi.fn().mockResolvedValue({ authenticated: false }),
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
          useValue: { pending: vi.fn().mockResolvedValue([]) },
        },
        { provide: SYNC_PROVIDER_SELECTION, useValue: selection },
        { provide: GITHUB_GATEWAY, useValue: git },
        { provide: MEGA_GATEWAY, useValue: mega },
        { provide: LIBRARY_SYNC_SERVICE, useValue: { synchronize } },
        { provide: AUTO_SYNC_SCHEDULER, useValue: autoSync },
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
    expect(fixture.componentInstance.statusMessage).toContain('2 pulled');
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
});

function gatewayStub(overrides: Record<string, unknown>) {
  return {
    list: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    headObject: vi.fn(),
    downloadObject: vi.fn(),
    uploadObject: vi.fn(),
    selectRepository: vi.fn(),
    selectFolder: vi.fn(),
    disconnect: vi.fn(),
    beginAuthorization: vi.fn(),
    ...overrides,
  };
}
