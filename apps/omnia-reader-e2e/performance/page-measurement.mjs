import {
  EvidenceValidationError,
  assertExactKeys,
  assertOneOf,
  assertRecord,
  assertSafeInteger,
  assertString,
} from './performance-contract.mjs';

const STATE_KEY = '__omniaPageMeasurementV1';

export class PageMeasurementError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PageMeasurementError';
  }
}

export function assertPageMeasurementSpec(value) {
  assertRecord(value, 'pageMeasurement');
  assertExactKeys(
    value,
    ['activation', 'acknowledgement', 'finalState', 'timeoutMs'],
    'pageMeasurement',
  );
  assertBoundary(value.activation, 'pageMeasurement.activation', true);
  assertBoundary(
    value.acknowledgement,
    'pageMeasurement.acknowledgement',
    false,
  );
  assertBoundary(value.finalState, 'pageMeasurement.finalState', false);
  assertSafeInteger(value.timeoutMs, 1, 60_000, 'pageMeasurement.timeoutMs');
  return value;
}

export async function measurePageAction(page, specInput, activate) {
  const spec = assertPageMeasurementSpec(specInput);
  if (!page || typeof page.evaluate !== 'function') {
    throw new EvidenceValidationError(
      'page must provide Playwright evaluate()',
      'page',
    );
  }
  if (typeof activate !== 'function') {
    throw new EvidenceValidationError(
      'activate must be a function',
      'activate',
    );
  }

  await page.evaluate(installMeasurement, { ...spec, stateKey: STATE_KEY });
  try {
    const activationOutcome = Promise.resolve()
      .then(activate)
      .then(
        () => ({ kind: 'activated' }),
        (error) => ({ kind: 'activation-error', error }),
      );
    const completionOutcome = page
      .waitForFunction(
        (stateKey) => {
          const state = window[stateKey];
          return state?.status === 'complete' || state?.status === 'error';
        },
        STATE_KEY,
        { timeout: spec.timeoutMs + 1_000 },
      )
      .then(
        () => ({ kind: 'completed' }),
        (error) => ({ kind: 'completion-error', error }),
      );
    const first = await Promise.race([activationOutcome, completionOutcome]);
    if (
      first.kind === 'activation-error' ||
      first.kind === 'completion-error'
    ) {
      throw first.error;
    }
    if (first.kind === 'activated') {
      const completion = await completionOutcome;
      if (completion.kind === 'completion-error') throw completion.error;
    }
    const snapshot = await page.evaluate((stateKey) => {
      const state = window[stateKey];
      return state
        ? {
            status: state.status,
            error: state.error,
            result: state.result,
          }
        : null;
    }, STATE_KEY);
    if (!snapshot) {
      throw new PageMeasurementError('page measurement state was lost');
    }
    if (snapshot.status !== 'complete') {
      throw new PageMeasurementError(
        snapshot.error || 'page measurement failed',
      );
    }
    assertMeasurementResult(snapshot.result);
    return snapshot.result;
  } finally {
    await page
      .evaluate((stateKey) => {
        const state = window[stateKey];
        state?.cleanup?.();
        delete window[stateKey];
      }, STATE_KEY)
      .catch(() => undefined);
  }
}

function assertBoundary(value, path, activation) {
  assertRecord(value, path);
  assertExactKeys(
    value,
    activation ? ['event', 'selector'] : ['selector'],
    path,
  );
  if (activation) {
    assertOneOf(value.event, ['click', 'change', 'input'], `${path}.event`);
  }
  assertString(value.selector, 1, 1_024, `${path}.selector`);
}

function assertMeasurementResult(value) {
  assertRecord(value, 'pageMeasurement.result');
  assertExactKeys(
    value,
    ['activationEvent', 'acknowledgementMs', 'finalResultMs'],
    'pageMeasurement.result',
  );
  if (
    !['click', 'change', 'input'].includes(value.activationEvent) ||
    typeof value.acknowledgementMs !== 'number' ||
    !Number.isFinite(value.acknowledgementMs) ||
    value.acknowledgementMs < 0 ||
    typeof value.finalResultMs !== 'number' ||
    !Number.isFinite(value.finalResultMs) ||
    value.finalResultMs < value.acknowledgementMs
  ) {
    throw new PageMeasurementError(
      'page returned invalid activation or timing values',
    );
  }
}

