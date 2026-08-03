// Shared helper for the setup/dev orchestration scripts. Plain Node,
// no bash — this needs to behave identically on Windows (Git Bash/
// PowerShell), macOS, and Linux, and a hand-rolled child_process call
// is simpler to keep that way than depending on a shell being on PATH.
const { spawnSync } = require('child_process');

/** Runs `command args...` with inherited stdio, exiting the whole
 * process immediately (with the child's own exit code) on failure —
 * each step in setup/dev depends on the previous one having actually
 * succeeded (e.g. migrations need a healthy Postgres), so there's no
 * reasonable way to continue past a failed step. `shell: true` is
 * required on Windows, where `npm`/`npx`/`docker` are `.cmd` shims
 * that plain spawn (without a shell) can't exec directly. */
function run(command, args) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true });
  if (result.error) {
    console.error(`\nFailed to run "${command}": ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n"${command} ${args.join(' ')}" exited with code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

module.exports = { run };
