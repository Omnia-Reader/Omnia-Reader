import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { BackNavigationService } from './back-navigation.service';
import { PublicationImportService } from './features/library/publication-import.service';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        {
          provide: PublicationImportService,
          useValue: { error: () => null, clearError: vi.fn() },
        },
        {
          provide: BackNavigationService,
          useValue: { registerTransientHandler: () => vi.fn() },
        },
      ],
    }).compileComponents();
  });

  it('should create', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(fixture.componentInstance).toBeTruthy();
  });
});
