import { expect, type Page } from '@playwright/test';

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
  const editor = page.getByRole('dialog', { name: 'New annotation' });
  await expect(editor).toBeHidden();
  await textLayer.click({ button: 'right', position: selectionPosition });
  await expect(editor).toBeVisible();
  if (style !== 'highlight') {
    await editor
      .getByRole('button', {
        name: style === 'underline' ? 'Underline' : 'Strikethrough',
      })
      .click();
  }
  await editor.getByRole('button', { name: 'Pink' }).click();
  await editor.getByRole('textbox', { name: 'Note (optional)' }).fill(note);
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
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
  const editor = page.getByRole('dialog', { name: 'New annotation' });
  await expect(editor).toBeHidden();
  const browserName = page.context().browser()?.browserType().name();
  const viewport = page.getByTestId('publication-viewport');
  if (browserName === 'webkit') {
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
  } else if (browserName === 'firefox') {
    await viewport.dispatchEvent('contextmenu');
  } else {
    await paragraph.click({ button: 'right', position: selectionPosition });
  }
  await expect(editor).toBeVisible();
  if (style !== 'highlight') {
    await editor
      .getByRole('button', {
        name: style === 'underline' ? 'Underline' : 'Strikethrough',
      })
      .click();
  }
  await editor.getByRole('button', { name: 'Green' }).click();
  await editor.getByRole('textbox', { name: 'Note (optional)' }).fill(note);
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toBeHidden();
}
