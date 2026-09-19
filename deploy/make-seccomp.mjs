/**
 * Regenerate deploy/seccomp.json.
 *
 *     node deploy/make-seccomp.mjs > deploy/seccomp.json
 *
 * Starting from Docker's default profile rather than writing an allowlist from
 * scratch is deliberate: that profile is the well-tested baseline, and a
 * hand-rolled allowlist for something as broad as LibreOffice is far more
 * likely to be wrong in a way that only shows up as a crash under load.
 *
 * This takes the default and additionally denies the syscalls a headless
 * document converter has no use for but which feature prominently in container
 * escapes and kernel exploits. Everything added here is verified against a real
 * conversion - if LibreOffice needed any of it, the smoke test in the README
 * would fail rather than the service failing quietly later.
 */

const UPSTREAM =
  'https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json';

const EXTRA_DENIES = [
  // Cross-process memory access: the classic primitive for reading another
  // process's secrets. Nothing here inspects other processes.
  'ptrace',
  'process_vm_readv',
  'process_vm_writev',
  'kcmp',

  // A long history of privilege-escalation bugs, and unused by a converter.
  'userfaultfd',
  'io_uring_setup',
  'io_uring_enter',
  'io_uring_register',

  // Kernel introspection and control.
  'bpf',
  'perf_event_open',
  'kexec_load',
  'kexec_file_load',
  'reboot',
  'init_module',
  'finit_module',
  'delete_module',

  // Filesystem control.
  'mount',
  'umount2',
  'pivot_root',
  'open_by_handle_at',
  'name_to_handle_at',
  'swapon',
  'swapoff',

  // Kernel keyring.
  'add_key',
  'request_key',
  'keyctl',

  // Clock manipulation, which can be used to confuse auditing.
  'adjtimex',
  'clock_adjtime',
  'clock_settime',
  'settimeofday',
  'stime',
];

const response = await fetch(UPSTREAM);
if (!response.ok) {
  throw new Error(`could not fetch the upstream profile: HTTP ${response.status}`);
}
const profile = await response.json();

const deny = new Set(EXTRA_DENIES);
let removed = 0;

// Drop anything we are about to deny from the allow groups first, so the
// result does not depend on how a given runtime orders conflicting rules.
for (const group of profile.syscalls) {
  const before = group.names.length;
  group.names = group.names.filter((name) => !deny.has(name));
  removed += before - group.names.length;
}

profile.syscalls.push({
  names: EXTRA_DENIES,
  action: 'SCMP_ACT_ERRNO',
  errnoRet: 1, // EPERM
});

process.stderr.write(
  `removed ${removed} allow entries; denied ${EXTRA_DENIES.length} syscalls\n`,
);
process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
