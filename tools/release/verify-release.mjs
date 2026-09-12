import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  aggregateSyncEvidence,
  loadSyncEvidence,
  validateSyncEvidence,
} from './verify-sync-evidence.mjs';

export const REVIEWED_LICENSE_EXPRESSIONS = new Set([
  '(MIT OR Apache-2.0) AND Unicode-3.0',
  '0BSD OR MIT OR Apache-2.0',
  'Apache-2.0',
  'Apache-2.0 / MIT',
  'Apache-2.0 AND ISC',
  'Apache-2.0 AND MIT',
  'Apache-2.0 OR ISC OR MIT',
  'Apache-2.0 OR MIT',
  'Apache-2.0 WITH LLVM-exception',
  'Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT',
  'Apache-2.0/MIT',
  'BSD-2-Clause',
  'BSD-2-Clause OR Apache-2.0 OR MIT',
  'BSD-3-Clause',
  'BSD-3-Clause AND MIT',
  'BSD-3-Clause OR MIT OR Apache-2.0',
  'BSD-3-Clause/MIT',
  'CC0-1.0',
  'CC0-1.0 OR MIT-0 OR Apache-2.0',
  'CDLA-Permissive-2.0',
  'ISC',
  'ISC AND (Apache-2.0 OR ISC)',
  'ISC AND (Apache-2.0 OR ISC) AND Apache-2.0 AND MIT AND BSD-3-Clause AND (Apache-2.0 OR ISC OR MIT) AND (Apache-2.0 OR ISC OR MIT-0)',
  'MIT',
  'MIT OR Apache-2.0',
  'MIT OR Apache-2.0 OR LGPL-2.1-or-later',
  'MIT OR Apache-2.0 OR Zlib',
  'MIT OR Zlib OR Apache-2.0',
  'MIT/Apache-2.0',
  'MPL-2.0',
  'OFL-1.1',
  'Unicode-3.0',
  'Unlicense OR MIT',
  'Unlicense/MIT',
  'Zlib',
  'Zlib OR Apache-2.0 OR MIT',
]);

const BRIDGE_SOURCE_LICENSES = new Map([
  ['mega_sdk', 'BSD-2-Clause'],
  ['cpp_httplib', 'MIT'],
  ['nlohmann_json', 'MIT'],
]);

