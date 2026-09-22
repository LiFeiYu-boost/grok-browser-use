import fs from "node:fs";
import { randomUUID } from "node:crypto";

// Atomic publication includes the owner, so a contender never sees a half-written
// PID file. A live (or inaccessible) owner is never evicted on a timer.
export async function withSocketLock(socketPath, fn, timeoutMs = 5000) {
  const lock = socketPath + ".lock";
  const owner = `${process.pid}:${randomUUID()}`;
  const started = Date.now();
  while (true) {
    try {
      fs.symlinkSync(owner, lock);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let previous;
      try {
        previous = fs.readlinkSync(lock);
        const pid = Number(previous.split(":")[0]);
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (check) {
            if (check.code === "ESRCH" && fs.readlinkSync(lock) === previous) {
              fs.unlinkSync(lock);
              continue;
            }
          }
        }
      } catch (read) {
        if (read.code === "ENOENT") continue;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`broker startup lock timed out: ${lock}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      if (fs.readlinkSync(lock) === owner) fs.unlinkSync(lock);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}
