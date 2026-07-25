import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  EventEmitter,
  ViewChild,
} from '@angular/core';
import { PageNavigation } from '@omnia-reader/reader/domain';

@Component({
  selector: 'omnia-pdf-thumbnail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      class="grid w-full cursor-pointer justify-items-center gap-2 border-0 bg-transparent p-3 text-inherit"
      type="button"
      [class.bg-sky-100]="selected"
      [attr.aria-current]="selected ? 'page' : null"
      [attr.aria-label]="'Go to PDF page ' + pageNumber"
      (click)="selectedPage.emit(pageNumber)"
    >
      <canvas
        #canvas
        class="block max-w-full bg-white shadow-[0_3px_12px_rgb(15_23_42/20%)]"
      ></canvas>
      <span class="text-sm">Page {{ pageNumber }}</span>
    </button>
  `,
})
export class PdfThumbnailComponent
  implements AfterViewInit, OnChanges, OnDestroy
{
  @Input({ required: true }) navigation!: PageNavigation;
  @Input({ required: true }) pageNumber!: number;
  @Input() selected = false;
  @Output() readonly selectedPage = new EventEmitter<number>();

  @ViewChild('canvas', { static: true })
  private canvas!: ElementRef<HTMLCanvasElement>;

  private mounted = false;
  private renderController: AbortController | null = null;

  ngAfterViewInit(): void {
    this.mounted = true;
    this.render();
  }

  ngOnChanges(): void {
    if (this.mounted) {
      this.render();
    }
  }

  ngOnDestroy(): void {
    this.renderController?.abort();
  }

  private render(): void {
    this.renderController?.abort();
    const controller = new AbortController();
    this.renderController = controller;
    void this.navigation
      .renderThumbnail(
        this.pageNumber,
        this.canvas.nativeElement,
        136,
        controller.signal,
      )
      .catch(() => undefined);
  }
}