const DEFAULT_ARTIFACT_ROOTS = [
  {
    directory: 'dist/apps/omnia-reader/browser',
    prefix: 'apps/omnia-reader/browser',
  },
  {
    directory: 'dist/apps/sync-gateway',
    prefix: 'apps/sync-gateway',
  },
];
const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function executable(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(executable(command), args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = options.capture
      ? `\n${result.stderr || result.stdout}`.trimEnd()
      : '';
    throw new Error(
      `${options.label ?? command} failed with exit code ${result.status}.${details}`,
    );
  }

  return result.stdout;
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} did not return valid JSON.`, { cause: error });
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizePath(value) {
  return value.split(sep).join('/');
}

export function parseCargoPackage(cargoToml) {
  const packageHeader = cargoToml.match(/^\[package\]\s*$/m);
  const packageRemainder = packageHeader
    ? cargoToml.slice(packageHeader.index + packageHeader[0].length)
    : '';
  const nextSectionOffset = packageRemainder.search(/^\[/m);
  const packageSection =
    nextSectionOffset === -1
      ? packageRemainder
      : packageRemainder.slice(0, nextSectionOffset);
  assert(packageSection, 'Cargo.toml is missing a [package] section.');

  const field = (name) =>
    packageSection.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm'))?.[1];
  const name = field('name');
  const version = field('version');
  const license = field('license');

  assert(name, 'Cargo.toml [package] is missing name.');
  assert(version, 'Cargo.toml [package] is missing version.');
  assert(license, 'Cargo.toml [package] is missing license.');
  return { name, version, license };
}

export function parseBridgeDependencies(cmakeLists, dockerfile) {
  const project = cmakeLists.match(
    /project\(\s*([A-Za-z0-9_-]+)[\s\S]*?\bVERSION\s+([0-9A-Za-z.-]+)[\s\S]*?\)/,
  );
  assert(project, 'MEGA bridge CMake project name/version could not be read.');

  const sources = [
    ...cmakeLists.matchAll(
      /FetchContent_Declare\(\s*([A-Za-z0-9_-]+)([\s\S]*?)\)/g,
    ),
  ].map((match) => {
    const name = match[1];
    const body = match[2];
    const repository = body.match(/\bGIT_REPOSITORY\s+(\S+)/)?.[1];
    const revision = body.match(/\bGIT_TAG\s+(\S+)/)?.[1];
    assert(repository, `${name} is missing GIT_REPOSITORY.`);
    assert(
      revision && /^[a-f0-9]{40}$/.test(revision),
      `${name} must use a full immutable Git commit.`,
    );
    const license = BRIDGE_SOURCE_LICENSES.get(name);
    assert(license, `${name} is missing a reviewed source license.`);
    return { name, repository, revision, license };
  });
  assert(
    sources.length === BRIDGE_SOURCE_LICENSES.size &&
      new Set(sources.map((source) => source.name)).size === sources.length &&
      [...BRIDGE_SOURCE_LICENSES.keys()].every((name) =>
        sources.some((source) => source.name === name),
      ),
    'MEGA bridge source dependency declarations changed; review their pins and licenses.',
  );

  const baseImage = dockerfile.match(/^ARG UBUNTU_IMAGE=(\S+)$/m)?.[1];
  const baseImageMatch = baseImage?.match(
    /^([^:@]+):([^@]+)@sha256:([a-f0-9]{64})$/,
  );
  assert(
    baseImageMatch,
    'MEGA bridge base image must include a tag and immutable SHA-256 digest.',
  );

  return {
    name: project[1],
    version: project[2],
    sources,
    baseImage: {
      name: baseImageMatch[1],
      version: baseImageMatch[2],
      digest: baseImageMatch[3],
      reference: baseImage,
    },
  };
}

export function validateVersionCoherence(versions) {
  const entries = Object.entries(versions);
  assert(entries.length > 0, 'No release versions were supplied.');

  for (const [source, version] of entries) {
    assert(
      typeof version === 'string' &&
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
          version,
        ),
      `${source} has an invalid semantic version: ${String(version)}`,
    );
  }

  const expected = entries[0][1];
  const mismatches = entries.filter(([, version]) => version !== expected);
  assert(
    mismatches.length === 0,
    `Release versions differ: ${entries
      .map(([source, version]) => `${source}=${version}`)
      .join(', ')}`,
  );
  return expected;
}

export function validateLicenses(records, source) {
  const violations = [];

  for (const record of records) {
    const expressions = record.expressions
      .map((expression) => expression?.trim())
      .filter(Boolean);
    if (expressions.length === 0) {
      violations.push(`${record.name}: missing license`);
      continue;
    }

    for (const expression of expressions) {
      if (!REVIEWED_LICENSE_EXPRESSIONS.has(expression)) {
        violations.push(`${record.name}: ${expression}`);
      }
    }
  }

  assert(
    violations.length === 0,
    `${source} contains unreviewed dependency licenses:\n${violations
      .sort()
      .map((violation) => `- ${violation}`)
      .join('\n')}`,
  );
}

export function validateWorkflowActionPins(workflows) {
  const references = [];

  for (const workflow of workflows) {
    for (const match of workflow.contents.matchAll(
      /^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm,
    )) {
      const reference = match[1];
      if (reference.startsWith('./')) {
        continue;
      }
      assert(
        /^[^@\s]+@[a-f0-9]{40}$/.test(reference),
        `${workflow.path} action must use a full immutable Git commit: ${reference}`,
      );
      references.push(reference);
    }
  }

  assert(references.length > 0, 'No pinned CI actions were found.');
  return [...new Set(references)].sort();
}

function npmLicenseRecords(sbom) {
  return (sbom.components ?? []).map((component) => ({
    name: `${component.name}@${component.version}`,
    expressions: (component.licenses ?? []).map(
      (entry) =>
        entry.expression ?? entry.license?.id ?? entry.license?.name ?? '',
    ),
  }));
}

function cargoLicenseRecords(metadata) {
  return metadata.packages.map((pkg) => ({
    name: `${pkg.name}@${pkg.version}`,
    expressions: [pkg.license ?? ''],
  }));
}

export function normalizeNpmSbom(sbom) {
  assert(sbom.bomFormat === 'CycloneDX', 'npm SBOM is not CycloneDX.');
  assert(sbom.specVersion, 'npm SBOM is missing a specification version.');
  assert(Array.isArray(sbom.components), 'npm SBOM is missing components.');

  const normalized = structuredClone(sbom);
  delete normalized.serialNumber;
  if (normalized.metadata) {
    delete normalized.metadata.timestamp;
  }
  normalized.components.sort((left, right) =>
    String(left['bom-ref'] ?? left.name).localeCompare(
      String(right['bom-ref'] ?? right.name),
    ),
  );
  normalized.dependencies = (normalized.dependencies ?? [])
    .map((dependency) => ({
      ...dependency,
      dependsOn: [...(dependency.dependsOn ?? [])].sort(),
    }))
    .sort((left, right) => String(left.ref).localeCompare(String(right.ref)));
  return normalized;
}

function normalizeSpdxExpression(expression) {
  return expression
    .replaceAll(' / ', ' OR ')
    .replaceAll('/', ' OR ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cargoBomRef(pkg) {
  return `pkg:cargo/${encodeURIComponent(pkg.name)}@${encodeURIComponent(
    pkg.version,
  )}`;
}

export function createRustSbom(metadata) {
  assert(metadata.resolve?.root, 'Cargo metadata is missing its root package.');
  const packageById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const root = packageById.get(metadata.resolve.root);
  assert(root, 'Cargo metadata root package could not be resolved.');

  const componentFor = (pkg, type = 'library') => ({
    type,
    'bom-ref': cargoBomRef(pkg),
    name: pkg.name,
    version: pkg.version,
    licenses: [
      {
        expression: normalizeSpdxExpression(pkg.license),
      },
    ],
    purl: cargoBomRef(pkg),
  });

  const components = metadata.packages
    .filter((pkg) => pkg.id !== root.id)
    .map((pkg) => componentFor(pkg))
    .sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']));

  const dependencies = metadata.resolve.nodes
    .map((node) => {
      const pkg = packageById.get(node.id);
      assert(pkg, `Cargo dependency node ${node.id} is unknown.`);
      return {
        ref: cargoBomRef(pkg),
        dependsOn: node.dependencies
          .map((dependencyId) => {
            const dependency = packageById.get(dependencyId);
            assert(dependency, `Cargo dependency ${dependencyId} is unknown.`);
            return cargoBomRef(dependency);
          })
          .sort(),
      };
    })
    .sort((left, right) => left.ref.localeCompare(right.ref));

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: componentFor(root, 'application'),
    },
    components,
    dependencies,
  };
}

export function createBridgeSourceSbom(bridge) {
  const rootRef = `pkg:generic/${bridge.name}@${bridge.version}`;
  const sourceComponents = bridge.sources.map((source) => {
    const repository = new URL(source.repository);
    const repositoryPath = repository.pathname
      .replace(/^\/|\.git$/g, '')
      .split('/');
    assert(
      repository.hostname === 'github.com' && repositoryPath.length === 2,
      `${source.name} must use a GitHub source repository.`,
    );
    const purl = `pkg:github/${repositoryPath[0]}/${repositoryPath[1]}@${source.revision}`;
    return {
      type: 'library',
      'bom-ref': purl,
      name: source.name,
      version: source.revision,
      licenses: [{ license: { id: source.license } }],
      purl,
      externalReferences: [
        {
          type: 'vcs',
          url: `${source.repository}#${source.revision}`,
        },
      ],
    };
  });
  const containerRef = `urn:omnia:container:${bridge.baseImage.reference}`;
  const components = [
    ...sourceComponents,
    {
      type: 'container',
      'bom-ref': containerRef,
      name: bridge.baseImage.name,
      version: bridge.baseImage.version,
      hashes: [
        {
          alg: 'SHA-256',
          content: bridge.baseImage.digest,
        },
      ],
      properties: [
        {
          name: 'omnia:container-reference',
          value: bridge.baseImage.reference,
        },
      ],
    },
  ].sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']));

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: bridge.name,
        version: bridge.version,
        licenses: [{ license: { id: 'MIT' } }],
        purl: rootRef,
      },
    },
    components,
    dependencies: [
      {
        ref: rootRef,
        dependsOn: components.map((component) => component['bom-ref']).sort(),
      },
      ...components.map((component) => ({
        ref: component['bom-ref'],
        dependsOn: [],
      })),
    ],
  };
}

