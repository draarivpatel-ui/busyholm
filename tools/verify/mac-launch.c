/* Verification-only launcher: keep the PID and stdio, make helper ownership attributable to the app.
 * Chromium uses this macOS API in base/process/launch_mac.cc. It never runs in the shipping app. */
#define _DARWIN_C_SOURCE 1
#include <dlfcn.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
extern char **environ;
typedef int (*disclaim_fn)(posix_spawnattr_t, int);

int main(int argc, char **argv) {
  if (argc < 2) return 64;
  disclaim_fn disclaim = (disclaim_fn)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
  if (!disclaim) { fputs("macOS responsibility API unavailable\n", stderr); return 78; }
  posix_spawnattr_t attr;
  int rc = posix_spawnattr_init(&attr);
  if (!rc) rc = posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETEXEC);
  if (!rc) rc = disclaim((posix_spawnattr_t)&attr, 1);
  pid_t pid;
  if (!rc) rc = posix_spawn(&pid, argv[1], NULL, &attr, argv + 1, environ);
  fprintf(stderr, "measurement launch failed: %s\n", strerror(rc));
  return 78;
}
