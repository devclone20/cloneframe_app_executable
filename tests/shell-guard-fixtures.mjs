// Shared assertion corpus for shell-guard contract tests.
// POSITIVE = must be blocked (isDestructive → true) by BOTH the real port and the fake.
// NEGATIVE = must pass through (isDestructive → false) by BOTH.
//
// POSITIVE is split into two provenance groups:
//   - "legacy"    : lifted verbatim from the guard as it exists TODAY in all three real
//                   files (hub-bridge.mjs /shell, pty.mjs isDestructive, ssh.mjs destructive) —
//                   these three copies are byte-for-byte identical, so one list covers all three.
//   - "hardening" : new coverage this port adds (multi-token rm flags, quoted dd target,
//                   named fork bombs) — a superset, never a replacement, of the legacy set.

export const POSITIVE_LEGACY = [
  { desc: 'rm -rf root', line: 'rm -rf /' },
  { desc: 'rm -rf root wildcard', line: 'rm -rf /*' },
  { desc: 'rm -rf root double wildcard', line: 'rm -rf /**' },
  { desc: 'rm -rf home tilde bare', line: 'rm -rf ~' },
  { desc: 'rm -rf home tilde slash', line: 'rm -rf ~/' },
  { desc: 'rm -rf $HOME', line: 'rm -rf $HOME' },
  { desc: 'rm -fr (reversed flags) root', line: 'rm -fr /' },
  { desc: 'sudo rm -rf root', line: 'sudo rm -rf /' },
  { desc: 'rm -r root (recursive only, no explicit f)', line: 'rm -r /' },
  { desc: 'rm -f root (force only, no explicit r)', line: 'rm -f /' },
  { desc: 'mkfs bare', line: 'mkfs /dev/sda' },
  { desc: 'mkfs.ext4', line: 'mkfs.ext4 /dev/sda1' },
  { desc: 'mkfs.xfs', line: 'mkfs.xfs /dev/nvme0n1p2' },
  { desc: 'dd zero to disk', line: 'dd if=/dev/zero of=/dev/sda' },
  { desc: 'dd random to disk with bs', line: 'dd if=/dev/random of=/dev/disk0 bs=1M' },
  { desc: 'dd to macOS raw disk', line: 'dd if=/dev/zero of=/dev/rdisk2 bs=1m' },
  { desc: 'classic fork bomb, spaced', line: ':(){ :|: & };:' },
  { desc: 'classic fork bomb, no spaces', line: ':(){:|:&};:' },
];

export const POSITIVE_HARDENING = [
  // legacy regex has no /i flag, so an uppercase flag letter (e.g. `-Rf`) slips
  // through the verbatim pattern — closed here, case-insensitively.
  { desc: 'rm -Rf (capital R) root — legacy is case-sensitive, this closes that gap', line: 'rm -Rf /' },
  { desc: 'rm -r -f as two separate tokens', line: 'rm -r -f /' },
  { desc: 'rm --recursive --force long flags', line: 'rm --recursive --force /' },
  { desc: 'rm -rf with a flag AFTER the target', line: 'rm -rf --verbose /' },
  { desc: 'rm -rf with target buried among other args', line: 'rm -rf /tmp/safe /' },
  { desc: 'rm reached via absolute path to the binary', line: '/bin/rm -rf /' },
  { desc: 'dd with quoted of= disk target', line: 'dd if=/dev/zero of="/dev/sda"' },
  { desc: 'dd with single-quoted of= disk target', line: "dd if=/dev/zero of='/dev/sda'" },
  { desc: 'named (non-colon) fork bomb', line: 'bomb(){ bomb|bomb & };bomb' },
  { desc: 'named fork bomb, no spaces', line: 'evil(){evil|evil&};evil' },
];

export const NEGATIVE = [
  { desc: 'plain listing', line: 'ls -la' },
  { desc: 'remove a single named file', line: 'rm file.txt' },
  { desc: 'rm -rf a project subfolder (node_modules)', line: 'rm -rf node_modules' },
  { desc: 'rm -rf a relative build dir', line: 'rm -rf ./build' },
  { desc: 'rm -rf an absolute but non-root path', line: 'rm -rf /tmp/myapp/cache' },
  { desc: 'rm -rf a whole subtree that is not / or ~', line: 'rm -rf /var/log/myapp' },
  { desc: 'rm -i root (interactive, no force/recursive flag)', line: 'rm -i /' },
  { desc: 'recursive copy (cp, not rm)', line: 'cp -r /home/user/backup /mnt/backup' },
  { desc: 'plain echo', line: 'echo hello world' },
  { desc: 'git status', line: 'git status' },
  { desc: 'npm install', line: 'npm install' },
  { desc: 'chained safe commands', line: 'cd /tmp && ls -la' },
  { desc: 'dd with a non-device output file', line: 'dd if=/dev/zero of=./backup.img bs=1M count=10' },
  { desc: 'dd --help (no of= at all)', line: 'dd --help' },
  { desc: 'token merely containing "mkfs" as a substring', line: 'mkfsomething --help' },
  { desc: 'benign shell function definition, no self-pipe', line: 'greet(){ echo hi; }' },
  { desc: 'benign colon-named variable use, not a bomb shape', line: 'echo "ok: fine"' },
  { desc: 'empty string', line: '' },
  { desc: 'whitespace only', line: '   ' },
];

export const ALL_POSITIVE = [...POSITIVE_LEGACY, ...POSITIVE_HARDENING];
