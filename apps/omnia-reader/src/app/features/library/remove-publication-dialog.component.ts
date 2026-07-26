import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import type { BookRecord } from '@omnia-reader/reader/domain';

@Component({
  selector: 'omnia-remove-publication-dialog',
  templateUrl: './remove-publication-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule],
})
export class RemovePublicationDialogComponent {
  readonly book = inject<BookRecord>(MAT_DIALOG_DATA);
}
