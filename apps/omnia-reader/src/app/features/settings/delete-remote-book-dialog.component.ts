import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { RemoteBookBackup } from '@omnia-reader/sync/core';

@Component({
  selector: 'omnia-delete-remote-book-dialog',
  templateUrl: './delete-remote-book-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule],
})
export class DeleteRemoteBookDialogComponent {
  readonly backup = inject<RemoteBookBackup>(MAT_DIALOG_DATA);
}
