import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localTensorFoldSlots } from "../tensorfoldRuntime.js";

test("local TensorFold lanes come from the running process for the observed model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tensorfold-proc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function process(pid, name, port, parallel) {
    const path = join(root, pid);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "comm"), "tensorfold-nati\n");
    const args = ["/engine/native/bin/tensorfold-native", "serve", "/model", "--name", name,
      "--port", String(port), `--parallel=${parallel}`, ""];
    await writeFile(join(path, "cmdline"), args.join("\0"));
  }
  await process("100", "example-model", 18888, 8);
  await process("200", "different-model", 20000, 2);
  const slots = (port) => localTensorFoldSlots(port, ["example-model"], root);
  assert.equal(await slots(8888), 8); // local socket proxy

  await process("100", "example-model", 18888, 6);
  assert.equal(await slots(8888), 6);

  await process("300", "example-model", 28888, 4);
  assert.equal(await slots(8888), 0); // ambiguous proxy target
  assert.equal(await slots(18888), 6);
  assert.equal(await slots(28888), 4);

  await process("300", "example-model", 28888, "auto");
  assert.equal(await slots(28888), 0); // actual capacity depends on memory
});
