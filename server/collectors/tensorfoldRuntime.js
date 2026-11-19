import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { HOST_PATHS } from "../config.js";

function option(args, name) {
  for (let i = args.length - 1; i >= 2; i--) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
}

// Native TensorFold exposes no slot limit on /health when API keys are enabled.
// A numeric --parallel is a fixed lane count. "auto" depends on GPU headroom.
export async function localTensorFoldSlots(port, models, procRoot = HOST_PATHS.PROC) {
  if (!models.length) return 0;
  const pids = await readdir(procRoot).catch(() => null);
  if (!pids) return procRoot === HOST_PATHS.PROC && procRoot !== "/proc"
    ? localTensorFoldSlots(port, models, "/proc")
    : 0;
  const candidates = (await Promise.all(pids.filter((pid) => /^\d+$/.test(pid)).map(async (pid) => {
    const dir = join(procRoot, pid);
    try {
      const comm = await readFile(join(dir, "comm"), "utf8");
      if (comm.trim() !== "tensorfold-nati") return null; // Linux truncates comm to 15 bytes.
      const args = (await readFile(join(dir, "cmdline"), "utf8")).split("\0");
      if (basename(args[0]) !== "tensorfold-native" || args[1] !== "serve") return null;
      const name = option(args, "--name");
      if (!models.includes(name)) return null;
      const parallel = option(args, "--parallel");
      const slots = /^\d+$/.test(parallel ?? "") ? Number(parallel) : 0;
      const listenPort = Number(option(args, "--port"));
      return { listenPort, slots: Number.isInteger(slots) && slots > 0 && slots <= 4096 ? slots : 0 };
    } catch {
      return null; // Process exited or its arguments are inaccessible.
    }
  }))).filter(Boolean);
  const direct = candidates.filter((entry) => entry.listenPort === port);
  const matches = direct.length ? direct : candidates; // A local socket proxy can use a different public port.
  return matches.length === 1 ? matches[0].slots : 0;
}
