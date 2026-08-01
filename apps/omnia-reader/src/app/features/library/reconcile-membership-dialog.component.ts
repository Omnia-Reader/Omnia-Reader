import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import {
  LogicalBookId,
  MembershipReconciliation,
  MembershipReconciliationDecision,
} from '@omnia-reader/reader/domain';

@Component({
  selector: 'omnia-reconcile-membership-dialog',
  templateUrl: './reconcile-membership-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule],
})
export class ReconcileMembershipDialogComponent {
  readonly conflict = inject<MembershipReconciliation>(MAT_DIALOG_DATA);

  readonly competingLogicalBookIds = [
    ...new Set(
      this.conflict.rejectedMembership.map(
        (membership) => membership.logicalBookId,
      ),
    ),
  ];

  acceptCompeting(logicalBookId: string): MembershipReconciliationDecision {
    return {
      kind: 'accept-rejected',
      logicalBookId: logicalBookId as LogicalBookId,
    };
  }

  makeStandalone(variantId: string): MembershipReconciliationDecision {
    return { kind: 'make-standalone', variantId };
  }
}
