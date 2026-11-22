#!/usr/bin/env node
// The executable. `status --panel` runs every minute from the XFCE panel: it skips loading the rest of the CLI.
const argv = process.argv.slice(2);
if (argv[0] === "status" && argv.includes("--panel")) {
  const { panelMain } = await import("./panel.js");
  process.exit(await panelMain(argv));
} else {
  await import("./main.js");
}
