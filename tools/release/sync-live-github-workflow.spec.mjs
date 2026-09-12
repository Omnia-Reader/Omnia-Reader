import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL(
  '../../.github/workflows/sync-live-github.yml',
  import.meta.url,
);

test('exposes the live provider journey only through protected manual dispatch', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^ {2}(?:pull_request|push|schedule):/m);
  assert.match(workflow, /test "\$EVENT_NAME" = workflow_dispatch/);
  assert.match(workflow, /test "\$WORKFLOW_REF" = refs\/heads\/main/);
  assert.match(workflow, /^ {4}environment: sync-staging$/m);
  assert.match(workflow, /^ {6}- self-hosted$/m);
  assert.match(workflow, /^ {6}- omnia-sync-staging-ephemeral$/m);
  assert.match(workflow, /^ {2}contents: read$/m);
});

test('pins actions and validates the candidate before executing its code', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const uses = [...workflow.matchAll(/^\s+uses:\s+([^\s]+)(?:\s+#.*)?$/gm)].map(
    (match) => match[1],
  );
  assert.equal(uses.length, 4);
  for (const reference of uses) {
    assert.match(reference, /^[^@\s]+@[a-f0-9]{40}$/);
  }
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.equal(
    (workflow.match(/git merge-base --is-ancestor/g) ?? []).length,
    2,
  );
  assert.match(workflow, /git checkout --detach "\$CANDIDATE_COMMIT"/);
  assert.ok(
    workflow.indexOf('Revalidate and check out the candidate') <
      workflow.indexOf('Install locked dependencies without lifecycle scripts'),
  );
  assert.match(workflow, /npm ci --ignore-scripts/);
});

test('confines raw output and uploads sanitized JSON only', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /--retries=0/);
  assert.match(workflow, /--trace=off/);
  assert.match(workflow, /--output="\$raw_root\/trace\/playwright-output"/);
  assert.match(workflow, />"\$raw_root\/log\/playwright\.log" 2>&1/);
  assert.match(workflow, /scan-sync-evidence\.mjs "\$raw_root"/);
  assert.match(workflow, /write-live-github-evidence\.mjs/);
  assert.match(workflow, /trap 'rm -rf "\$raw_root";/);
  assert.match(workflow, /^ {10}path: dist\/live-github-evidence\/\*\.json$/m);
  assert.doesNotMatch(workflow, /^\s+path:.*(?:raw|playwright|trace|log)/m);
  assert.match(workflow, /^ {8}if: always\(\)$/m);
  assert.match(workflow, /^ {10}if-no-files-found: error$/m);
});

test('uses one protected canary value in both browser and artifact scans', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.equal(
    (
      workflow.match(
        /OMNIA_SYNC_SECRET_CANARIES: \$\{\{ secrets\.OMNIA_SYNC_SECRET_CANARIES \}\}/g,
      ) ?? []
    ).length,
    1,
  );
  assert.match(
    workflow,
    /AUTH_STATE_JSON: \$\{\{ secrets\.LIVE_GITHUB_AUTH_STATE_JSON \}\}/,
  );
  assert.match(workflow, /install -m 600 \/dev\/null "\$auth_state"/);
  assert.match(workflow, /unset AUTH_STATE_JSON/);
  assert.ok(
    workflow.indexOf('Install Chromium') <
      workflow.indexOf('AUTH_STATE_JSON: ${{ secrets.'),
  );
  assert.match(workflow, /rm -f "\$auth_state" "\$scan_result"/);
});
