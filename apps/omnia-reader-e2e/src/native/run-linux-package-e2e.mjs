import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function main() {
  assert.equal(
    process.platform,
    'linux',
    'The Debian package E2E gate can run only on Linux',
  );

  const bundleDirectory = resolve(
    'src-tauri',
    'target',
    'debug',
    'bundle',
    'deb',
  );
  const packages = (await readdir(bundleDirectory))
    .filter((entry) => entry.endsWith('.deb'))
    .sort();
  assert.equal(
    packages.length,
    1,
    `Expected one Debian package in ${bundleDirectory}, found ${packages.length}`,
  );

  const packagePath = join(bundleDirectory, packages[0]);
  const extractionDirectory = await mkdtemp(
    join(tmpdir(), 'omnia-reader-deb-e2e-'),
  );
  try {
    await execFileAsync('dpkg-deb', [
      '--extract',
      packagePath,
      extractionDirectory,
    ]);

    const binary = join(extractionDirectory, 'usr', 'bin', 'omnia-reader');
    const applicationsDirectory = join(
      extractionDirectory,
      'usr',
      'share',
      'applications',
    );
    const desktopFiles = (await readdir(applicationsDirectory)).filter(
      (entry) => entry.endsWith('.desktop'),
    );
    assert.equal(
      desktopFiles.length,
      1,
      `Expected one packaged desktop entry, found ${desktopFiles.length}`,
    );
    const desktopFile = join(applicationsDirectory, desktopFiles[0]);
    await access(binary);
    await access(desktopFile);

    const { stdout: packageMetadata } = await execFileAsync('dpkg-deb', [
      '--field',
      packagePath,
      'Package',
      'Version',
      'Architecture',
    ]);
    console.log(`Testing extracted Debian package:\n${packageMetadata.trim()}`);

    await execFileAsync(
      process.execPath,
      ['apps/omnia-reader-e2e/src/native/run-native-e2e.mjs'],
      {
        cwd: resolve('.'),
        env: {
          ...process.env,
          OMNIA_NATIVE_BINARY: binary,
          OMNIA_NATIVE_DESKTOP_FILE: desktopFile,
        },
        maxBuffer: 16 * 1024 * 1024,
      },
    ).then(({ stdout, stderr }) => {
      process.stdout.write(stdout);
      process.stderr.write(stderr);
    });
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
