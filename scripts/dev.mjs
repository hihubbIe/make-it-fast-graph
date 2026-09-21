/**
 * `npm run dev`: build @vhult/graph once, then run its watcher and Storybook
 * side by side. Stopping this process stops both (whole process trees — on
 * Windows `child.kill()` alone leaves the shell's grandchildren running).
 */
import { spawn, spawnSync } from "node:child_process";

const npm = (args) => spawn("npm", args, { stdio: "inherit", shell: true });

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

const build = spawnSync("npm", ["run", "build", "-w", "@vhult/graph"], { stdio: "inherit", shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);

const children = [npm(["run", "watch", "-w", "@vhult/graph"]), npm(["run", "dev", "-w", "@vhult/graph-storybook"])];

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const c of children) killTree(c);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
for (const c of children) c.on("exit", stop);