async function sha256File(filePath) {
  const contents = await readFile(filePath);
  return createHash('sha256').update(contents).digest('hex');
}

async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Release artifacts cannot contain symlinks: ${entryPath}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function loadWorkflowSources(workspaceRoot) {
  const directory = join(workspaceRoot, '.github/workflows');
  const entries = await readdir(directory, { withFileTypes: true });
  const workflowNames = entries
    .filter((entry) => entry.isFile() && /\.(?:yaml|yml)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert(workflowNames.length > 0, 'No GitHub Actions workflows were found.');
  return Promise.all(
    workflowNames.map(async (name) => ({
      path: `.github/workflows/${name}`,
      contents: await readFile(join(directory, name), 'utf8'),
    })),
  );
}

export async function collectArtifactFiles(workspaceRoot, roots) {
  const files = [];

  for (const root of roots) {
    const directory = resolve(workspaceRoot, root.directory);
    const stats = await lstat(directory).catch(() => null);
    assert(
      stats?.isDirectory(),
      `Required release artifact directory is missing: ${root.directory}`,
    );

    for (const filePath of await walkFiles(directory)) {
      const relativePath = normalizePath(relative(directory, filePath));
      files.push({
        path: `${root.prefix}/${relativePath}`,
        bytes: (await lstat(filePath)).size,
        sha256: await sha256File(filePath),
      });
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function assertAuditClean(audit) {
  const vulnerabilities = audit.metadata?.vulnerabilities;
  assert(vulnerabilities, 'npm audit output is missing vulnerability totals.');
  assert(
    vulnerabilities.total === 0,
    `Production dependency audit found ${vulnerabilities.total} vulnerabilities.`,
  );
}

export function validateReleaseSyncEvidence(evidence, { commit, version }) {
  validateSyncEvidence(evidence);
  assert(
    evidence.result === 'accepted' &&
      aggregateSyncEvidence(evidence).result === 'accepted',
    'Synchronization evidence must be explicitly accepted.',
  );
  assert(
    typeof commit === 'string' && FULL_GIT_COMMIT.test(commit),
    'Release source commit must be a full lowercase Git commit.',
  );
  assert(
    evidence.candidate.commit === commit,
    'Synchronization evidence commit does not match the release source.',
  );
  assert(
    evidence.candidate.release === version,
    'Synchronization evidence release does not match the package version.',
  );
  return evidence;
}

export function assertCleanReleaseSource(statusOutput) {
  assert(
    typeof statusOutput === 'string' && statusOutput.trim() === '',
    'Accepted synchronization evidence requires a clean source checkout.',
  );
}

export async function prepareSyncEvidenceInput(
  workspaceRoot,
  syncEvidencePath,
) {
  const generatedPath = resolve(
    workspaceRoot,
    'dist/release/sync-evidence.json',
  );
  const resolvedInput = syncEvidencePath
    ? resolve(workspaceRoot, syncEvidencePath)
    : null;
  await rm(generatedPath, { force: true });
  assert(
    resolvedInput !== generatedPath,
    'Synchronization evidence input must differ from the generated release output.',
  );
  return resolvedInput;
}

async function loadReleaseMetadata(workspaceRoot) {
  const [
    packageJson,
    packageLock,
    cargoToml,
    tauriConfig,
    bridgeCmake,
    bridgeDockerfile,
    workflows,
  ] = await Promise.all([
    readFile(join(workspaceRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(workspaceRoot, 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(join(workspaceRoot, 'src-tauri/Cargo.toml'), 'utf8'),
    readFile(join(workspaceRoot, 'src-tauri/tauri.conf.json'), 'utf8').then(
      JSON.parse,
    ),
    readFile(
      join(workspaceRoot, 'tools/mega-sdk-bridge/CMakeLists.txt'),
      'utf8',
    ),
    readFile(join(workspaceRoot, 'tools/mega-sdk-bridge/Dockerfile'), 'utf8'),
    loadWorkflowSources(workspaceRoot),
  ]);
  const cargoPackage = parseCargoPackage(cargoToml);
  const bridge = parseBridgeDependencies(bridgeCmake, bridgeDockerfile);
  const workflowActionPins = validateWorkflowActionPins(workflows);
  const version = validateVersionCoherence({
    'package.json': packageJson.version,
    'package-lock.json': packageLock.version,
    'package-lock.json root': packageLock.packages?.['']?.version,
    'Cargo.toml': cargoPackage.version,
    'tauri.conf.json': tauriConfig.version,
    'MEGA bridge CMakeLists.txt': bridge.version,
  });
  validateLicenses(
    [
      { name: packageJson.name, expressions: [packageJson.license] },
      { name: cargoPackage.name, expressions: [cargoPackage.license] },
      ...bridge.sources.map((source) => ({
        name: source.name,
        expressions: [source.license],
      })),
    ],
    'First-party packages',
  );
  return { version, bridge, workflowActionPins };
}

export async function writeReleaseOutputs(
  workspaceRoot,
  version,
  npmSbom,
  rustSbom,
  bridgeSbom,
  syncEvidence = null,
) {
  const releaseDirectory = join(workspaceRoot, 'dist/release');
  await mkdir(releaseDirectory, { recursive: true });
  const npmSbomPath = join(releaseDirectory, 'npm.cdx.json');
  const rustSbomPath = join(releaseDirectory, 'rust.cdx.json');
  const bridgeSbomPath = join(releaseDirectory, 'bridge-source.cdx.json');
  await writeFile(npmSbomPath, stableJson(npmSbom), 'utf8');
  await writeFile(rustSbomPath, stableJson(rustSbom), 'utf8');
  await writeFile(bridgeSbomPath, stableJson(bridgeSbom), 'utf8');
  const syncEvidencePath = join(releaseDirectory, 'sync-evidence.json');
  if (syncEvidence) {
    await writeFile(syncEvidencePath, stableJson(syncEvidence), 'utf8');
  } else {
    await rm(syncEvidencePath, { force: true });
  }

  const files = await collectArtifactFiles(workspaceRoot, [
    ...DEFAULT_ARTIFACT_ROOTS,
    {
      directory: 'dist/release',
      prefix: 'release',
    },
  ]);
  const checksummedFiles = files.filter(
    (file) =>
      file.path !== 'release/SHA256SUMS' &&
      file.path !== 'release/release-manifest.json',
  );
  const manifest = {
    schemaVersion: 1,
    product: 'Omnia Reader',
    version,
    digestAlgorithm: 'SHA-256',
    files: checksummedFiles,
  };
  await writeFile(
    join(releaseDirectory, 'release-manifest.json'),
    stableJson(manifest),
    'utf8',
  );
  await writeFile(
    join(releaseDirectory, 'SHA256SUMS'),
    `${checksummedFiles
      .map((file) => `${file.sha256}  ${file.path}`)
      .join('\n')}\n`,
    'utf8',
  );
  return manifest;
}

export async function verifyRelease({
  workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  skipBuild = false,
  syncEvidencePath = null,
} = {}) {
  const resolvedSyncEvidencePath = await prepareSyncEvidenceInput(
    workspaceRoot,
    syncEvidencePath,
  );
  const { version, bridge, workflowActionPins } =
    await loadReleaseMetadata(workspaceRoot);

  let syncEvidence = null;
  if (resolvedSyncEvidencePath) {
    assertCleanReleaseSource(
      runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        capture: true,
        cwd: workspaceRoot,
        label: 'Release source status',
      }),
    );
    const commit = runCommand('git', ['rev-parse', '--verify', 'HEAD'], {
      capture: true,
      cwd: workspaceRoot,
      label: 'Release source commit',
    }).trim();
    syncEvidence = validateReleaseSyncEvidence(
      await loadSyncEvidence(resolvedSyncEvidencePath),
      { commit, version },
    );
  }

  if (!skipBuild) {
    runCommand(
      'npx',
      [
        'nx',
        'build',
        'omnia-reader',
        '--configuration',
        'production',
        '--skip-nx-cache',
      ],
      { cwd: workspaceRoot, label: 'Web production build' },
    );
    runCommand(
      'npx',
      [
        'nx',
        'build',
        'sync-gateway',
        '--configuration',
        'production',
        '--skip-nx-cache',
      ],
      { cwd: workspaceRoot, label: 'Gateway production build' },
    );
  }

  const audit = parseJsonOutput(
    runCommand('npm', ['audit', '--omit=dev', '--json'], {
      capture: true,
      cwd: workspaceRoot,
      label: 'Production npm audit',
    }),
    'npm audit',
  );
  assertAuditClean(audit);

  const npmSbom = normalizeNpmSbom(
    parseJsonOutput(
      runCommand(
        'npm',
        [
          'sbom',
          '--sbom-format',
          'cyclonedx',
          '--package-lock-only',
          '--omit=dev',
        ],
        {
          capture: true,
          cwd: workspaceRoot,
          label: 'npm CycloneDX generation',
        },
      ),
      'npm sbom',
    ),
  );
  validateLicenses(npmLicenseRecords(npmSbom), 'npm SBOM');

  const cargoMetadata = parseJsonOutput(
    runCommand(
      'cargo',
      [
        'metadata',
        '--locked',
        '--format-version',
        '1',
        '--manifest-path',
        'src-tauri/Cargo.toml',
      ],
      {
        capture: true,
        cwd: workspaceRoot,
        label: 'Cargo dependency metadata',
      },
    ),
    'cargo metadata',
  );
  validateLicenses(cargoLicenseRecords(cargoMetadata), 'Cargo metadata');
  const rustSbom = createRustSbom(cargoMetadata);
  const bridgeSbom = createBridgeSourceSbom(bridge);

  const manifest = await writeReleaseOutputs(
    workspaceRoot,
    version,
    npmSbom,
    rustSbom,
    bridgeSbom,
    syncEvidence,
  );
  return {
    version,
    fileCount: manifest.files.length,
    npmComponents: npmSbom.components.length,
    rustComponents: rustSbom.components.length,
    bridgeComponents: bridgeSbom.components.length,
    workflowActionPins: workflowActionPins.length,
    syncEvidenceIncluded: syncEvidence !== null,
  };
}

export function parseReleaseArguments(args) {
  let skipBuild = false;
  let syncEvidencePath = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--skip-build') {
      assert(!skipBuild, '--skip-build may be provided only once.');
      skipBuild = true;
      continue;
    }
    if (argument === '--sync-evidence') {
      assert(
        syncEvidencePath === null,
        '--sync-evidence may be provided only once.',
      );
      const filePath = args[index + 1];
      assert(
        filePath && !filePath.startsWith('--'),
        '--sync-evidence requires a file path.',
      );
      syncEvidencePath = filePath;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { skipBuild, syncEvidencePath };
}

async function main() {
  const result = await verifyRelease(
    parseReleaseArguments(process.argv.slice(2)),
  );
  console.log(
    `Release ${result.version} verified: ${result.fileCount} files, ` +
      `${result.npmComponents} npm components, ` +
      `${result.rustComponents} Rust components, ` +
      `${result.bridgeComponents} pinned bridge inputs, ` +
      `${result.workflowActionPins} pinned CI actions, ` +
      `${result.syncEvidenceIncluded ? 'accepted synchronization evidence' : 'source artifacts only'}.`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
