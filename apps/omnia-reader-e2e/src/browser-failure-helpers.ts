const SCRIPTLESS_SANDBOX_ENFORCEMENT =
  /^Blocked script execution in '.+' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.$/;

export function isExpectedSandboxEnforcementMessage(message: string): boolean {
  return SCRIPTLESS_SANDBOX_ENFORCEMENT.test(message);
}
