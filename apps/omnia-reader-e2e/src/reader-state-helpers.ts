import { expect, type Locator, type Page } from '@playwright/test';

const READER_ROUTE = /\/reader\/[^/?#]+(?:[?#].*)?$/;

export function preferredPublicationOpenButton(
  page: Page,
  title: string,
): Locator {
  return page.getByRole('button', {
    name: `Open ${title} in its preferred format`,
    exact: true,
  });
}

export async function openLibraryPublication(
  page: Page,
  title: string,
  options: { navigateToLibrary?: boolean } = {},
): Promise<void> {
  if (options.navigateToLibrary !== false) {
    await page.goto('/');
  }
  const openButton = preferredPublicationOpenButton(page, title);
  await expect(openButton).toBeVisible({ timeout: 20_000 });
  await openButton.click();
  await expect(page).toHaveURL(READER_ROUTE, { timeout: 20_000 });
}

export async function createPdfHighlight(
  page: Page,
  pageNumber: number,
  selectedText: string,
  note: string,
  style: 'highlight' | 'underline' | 'strikethrough' = 'highlight',
): Promise<void> {
  const textLayer = page.locator(
    `.pdfViewer .page[data-page-number="${pageNumber}"] .textLayer`,
  );
  await expect(textLayer).toContainText(selectedText);
  const selectionPosition = await textLayer.evaluate((layer, text) => {
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent?.includes(text)) {
      node = walker.nextNode();
    }
    if (!node?.textContent) {
      throw new Error(`Unable to select "${text}"`);
    }
    const start = node.textContent.indexOf(text);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    const selectionRect = range.getBoundingClientRect();
    const layerRect = layer.getBoundingClientRect();
    return {
      x: selectionRect.left - layerRect.left + selectionRect.width / 2,
      y: selectionRect.top - layerRect.top + selectionRect.height / 2,
    };
  }, selectedText);
  const editor = page.getByTestId('annotation-dashboard');
  await expect(editor).toBeHidden();
  await textLayer.click({ button: 'right', position: selectionPosition });
  await expect(editor).toBeVisible();
  await chooseAnnotationColor(page, editor, style, 'Purple');
  if (note) {
    await editor.getByRole('button', { name: 'Add note' }).click();
    await editor.getByRole('textbox', { name: 'Note' }).fill(note);
  }
  await editor
    .getByRole('button', {
      name:
        style === 'highlight'
          ? 'Highlight'
          : style === 'underline'
            ? 'Underline'
            : 'Strikethrough',
      exact: true,
    })
    .click();
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor).toBeHidden();
}

export async function createEpubHighlight(
  page: Page,
  selectedText: string,
  note: string,
  style: 'highlight' | 'underline' | 'strikethrough' = 'highlight',
): Promise<void> {
  const paragraph = page
    .getByTestId('publication-viewport')
    .frameLocator('iframe')
    .locator('p')
    .filter({ hasText: selectedText })
    .first();
  await expect(paragraph).toContainText(selectedText);
  const selectionPosition = await paragraph.evaluate((element, text) => {
    const node = element.firstChild;
    if (!node?.textContent) {
      throw new Error(`Unable to select "${text}"`);
    }
    const start = node.textContent.indexOf(text);
    const range = element.ownerDocument.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const selection = element.ownerDocument.defaultView?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.ownerDocument.dispatchEvent(new Event('selectionchange'));
    const selectionRect = range.getBoundingClientRect();
    const paragraphRect = element.getBoundingClientRect();
    return {
      x: selectionRect.left - paragraphRect.left + selectionRect.width / 2,
      y: selectionRect.top - paragraphRect.top + selectionRect.height / 2,
    };
  }, selectedText);
  await expect
    .poll(() =>
      paragraph.evaluate((element) => {
        const selection = element.ownerDocument.defaultView?.getSelection();
        return selection && !selection.isCollapsed ? selection.toString() : '';
      }),
    )
    .toContain(selectedText);
  const editor = page.getByTestId('annotation-dashboard');
  await expect(editor).toBeHidden();
  if (page.context().browser()?.browserType().name() === 'webkit') {
    const contextMenuAllowed = await page
      .getByTestId('publication-viewport')
      .locator('iframe')
      .evaluate((frame) =>
        frame.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            view: window,
          }),
        ),
      );
    expect(contextMenuAllowed).toBe(false);
  } else {
    await paragraph.click({ button: 'right', position: selectionPosition });
  }
  await expect(editor).toBeVisible();
  const colorLabel = annotationStyleLabel(style);
  const color = editor.getByRole('button', {
    name: new RegExp(`^${colorLabel} color:`),
  });
  await expect(color).toHaveAccessibleName(
    `${colorLabel} color: ${
      style === 'highlight'
        ? 'Yellow'
        : style === 'underline'
          ? 'Sky blue'
          : 'Vermilion'
    }`,
  );
  await chooseAnnotationColor(page, editor, style, 'Bluish green');
  await expect(color).toHaveAccessibleName(`${colorLabel} color: Bluish green`);
  if (note) {
    await editor.getByRole('button', { name: 'Add note' }).click();
    await editor.getByRole('textbox', { name: 'Note' }).fill(note);
  }
  await editor
    .getByRole('button', {
      name:
        style === 'highlight'
          ? 'Highlight'
          : style === 'underline'
            ? 'Underline'
            : 'Strikethrough',
      exact: true,
    })
    .click();
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor).toBeHidden();
}

async function chooseAnnotationColor(
  page: Page,
  editor: Locator,
  style: 'highlight' | 'underline' | 'strikethrough',
  color: string,
): Promise<void> {
  const styleLabel = annotationStyleLabel(style);
  await editor
    .getByRole('button', { name: new RegExp(`^${styleLabel} color:`) })
    .click();
  await page
    .getByRole('button', {
      name: `${color} ${styleLabel.toLocaleLowerCase()} color`,
    })
    .click();
}

function annotationStyleLabel(
  style: 'highlight' | 'underline' | 'strikethrough',
): string {
  return style === 'strikethrough'
    ? 'Strikethrough'
    : style === 'underline'
      ? 'Underline'
      : 'Highlight';
}
