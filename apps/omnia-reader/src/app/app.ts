import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterModule } from '@angular/router';
import { NavigationComponent } from './navigation/navigation.component';
import { PublicationImportService } from './features/library/publication-import.service';

@Component({
  imports: [RouterModule, NavigationComponent],
  selector: 'omnia-root',
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './app.scss',
})
export class App {
  protected readonly publicationImports = inject(PublicationImportService);
  protected title = 'omnia-reader';
}
