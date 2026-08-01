import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { BookRecord } from '@omnia-reader/reader/domain';

export interface DetachPublicationDialogData {
  book: BookRecord;
  logicalTitle: string;
}

@Component({
  selector: 'omnia-detach-publication-dialog',
  templateUrl: './detach-publication-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule],
})
export class DetachPublicationDialogComponent {
  readonly data = inject<DetachPublicationDialogData>(MAT_DIALOG_DATA);
}
