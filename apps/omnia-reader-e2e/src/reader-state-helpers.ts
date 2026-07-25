import { expect, type Page } from '@playwright/test';

export async function createPdfHighlight(
  page: Page,
  pageNumber: number,
  selectedText: string,
  note: string,
): Promise<void> {
  const textLayer = page.locator(
    `.pdfViewer .page[data-page-number="${pageNumber}"] .textLayer`,
  );
  await expect(textLayer).toContainText(selectedText);
  await textLayer.evaluate((layer, text) => {
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
  }, selectedText);
  const editor = page.getByRole('dialog', { name: 'New highlight' });
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Pink' }).click();
  await editor.getByRole('textbox', { name: 'Note (optional)' }).fill(note);
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toBeHidden();
}

export async function createEpubHighlight(
  page: Page,
  selectedText: string,
  note: string,
): Promise<void> {
  const paragraph = page
    .getByTestId('publication-viewport')
    .frameLocator('iframe')
    .locator('p')
    .filter({ hasText: selectedText })
    .first();
  await expect(paragraph).toContainText(selectedText);
  await paragraph.evaluate((element, text) => {
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
  }, selectedText);
  await expect
    .poll(() =>
      paragraph.evaluate((element) => {
        const selection = element.ownerDocument.defaultView?.getSelection();
        return selection && !selection.isCollapsed ? selection.toString() : '';
      }),
    )
    .toContain(selectedText);
  await paragraph.dispatchEvent('mouseup');
  const editor = page.getByRole('dialog', { name: 'New highlight' });
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Green' }).click();
  await editor.getByRole('textbox', { name: 'Note (optional)' }).fill(note);
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toBeHidden();
}
