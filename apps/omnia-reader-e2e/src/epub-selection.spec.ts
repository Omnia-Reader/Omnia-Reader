import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createEpubFixture } from './publication-fixtures';
import { createEpubHighlight } from './reader-state-helpers';

test('keeps a highlight while underlining and removing only a selected substring', async ({
  page,
  browserName,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import books' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'omnia-selection-fixture.epub',
    mimeType: 'application/epub+zip',
    buffer: await createEpubFixture(),
  });
  await page.getByText('Omnia EPUB Fixture', { exact: true }).click();

  const paragraph = page
    .getByTestId('publication-viewport')
    .frameLocator('iframe')
    .locator('p')
    .filter({ hasText: 'first EPUB fixture' })
    .first();
  await expect(paragraph).toBeVisible({ timeout: 20_000 });

  await createEpubHighlight(page, 'first EPUB fixture', '');
  await expect
    .poll(() => epubAnnotationRendering(paragraph))
    .toEqual(
      expect.objectContaining({
        size: 1,
        rangeTexts: ['first EPUB fixture'],
      }),
    );

  const epubCoordinates = await selectEpubText(page, 'EPUB');
  const editor = page.getByTestId('annotation-dashboard');
  await expect(editor).toBeHidden();
  await openEpubSelectionContextMenu(page, browserName, epubCoordinates);
  await expect(editor).toBeVisible();
  await expect(
    editor.getByRole('toolbar', { name: 'Annotation formatting' }),
  ).toBeVisible();
  await expect(
    editor.getByText('Annotation tools', { exact: true }),
  ).toHaveCount(0);
  await expect(editor.getByText('Format', { exact: true })).toHaveCount(0);
  await expect(
    page.getByTestId('reader-toolbar').getByTestId('annotation-dashboard'),
  ).toBeVisible();
  const [dashboardBox, readerBox] = await Promise.all([
    editor.boundingBox(),
    page.getByTestId('reader-root').boundingBox(),
  ]);
  expect(dashboardBox).not.toBeNull();
  expect(readerBox).not.toBeNull();
  expect(dashboardBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
    (readerBox?.y ?? 0) + (readerBox?.height ?? 0) / 3,
  );
  const frameBox = await page
    .getByTestId('publication-viewport')
    .locator('iframe')
    .boundingBox();
  expect(frameBox).not.toBeNull();
  await page.mouse.click((frameBox?.x ?? 0) + 12, (frameBox?.y ?? 0) + 12);
  await expect(editor).toBeHidden();

  const reopenedCoordinates = await selectEpubText(page, 'EPUB');
  await openEpubSelectionContextMenu(page, browserName, reopenedCoordinates);
  await expect(editor).toBeVisible();
  await expect(
    editor.getByRole('button', { name: 'Save', exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 768, height: 900 });
  const commandRow = page.getByTestId('annotation-command-row');
  const commandRail = page.getByTestId('annotation-command-rail');
  const closeButton = editor.getByRole('button', {
    name: 'Close',
    exact: true,
  });
  await expect(commandRow).toBeVisible();
  await expect(closeButton).toBeVisible();
  await expect
    .poll(async () => (await commandRow.boundingBox())?.height ?? Infinity)
    .toBeLessThanOrEqual(38);
  await expect
    .poll(async () => (await editor.boundingBox())?.height ?? Infinity)
    .toBeLessThanOrEqual(38);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(closeButton).toBeVisible();
  const [closeBox, narrowRailGeometry] = await Promise.all([
    closeButton.boundingBox(),
    commandRail.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    })),
  ]);
  expect(
    (closeBox?.x ?? Infinity) + (closeBox?.width ?? 0),
  ).toBeLessThanOrEqual(390);
  expect(narrowRailGeometry.scrollWidth).toBeLessThanOrEqual(
    narrowRailGeometry.clientWidth,
  );
  await expect(editor.getByRole('button', { name: 'Add note' })).toBeVisible();
  const compactHighlightControl = editor.getByTestId(
    'annotation-highlight-control',
  );
  await expect
    .poll(
      async () =>
        (await compactHighlightControl.boundingBox())?.width ?? Infinity,
    )
    .toBeLessThanOrEqual(46);
  const compactHighlightColor = editor.getByRole('button', {
    name: /^Highlight color:/,
  });
  await compactHighlightColor.click();
  const compactPalette = editor.getByRole('group', {
    name: 'Highlight color palette',
  });
  const compactOrange = compactPalette.getByRole('button', {
    name: 'Orange highlight color',
  });
  await expect(compactPalette).toBeVisible();
  await expect(compactOrange).toBeFocused();
  await compactOrange.press('Escape');
  await expect(compactPalette).toBeHidden();
  await expect(compactHighlightColor).toBeFocused();
  await compactHighlightColor.click();
  await expect(compactPalette).toBeVisible();
  const compactAccessibility = await new AxeBuilder({ page })
    .include('[data-testid="annotation-dashboard"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    compactAccessibility.violations.map((violation) => violation.id),
  ).toEqual([]);
  await compactHighlightColor.click();
  await page.setViewportSize({ width: 1280, height: 720 });
  const underlineColor = editor.getByRole('button', {
    name: /^Underline color:/,
  });
  await expect(underlineColor).toHaveAccessibleName(
    'Underline color: Sky blue',
  );
  await underlineColor.click();
  await page
    .getByLabel('Custom underline color')
    .evaluate((input: HTMLInputElement) => {
      input.value = '#7c3aed';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await expect(underlineColor).toHaveAccessibleName(
    'Underline color: Custom #7C3AED',
  );
  await editor.getByRole('button', { name: 'Add note' }).click();
  await editor
    .getByRole('textbox', { name: 'Note' })
    .fill('Review this EPUB term.');
  await editor.getByRole('button', { name: 'Underline', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect
    .poll(() => epubAnnotationRendering(paragraph))
    .toEqual(
      expect.objectContaining({
        size: 2,
        rangeTexts: ['EPUB', 'first EPUB fixture'],
      }),
    );
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor).toBeHidden();

  await expect
    .poll(() => epubAnnotationRendering(paragraph))
    .toEqual(
      expect.objectContaining({
        size: 2,
        rangeTexts: ['EPUB', 'first EPUB fixture'],
      }),
    );
  const layeredRendering = await epubAnnotationRendering(paragraph);
  expect(layeredRendering.rules).toContain('background-color');
  expect(layeredRendering.rules).toContain('text-decoration-line: underline');
  expect(layeredRendering.rules).toContain('#7c3aed');
  expect(layeredRendering.rules).not.toContain('stroke:');
  expect(layeredRendering.svgOverlayCount).toBe(0);

  const noteMarker = page
    .getByTestId('publication-viewport')
    .frameLocator('iframe')
    .getByRole('button', { name: 'Open note: Review this EPUB term.' });
  await expect(noteMarker).toBeVisible();
  await noteMarker.click();
  const noteEditor = page.getByTestId('annotation-dashboard');
  await expect(noteEditor).toBeVisible();
  await expect(noteEditor.getByRole('textbox', { name: 'Note' })).toHaveValue(
    'Review this EPUB term.',
  );
  await noteEditor.getByRole('button', { name: 'Close' }).click();

  const updatedEpubCoordinates = await selectEpubText(page, 'EPUB');
  await paragraph.evaluate((element) => {
    element.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
    element.ownerDocument.dispatchEvent(new Event('selectionchange'));
  });
  await page.mouse.click(updatedEpubCoordinates.x, updatedEpubCoordinates.y);
  const formattingDialog = page.getByRole('dialog', {
    name: 'Formatting on this text',
  });
  await expect(formattingDialog).toBeVisible();
  await expect(
    formattingDialog.getByRole('button', {
      name: 'Remove highlight from selected text',
    }),
  ).toBeVisible();
  await formattingDialog
    .getByRole('button', {
      name: 'Remove underline from selected text',
    })
    .click();

  await expect
    .poll(() => epubAnnotationRendering(paragraph))
    .toEqual(
      expect.objectContaining({
        size: 1,
        rangeTexts: ['first EPUB fixture'],
      }),
    );
  await expect(
    formattingDialog.getByRole('button', {
      name: 'Remove highlight from selected text',
    }),
  ).toBeVisible();
  await expect(
    formattingDialog.getByRole('button', {
      name: 'Remove underline from selected text',
    }),
  ).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

async function openEpubSelectionContextMenu(
  page: Page,
  browserName: string,
  coordinates: { x: number; y: number },
): Promise<void> {
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
  } else {
    await page.mouse.click(coordinates.x, coordinates.y, {
      button: 'right',
    });
  }
}

async function selectEpubText(
  page: Page,
  text: string,
): Promise<{ x: number; y: number }> {
  const frame = page.getByTestId('publication-viewport').locator('iframe');
  const paragraph = page
    .getByTestId('publication-viewport')
    .frameLocator('iframe')
    .locator('p')
    .filter({ hasText: text })
    .first();
  const selectionPoint = await paragraph.evaluate((element, selectedText) => {
    const walker = element.ownerDocument.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
    );
    let node = walker.nextNode();
    while (node && !node.textContent?.includes(selectedText)) {
      node = walker.nextNode();
    }
    if (!node?.textContent) {
      throw new Error(`Unable to select "${selectedText}"`);
    }
    const startOffset = node.textContent.indexOf(selectedText);
    const range = element.ownerDocument.createRange();
    range.setStart(node, startOffset);
    range.setEnd(node, startOffset + selectedText.length);
    const selection = element.ownerDocument.defaultView?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.ownerDocument.dispatchEvent(new Event('selectionchange'));
    const rect = range.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }, text);
  const frameBox = await frame.boundingBox();
  if (!frameBox) {
    throw new Error('The EPUB frame has no browser coordinates');
  }
  await expect
    .poll(() =>
      paragraph.evaluate(
        (element) =>
          element.ownerDocument.defaultView?.getSelection()?.toString() ?? '',
      ),
    )
    .toBe(text);
  return {
    x: frameBox.x + selectionPoint.x,
    y: frameBox.y + selectionPoint.y,
  };
}

async function epubAnnotationRendering(
  paragraph: ReturnType<Page['locator']>,
): Promise<{
  size: number;
  rangeTexts: string[];
  rules: string;
  svgOverlayCount: number;
}> {
  return paragraph.evaluate((element) => {
    const view = element.ownerDocument.defaultView;
    const registry = view?.CSS?.highlights;
    const rangeTexts = registry
      ? Array.from(registry.values()).flatMap((highlight) =>
          Array.from(highlight).map((range) => range.toString()),
        )
      : [];
    rangeTexts.sort();
    return {
      size: registry?.size ?? 0,
      rangeTexts,
      rules:
        element.ownerDocument.querySelector<HTMLStyleElement>(
          'style[data-omnia-annotation-highlights]',
        )?.textContent ?? '',
      svgOverlayCount: element.ownerDocument.querySelectorAll(
        'svg [data-annotation-id]',
      ).length,
    };
  });
}
