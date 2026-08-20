import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  EvidenceValidationError,
  assertEnvironmentRecord,
  assertProfileSet,
} from './performance-contract.mjs';
import { assertManagementWorkload } from './management-workload.mjs';

const CGROUP_ROOT = '/sys/fs/cgroup';
const POWER_SUPPLY_ROOT = '/sys/class/power_supply';

export async function captureSamplingIdentity(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new EvidenceValidationError('must be an object', 'options');
  }
  const profileSet = assertProfileSet(options.profileSet);
  const environment = assertEnvironmentRecord(options.environment, profileSet);
  const workload = assertManagementWorkload(options.workload);
  const runGit = options.runGit ?? defaultRunGit;
  const readText = options.readText ?? defaultReadText;
  const listDirectory = options.listDirectory ?? defaultListDirectory;
  const constraints = await captureHostConstraints({ readText, listDirectory });
  const commit = runGit(['rev-parse', 'HEAD']).trim();
  const dirty =
    runGit(['status', '--porcelain', '--untracked-files=normal']).trim()
      .length > 0;
  const viewport = options.viewport;
  if (
    !viewport ||
    !Number.isSafeInteger(viewport.width) ||
    !Number.isSafeInteger(viewport.height)
  ) {
    throw new EvidenceValidationError(
      'must contain integer width and height',
      'options.viewport',
    );
  }
  return {
    schemaVersion: 1,
    profileSetId: profileSet.profileSetId,
    profileSetDigest: profileSet.profileSetDigest,
    profileId: environment.profileId,
    git: { commit, dirty },
    dataset: {
      recipeDigest: workload.recipeDigest,
      workloadDigest: workload.workloadDigest,
      logicalBooks: workload.logicalBooks,
      exactVariants: workload.exactVariants,
      logicalChangeHistory: workload.logicalChangeHistory,
    },
    browser: {
      name: requiredString(options.browserName, 'options.browserName'),
      version: requiredString(options.browserVersion, 'options.browserVersion'),
    },
    viewport: {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: requiredFinite(
        options.deviceScaleFactor,
        'options.deviceScaleFactor',
      ),
    },
    constraints,
  };
}

export async function captureHostConstraints({ readText, listDirectory }) {
  const cgroup = await effectiveCgroupLimits(readText);
  const powerMode = await currentPowerMode(readText, listDirectory);
  return { ...cgroup, powerMode };
}

async function effectiveCgroupLimits(readText) {
  const membership = await readText('/proc/self/cgroup');
  const unified = membership
    .split(/\r?\n/u)
    .map((line) => line.split(':'))
    .find(
      ([hierarchy, controllers]) => hierarchy === '0' && controllers === '',
    );
  if (!unified || unified.length !== 3) {
    throw new EvidenceValidationError(
      'requires a unified cgroup-v2 membership',
      'samplingIdentity.constraints',
    );
  }
  const segments = unified[2].split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new EvidenceValidationError(
      'contains an invalid cgroup path',
      'samplingIdentity.constraints',
    );
  }
  let current = resolve(CGROUP_ROOT, ...segments);
  const quotas = [];
  const memoryLimits = [];
  while (current.startsWith(CGROUP_ROOT)) {
    const cpu = await optionalText(readText, join(current, 'cpu.max'));
    if (cpu) {
      const [quota, period, extra] = cpu.trim().split(/\s+/u);
      if (extra !== undefined || !period || !/^\d+$/u.test(period)) {
        throw invalidConstraint('cpu.max');
      }
      if (quota !== 'max') {
        if (!/^\d+$/u.test(quota)) throw invalidConstraint('cpu.max');
        const value = Number(quota) / Number(period);
        if (Number.isFinite(value) && value > 0) quotas.push(value);
      }
    }
    const memory = await optionalText(readText, join(current, 'memory.max'));
    if (memory && memory.trim() !== 'max') {
      if (!/^\d+$/u.test(memory.trim())) throw invalidConstraint('memory.max');
      const value = Number(memory.trim());
      if (Number.isSafeInteger(value) && value > 0) memoryLimits.push(value);
    }
    if (current === CGROUP_ROOT) break;
    current = dirname(current);
  }
  if (quotas.length === 0 || memoryLimits.length === 0) {
    throw new EvidenceValidationError(
      'requires finite effective CPU and memory limits',
      'samplingIdentity.constraints',
    );
  }
  return {
    scope: segments.some(
      (segment) => segment.endsWith('.scope') || segment.endsWith('.slice'),
    )
      ? 'systemd-cgroup'
      : 'cgroup-v2',
    cpuQuota: Math.min(...quotas),
    memoryLimitBytes: Math.min(...memoryLimits),
  };
}

async function currentPowerMode(readText, listDirectory) {
  const rawProfile = (
    await readText('/sys/firmware/acpi/platform_profile')
  ).trim();
  const profile =
    rawProfile === 'balanced' || rawProfile === 'balance_performance'
      ? 'balanced'
      : rawProfile;
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(profile)) {
    throw new EvidenceValidationError(
      'contains an invalid platform power profile',
      'samplingIdentity.constraints.powerMode',
    );
  }
  let online = false;
  for (const name of await listDirectory(POWER_SUPPLY_ROOT)) {
    const root = join(POWER_SUPPLY_ROOT, name);
    const type = (await optionalText(readText, join(root, 'type')))?.trim();
    if (!['Mains', 'USB', 'USB_C', 'USB_PD'].includes(type)) continue;
    if ((await optionalText(readText, join(root, 'online')))?.trim() === '1') {
      online = true;
      break;
    }
  }
  return `${profile}-${online ? 'ac' : 'battery'}`;
}

async function optionalText(readText, path) {
  try {
    return await readText(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function invalidConstraint(name) {
  return new EvidenceValidationError(
    `contains an invalid ${name}`,
    'samplingIdentity.constraints',
  );
}

function requiredString(value, path) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new EvidenceValidationError('must be a bounded string', path);
  }
  return value;
}

function requiredFinite(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new EvidenceValidationError('must be a positive finite number', path);
  }
  return value;
}

function defaultRunGit(arguments_) {
  const result = spawnSync('git', arguments_, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Unable to capture Git state');
  }
  return result.stdout;
}

function defaultReadText(path) {
  return readFile(path, 'utf8');
}

function defaultListDirectory(path) {
  return readdir(path);
}
