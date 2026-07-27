import { WEB_APPLICATION_SHELL_HEADERS } from './web-security-headers.mjs';

for (const [name, value] of Object.entries(WEB_APPLICATION_SHELL_HEADERS).sort(
  ([left], [right]) => left.localeCompare(right),
)) {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  process.stdout.write(`add_header ${name} "${escaped}" always;\n`);
}
