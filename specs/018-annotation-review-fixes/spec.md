# Annotation and diagnostic review fixes

Reduced regression workflow for the three findings in the uncommitted-change
review. Preserve the existing annotation controls, offline persistence, and
production/native application behavior.

1. A queued formatting action belongs to the editor context in which it was
   requested. Cancelling, reopening, switching annotation, replacing selection,
   or destroying the reader must discard stale work. An older save must not
   replace a newer editor's draft after it finishes. Same-context autosave and
   formatting must still complete.
2. PDF test helpers must verify a new annotation on the requested page with the
   requested style. Existing marks cannot satisfy the check; multiple rectangles
   for one annotation and multiple annotations are valid.
3. Native failure capture must preserve the original screenshot before passive
   page inspection. It must not re-import the entry module, bootstrap the app,
   invoke native commands, or replace console/error handlers. Failed capture
   must not obscure the original test error.

Validation: failing regression first; reader unit tests; browser regression and
annotation journeys across Chromium, Firefox, WebKit; passive diagnostics in
those browsers; application/E2E lint; production build; diff and formatting checks.
Personal Codex configuration is outside the change scope. The user authorized
committing the reviewed changes after validation; pushing remains out of scope.
