import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MembershipReconciliation } from '@omnia-reader/reader/domain';
import { ReconcileMembershipDialogComponent } from './reconcile-membership-dialog.component';

describe('ReconcileMembershipDialogComponent', () => {
  let fixture: ComponentFixture<ReconcileMembershipDialogComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ReconcileMembershipDialogComponent],
      providers: [{ provide: MAT_DIALOG_DATA, useValue: reconciliation() }],
    }).compileComponents();
    fixture = TestBed.createComponent(ReconcileMembershipDialogComponent);
    fixture.detectChanges();
  });

  it('names both proposals and exposes explicit decisions', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Current grouping');
    expect(text).toContain('Competing grouping');
    expect(text).toContain('Keep current grouping');
    expect(text).toContain('Use competing grouping 1');
    expect(text).toContain('as a separate book');
  });
});

function reconciliation(): MembershipReconciliation {
  return {
    schemaVersion: 1,
    conflictId: 'conflict:test',
    status: 'open',
    conflictingChangeIds: ['change:a', 'change:b'],
    affectedVariantIds: [
      `sha256:${'a'.repeat(64)}`,
      `sha256:${'b'.repeat(64)}`,
    ],
    acceptedMembership: [
      {
        logicalBookId: `logical:sha256:${'c'.repeat(64)}`,
        format: 'epub',
        variantId: `sha256:${'a'.repeat(64)}`,
      },
    ],
    rejectedMembership: [
      {
        logicalBookId: `logical:sha256:${'d'.repeat(64)}`,
        format: 'pdf',
        variantId: `sha256:${'b'.repeat(64)}`,
      },
    ],
    detectedAt: '2026-07-31T08:00:00.000Z',
  };
}
