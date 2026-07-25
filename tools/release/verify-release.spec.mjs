import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectArtifactFiles,
  createBridgeSourceSbom,
  createRustSbom,
  parseBridgeDependencies,
  parseCargoPackage,
  validateLicenses,
  validateVersionCoherence,
  validateWorkflowActionPins,
} from './verify-release.mjs';
import {
  WEB_APPLICATION_SHELL_CONTENT_SECURITY_POLICY,
  WEB_CONTENT_SECURITY_POLICY,
} from '../web-security-headers.mjs';

test('release versions must be valid and identical', () => {
  assert.equal(
    validateVersionCoherence({
      npm: '0.1.0',
      cargo: '0.1.0',
      tauri: '0.1.0',
    }),
    '0.1.0',
  );
  assert.throws(
    () =>
      validateVersionCoherence({
        npm: '0.1.0',
        cargo: '0.2.0',
      }),
    /Release versions differ/,
  );
});

test('Cargo package fields are read from the package section only', () => {
  assert.deepEqual(
    parseCargoPackage(`
[package]
name = "omnia-reader"
version = "0.1.0"
license = "MIT"

[dependencies]
example = "9.9.9"
`),
    {
      name: 'omnia-reader',
      version: '0.1.0',
      license: 'MIT',
    },
  );
});

test('MEGA bridge dependencies and base image must use immutable pins', () => {
  const bridge = parseBridgeDependencies(
    `
project(omnia_bridge VERSION 0.1.0 LANGUAGES CXX)
FetchContent_Declare(
  mega_sdk
  GIT_REPOSITORY https://github.com/meganz/sdk.git
  GIT_TAG 1111111111111111111111111111111111111111
)
FetchContent_Declare(
  cpp_httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG 2222222222222222222222222222222222222222
)
FetchContent_Declare(
  nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG 3333333333333333333333333333333333333333
)
`,
    'ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );

  assert.equal(bridge.version, '0.1.0');
  assert.equal(bridge.sources.length, 3);
  assert.equal(createBridgeSourceSbom(bridge).components.length, 4);
  assert.throws(
    () =>
      parseBridgeDependencies(
        `
project(omnia_bridge VERSION 0.1.0)
FetchContent_Declare(
  mega_sdk
  GIT_REPOSITORY https://github.com/meganz/sdk.git
  GIT_TAG main
)
`,
        'ARG UBUNTU_IMAGE=ubuntu:24.04',
      ),
    /full immutable Git commit/,
  );
});

test('dependency licenses fail closed until explicitly reviewed', () => {
  validateLicenses(
    [{ name: 'safe@1.0.0', expressions: ['MIT OR Apache-2.0'] }],
    'test',
  );
  assert.throws(
    () =>
      validateLicenses(
        [{ name: 'unknown@1.0.0', expressions: ['GPL-3.0-only'] }],
        'test',
      ),
    /unreviewed dependency licenses/,
  );
  assert.throws(
    () =>
      validateLicenses([{ name: 'missing@1.0.0', expressions: [] }], 'test'),
    /missing license/,
  );
});

test('CI actions must use immutable full commit pins', () => {
  assert.deepEqual(
    validateWorkflowActionPins([
      {
        path: '.github/workflows/verify.yml',
        contents: `
steps:
  - uses: ./local-action
  - uses: actions/checkout@1111111111111111111111111111111111111111 # v7.0.1
  - uses: actions/setup-node@2222222222222222222222222222222222222222
`,
      },
    ]),
    [
      'actions/checkout@1111111111111111111111111111111111111111',
      'actions/setup-node@2222222222222222222222222222222222222222',
    ],
  );
  assert.throws(
    () =>
      validateWorkflowActionPins([
        {
          path: '.github/workflows/verify.yml',
          contents: 'steps:\n  - uses: actions/checkout@v7\n',
        },
      ]),
    /full immutable Git commit/,
  );
});

test('the HTTP CSP preserves the application HTML fallback policy', async () => {
  const indexHtml = await readFile(
    new URL('../../apps/omnia-reader/src/index.html', import.meta.url),
    'utf8',
  );
  const fallbackPolicy = indexHtml.match(
    /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
  )?.[1];
  assert.ok(fallbackPolicy, 'index.html CSP fallback is missing');
  for (const directive of fallbackPolicy.split(';')) {
    assert.ok(
      WEB_APPLICATION_SHELL_CONTENT_SECURITY_POLICY.includes(directive.trim()),
      `HTTP CSP is missing the fallback directive: ${directive.trim()}`,
    );
  }
  assert.match(
    WEB_APPLICATION_SHELL_CONTENT_SECURITY_POLICY,
    /frame-ancestors 'none'/,
  );
  assert.doesNotMatch(WEB_CONTENT_SECURITY_POLICY, /frame-ancestors/);
});

test('Rust CycloneDX output contains a deterministic dependency graph', () => {
  const rootId = 'path+file:///workspace#app@0.1.0';
  const dependencyId =
    'registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0';
  const sbom = createRustSbom({
    packages: [
      {
        id: dependencyId,
        name: 'serde',
        version: '1.0.0',
        license: 'MIT OR Apache-2.0',
      },
      {
        id: rootId,
        name: 'app',
        version: '0.1.0',
        license: 'MIT',
      },
    ],
    resolve: {
      root: rootId,
      nodes: [
        { id: dependencyId, dependencies: [] },
        { id: rootId, dependencies: [dependencyId] },
      ],
    },
  });

  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.metadata.component.name, 'app');
  assert.deepEqual(
    sbom.dependencies.find((dependency) => dependency.ref.includes('/app@'))
      ?.dependsOn,
    ['pkg:cargo/serde@1.0.0'],
  );
});

test('artifact checksums are stable and paths are release-relative', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'omnia-release-test-'));
  const artifactDirectory = join(workspaceRoot, 'dist/example');
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(join(artifactDirectory, 'b.txt'), 'second\n', 'utf8');
  await writeFile(join(artifactDirectory, 'a.txt'), 'first\n', 'utf8');

  const roots = [{ directory: 'dist/example', prefix: 'example' }];
  const first = await collectArtifactFiles(workspaceRoot, roots);
  const second = await collectArtifactFiles(workspaceRoot, roots);

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((file) => file.path),
    ['example/a.txt', 'example/b.txt'],
  );
  assert.match(first[0].sha256, /^[a-f0-9]{64}$/);
});
