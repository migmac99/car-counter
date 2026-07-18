#!/usr/bin/env bun
/**
 * `bun killme` — stop the running car-counter server, whatever state it's in.
 *
 * Kills the process(es) holding the server port (default 2277, or $PORT).
 * A wedged `bun --hot` can ignore SIGTERM while still holding the port, so
 * anything alive after 2 s gets SIGKILL. Port-scoped on purpose: matching
 * by process name could hit other projects' dev servers.
 *
 * Usage: bun killme [--quiet]   (--quiet: no output when nothing to kill)
 */
import { execSync } from 'node:child_process';

const quiet = process.argv.includes('--quiet');
const port = Number(process.env.PORT ?? 2277);
const say = (msg) => !quiet && console.log(msg);

function listeners() {
  try {
    // -nP skips name resolution — without it lsof can take close to a
    // minute on a busy machine.
    return execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return []; // lsof exits 1 when nothing listens
  }
}

const pids = listeners();
if (pids.length === 0) {
  say(`nothing listening on :${port}`);
  process.exit(0);
}
for (const pid of pids) {
  try {
    process.kill(pid, 'SIGTERM');
    say(`sent SIGTERM to ${pid} (:${port})`);
  } catch {}
}
await Bun.sleep(2000);
for (const pid of listeners()) {
  try {
    process.kill(pid, 'SIGKILL');
    say(`still alive — sent SIGKILL to ${pid}`);
  } catch {}
}
await Bun.sleep(200);
if (listeners().length === 0) say(`:${port} is free`);
else console.error(`:${port} is STILL held — check manually with: lsof -nP -i :${port}`);
