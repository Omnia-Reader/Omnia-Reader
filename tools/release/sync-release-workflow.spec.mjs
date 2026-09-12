import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL(
  '../../.github/workflows/sync-release.yml',
  import.meta.url,
);

test('exposes release mutation only through protected manual main dispatch', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^ {2}(?:pull_request|push|schedule):/m);
  assert.match(workflow, /test "\$EVENT_NAME" = workflow_dispatch/);
  assert.match(workflow, /test "\$WORKFLOW_REF" = refs\/heads\/main/);
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(workflow, /^ {4}environment: sync-staging$/m);
  assert.match(workflow, /^ {4}environment: sync-canary$/m);
  assert.match(workflow, /^ {4}environment: sync-production$/m);
  assert.match(workflow, /^ {4}environment: sync-rollback$/m);
});

test('pins every action to a full commit', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const uses = [...workflow.matchAll(/^\s+uses:\s+([^\s]+)(?:\s+#.*)?$/gm)].map(
    (match) => match[1],
  );
  assert.ok(uses.length >= 20);
  for (const reference of uses) {
    assert.match(reference, /^[^@\s]+@[a-f0-9]{40}$/);
  }
  assert.doesNotMatch(workflow, /uses:\s+[^\n]+@(main|master|v\d+)(?:\s|$)/);
});

test('builds both images once and binds every integrity operation to digests', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.equal((workflow.match(/docker\/build-push-action@/g) ?? []).length, 2);
  assert.equal((workflow.match(/^ {10}push: true$/gm) ?? []).length, 2);
  assert.equal((workflow.match(/^ {10}sbom: true$/gm) ?? []).length, 2);
  assert.equal(
    (workflow.match(/^ {10}provenance: mode=max$/gm) ?? []).length,
    2,
  );
  assert.equal((workflow.match(/anchore\/sbom-action@/g) ?? []).length, 2);
  assert.equal((workflow.match(/anchore\/scan-action@/g) ?? []).length, 2);
  assert.equal(
    (workflow.match(/actions\/attest-build-provenance@/g) ?? []).length,
    2,
  );
  assert.equal((workflow.match(/cosign sign --yes/g) ?? []).length, 2);
  assert.equal(
    (workflow.match(/cosign verify --certificate-identity/g) ?? []).length,
    2,
  );
  assert.equal(
    (workflow.match(/image: .*_image }}@\$\{\{ needs\.build-/g) ?? []).length,
    4,
  );
  assert.match(workflow, /write-sync-release-candidate\.mjs/);
});

test('promotion and rollback consume immutable artifact IDs without builds', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const promote = workflow.slice(
    workflow.indexOf('\n  promote:'),
    workflow.indexOf('\n  rollback:'),
  );
  const rollback = workflow.slice(workflow.indexOf('\n  rollback:'));

  for (const section of [promote, rollback]) {
    assert.match(
      section,
      /artifact-ids: \$\{\{ inputs\.primary_artifact_id }}/,
    );
    assert.match(
      section,
      /artifact-ids: \$\{\{ inputs\.supporting_artifact_id }}/,
    );
    assert.match(section, /run-id: \$\{\{ inputs\.primary_run_id }}/);
    assert.match(section, /run-id: \$\{\{ inputs\.supporting_run_id }}/);
    assert.doesNotMatch(section, /build-push-action|docker build|buildx build/);
  }
  assert.match(promote, /assert-sync-release-evidence\.mjs .* accepted/);
  assert.match(promote, /sync-promotion\.mjs accept/);
  assert.match(rollback, /assert-sync-release-evidence\.mjs .* rejected/);
  assert.match(rollback, /sync-promotion\.mjs rollback/);
  assert.match(rollback, /without rebuilding or retagging/);
});

test('scopes deployment authority to protected promotion steps', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.equal(
    (
      workflow.match(
        /OMNIA_SYNC_PROMOTION_DRIVER: \$\{\{ secrets\.OMNIA_SYNC_PROMOTION_DRIVER }}/g,
      ) ?? []
    ).length,
    4,
  );
  assert.doesNotMatch(
    workflow,
    /^env:\n[\s\S]{0,200}OMNIA_SYNC_PROMOTION_DRIVER/m,
  );
  const globalPermissions = workflow.slice(
    workflow.indexOf('\npermissions:'),
    workflow.indexOf('\nconcurrency:'),
  );
  assert.match(globalPermissions, /actions: read/);
  assert.match(globalPermissions, /contents: read/);
  assert.doesNotMatch(
    globalPermissions,
    /packages: write|id-token: write|attestations: write/,
  );
  assert.match(
    workflow,
    /runs-on: \[self-hosted, omnia-sync-production-ephemeral]/,
  );
  assert.match(
    workflow,
    /runs-on: \[self-hosted, omnia-sync-canary-ephemeral]/,
  );
});
