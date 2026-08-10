import type { ProtectConsole } from "@unifi-sensor-latch/shared";
import { maskSecret } from "@unifi-sensor-latch/shared";

// apiKey is secret-bearing: never echoed back in full, same rule as
// webhook URLs (CLAUDE.md obfuscation). Shared by GET /api/consoles and
// the server-rendered Sensors/Consoles pages so there's one place this
// rule lives, not hand-maintained copies.
export function redactConsole(console_: ProtectConsole): ProtectConsole {
  return { ...console_, apiKey: maskSecret(console_.apiKey) };
}
