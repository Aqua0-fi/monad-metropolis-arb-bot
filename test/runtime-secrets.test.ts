import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRuntimeSecrets } from "../src/runtime-secrets.js";

test("runtime file loads only read/report/control credentials and refuses permissive files or admin fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-config-")),
    path = join(dir, "config.json");
  const values = {
    AQUA0_READ_API_KEY: randomBytes(24).toString("hex"),
    REBALANCER_REPORT_TOKEN: randomBytes(32).toString("hex"),
    REBALANCER_CONTROL_TOKEN: randomBytes(32).toString("hex"),
  };
  try {
    writeFileSync(path, JSON.stringify(values), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {};
    loadRuntimeSecrets(path, env);
    assert.deepEqual(env, values);
    chmodSync(path, 0o644);
    assert.throws(() => loadRuntimeSecrets(path, {}));
    chmodSync(path, 0o600);
    writeFileSync(
      path,
      JSON.stringify({ ...values, API_ADMIN_KEY: "not allowed" }),
    );
    assert.throws(() => loadRuntimeSecrets(path, {}));
    writeFileSync(
      path,
      JSON.stringify({
        ...values,
        REBALANCER_CONTROL_TOKEN: values.REBALANCER_REPORT_TOKEN,
      }),
    );
    assert.throws(() => loadRuntimeSecrets(path, {}), /differ/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
