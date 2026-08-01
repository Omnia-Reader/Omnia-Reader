import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import {
  LogicalBookId,
  LogicalBookRecord,
  PublicationFormat,
} from '@omnia-reader/reader/domain';

export interface AssociatePublicationDialogData {
  destination: LogicalBookRecord;
  candidates: readonly LogicalBookRecord[];
  format: PublicationFormat;
}

@Component({
  selector: 'omnia-associate-publication-dialog',
  templateUrl: './associate-publication-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MatButtonModule, MatDialogModule],
})
export class AssociatePublicationDialogComponent {
  readonly data = inject<AssociatePublicationDialogData>(MAT_DIALOG_DATA);
  private readonly dialogRef = inject(
    MatDialogRef<AssociatePublicationDialogComponent, LogicalBookId | null>,
  );
  selectedId: LogicalBookId | null = null;

  get selectedCandidate(): LogicalBookRecord | null {
    return (
      this.data.candidates.find(
        (candidate) => candidate.id === this.selectedId,
      ) ?? null
    );
  }

  select(event: Event): void {
    this.selectedId = (event.target as HTMLInputElement).value as LogicalBookId;
  }

  confirm(): void {
    if (this.selectedId) this.dialogRef.close(this.selectedId);
  }
}
