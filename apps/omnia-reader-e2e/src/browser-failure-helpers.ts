const SCRIPTLESS_SANDBOX_ENFORCEMENT =
  /^Blocked script execution in '.+' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.$/;
const FIREFOX_NEUTRALIZED_REMOTE_FONT =
  /^\[JavaScript Error: "downloadable font: font load failed \(font-family: "[^"]+" style:[^)]+\): status=\d+ source: data:,"\]$/;

export function isExpectedSandboxEnforcementMessage(message: string): boolean {
  return SCRIPTLESS_SANDBOX_ENFORCEMENT.test(message);
}

export function isExpectedPublicationSecurityConsoleMessage(
  message: string,
): boolean {
  return (
    isExpectedSandboxEnforcementMessage(message) ||
    FIREFOX_NEUTRALIZED_REMOTE_FONT.test(message)
  );
}
