#!/usr/bin/env node
// Throwaway "real" CLI binary used only by cli-gate.contract.test.mjs to
// exercise makeGatedCli's REAL execFile path (an actual child process, real
// OS timeout kill, real stdout truncation) side-by-side with fakeCli.mjs's
// in-memory double. Behavior is driven purely by argv so both the real and
// fake scenarios can be scripted identically:
//   `--big`              → prints 5000 bytes of output (cap-enforcement)
//   `--sleep-ms=N`        → waits N ms before responding (timeout tests)
//   words === 'wallet send'  → exits 1 with stderr "insufficient funds"
//   words === 'wallet login' → MUST NEVER be invoked; exits 99 loudly if it is
//   anything else            → prints {"ok":true,"key":"<words>"} and exits 0
const argv = process.argv.slice(2);
const words = argv.filter(a => !a.startsWith('-'));
const key = words.join(' ');
const big = argv.includes('--big');
const sleepArg = argv.find(a => a.startsWith('--sleep-ms='));

function respond() {
  if (key === 'wallet send') { process.stderr.write('insufficient funds'); process.exit(1); return; }
  if (key === 'wallet login') { process.stderr.write('SHOULD-NEVER-RUN'); process.exit(99); return; }
  if (big) { process.stdout.write('X'.repeat(5000)); process.exit(0); return; }
  process.stdout.write(JSON.stringify({ ok: true, key }));
  process.exit(0);
}

if (sleepArg) {
  const ms = parseInt(sleepArg.split('=')[1], 10) || 0;
  setTimeout(respond, ms);
} else {
  respond();
}