function installMeasurement(spec) {
  const previous = window[spec.stateKey];
  previous?.cleanup?.();

  const state = {
    status: 'pending',
    error: null,
    result: null,
    startedAt: null,
    acknowledgementMs: null,
    finalResultMs: null,
    acknowledgementFramePending: false,
    finalFramePending: false,
    cleanup: null,
  };

  const visible = (selector) => {
    let element;
    try {
      element = document.querySelector(selector);
    } catch {
      finishError('page measurement contains an invalid selector');
      return false;
    }
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0'
    ) {
      return false;
    }
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  };

  const completeIfReady = () => {
    if (
      state.status !== 'pending' ||
      state.acknowledgementMs === null ||
      state.finalResultMs === null
    ) {
      return;
    }
    if (state.finalResultMs < state.acknowledgementMs) {
      finishError('final state became eligible before acknowledgement');
      return;
    }
    state.status = 'complete';
    state.result = {
      activationEvent: spec.activation.event,
      acknowledgementMs: state.acknowledgementMs,
      finalResultMs: state.finalResultMs,
    };
  };

  const scheduleVisibleCapture = (kind, selector) => {
    const pendingKey = `${kind}FramePending`;
    const valueKey = `${kind}Ms`;
    if (
      state.status !== 'pending' ||
      state.startedAt === null ||
      state[valueKey] !== null ||
      state[pendingKey] ||
      !visible(selector)
    ) {
      return;
    }
    state[pendingKey] = true;
    requestAnimationFrame(() => {
      state[pendingKey] = false;
      if (
        state.status === 'pending' &&
        state.startedAt !== null &&
        state[valueKey] === null &&
        visible(selector)
      ) {
        state[valueKey] = performance.now() - state.startedAt;
        completeIfReady();
      }
    });
  };

  const inspect = () => {
    if (state.startedAt === null || state.status !== 'pending') return;
    scheduleVisibleCapture('acknowledgement', spec.acknowledgement.selector);
    scheduleVisibleCapture('finalResult', spec.finalState.selector);
  };

  const activate = (event) => {
    if (state.startedAt !== null || event.type !== spec.activation.event)
      return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    let activated;
    try {
      activated = target.closest(spec.activation.selector);
    } catch {
      finishError('page measurement contains an invalid activation selector');
      return;
    }
    if (!activated) return;
    state.startedAt = performance.now();
    inspect();
  };

  const finishError = (message) => {
    if (state.status !== 'pending') return;
    state.status = 'error';
    state.error = message;
  };

  const observer = new MutationObserver(inspect);
  observer.observe(document.documentElement, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  document.addEventListener(spec.activation.event, activate, true);
  const detachedInputListeners = new Map();
  let restoreDetachedInputActivation = () => undefined;
  if (
    spec.activation.event === 'change' &&
    typeof HTMLInputElement !== 'undefined'
  ) {
    const originalClick = HTMLInputElement.prototype.click;
    const instrumentedClick = function (...arguments_) {
      let matches = false;
      try {
        matches = this.matches(spec.activation.selector);
      } catch {
        finishError('page measurement contains an invalid activation selector');
      }
      if (matches) {
        const previousListener = detachedInputListeners.get(this);
        if (previousListener) {
          this.removeEventListener('change', previousListener, true);
        }
        const listener = (event) => {
          detachedInputListeners.delete(this);
          activate(event);
        };
        detachedInputListeners.set(this, listener);
        this.addEventListener('change', listener, {
          capture: true,
          once: true,
        });
      }
      return originalClick.apply(this, arguments_);
    };
    HTMLInputElement.prototype.click = instrumentedClick;
    restoreDetachedInputActivation = () => {
      if (HTMLInputElement.prototype.click === instrumentedClick) {
        HTMLInputElement.prototype.click = originalClick;
      }
    };
  }
  const timeout = setTimeout(() => {
    if (state.startedAt === null) {
      finishError('page measurement timed out before activation');
    } else {
      const missing = [];
      if (state.acknowledgementMs === null) missing.push('acknowledgement');
      if (state.finalResultMs === null) missing.push('final state');
      finishError(`page measurement timed out before ${missing.join(' and ')}`);
    }
  }, spec.timeoutMs);
  state.cleanup = () => {
    clearTimeout(timeout);
    observer.disconnect();
    document.removeEventListener(spec.activation.event, activate, true);
    for (const [input, listener] of detachedInputListeners) {
      input.removeEventListener('change', listener, true);
    }
    detachedInputListeners.clear();
    restoreDetachedInputActivation();
  };
  window[spec.stateKey] = state;
}
