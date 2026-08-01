import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import {
  logicalBookFromVariant,
  LogicalBookRecord,
} from '@omnia-reader/reader/domain';
import {
  AssociatePublicationDialogComponent,
  AssociatePublicationDialogData,
} from './associate-publication-dialog.component';

describe('AssociatePublicationDialogComponent', () => {
  it('names an empty compatible-candidate state', async () => {
    const fixture = await createDialog({
      destination: logicalBook('Destination', 'epub', 'a'),
      candidates: [],
      format: 'pdf',
    });

    expect(fixture.nativeElement.textContent).toContain(
      'No compatible existing books are available.',
    );
    expect(
      fixture.nativeElement.querySelector('button:last-child').disabled,
    ).toBe(true);
  });

  it('disambiguates candidates and returns only an explicit selection', async () => {
    const candidate = logicalBook('Duplicate title', 'pdf', 'b');
    const close = vi.fn();
    const fixture = await createDialog(
      {
        destination: logicalBook('Duplicate title', 'epub', 'a'),
        candidates: [candidate],
        format: 'pdf',
      },
      close,
    );
    const radio = fixture.nativeElement.querySelector(
      'input[type="radio"]',
    ) as HTMLInputElement;
    expect(radio.parentElement?.textContent).toContain('Duplicate title');
    expect(radio.parentElement?.textContent).toContain('PDF');

    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    (
      Array.from(
        fixture.nativeElement.querySelectorAll('button'),
      ) as HTMLButtonElement[]
    )
      .find((button) => button.textContent?.includes('Associate books'))
      ?.click();

    expect(close).toHaveBeenCalledWith(candidate.id);
  });
});

async function createDialog(
  data: AssociatePublicationDialogData,
  close = vi.fn(),
) {
  await TestBed.configureTestingModule({
    imports: [AssociatePublicationDialogComponent],
    providers: [
      { provide: MAT_DIALOG_DATA, useValue: data },
      { provide: MatDialogRef, useValue: { close } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(AssociatePublicationDialogComponent);
  fixture.detectChanges();
  return fixture;
}

function logicalBook(
  title: string,
  format: 'epub' | 'pdf',
  seed: string,
): LogicalBookRecord {
  const digest = seed.repeat(64);
  return {
    ...logicalBookFromVariant({
      id: `sha256:${digest}`,
      format,
      fileName: `${title}.${format}`,
      mediaType: format === 'epub' ? 'application/epub+zip' : 'application/pdf',
      size: 1,
      title,
      authors: ['Same author'],
      importedAt: '2026-07-31T10:00:00.000Z',
    }),
  };
}
