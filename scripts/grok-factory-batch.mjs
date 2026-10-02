#!/usr/bin/env node
/**
 * grok-factory-batch.mjs — runner-side BATCH + HEDGE driver for grok-factory.mjs.
 *
 * Why: a single GHA run = one fresh datacenter IP. The per-IP code-send quota
 * (~25/day) allows ~6-8 safe attempts from one IP, and the runner has 2-4 vCPU
 * so several attempts can run in PARALLEL. This driver:
 *   - spawns up to `--hedge K` factory attempts in parallel,
 *   - runs `--count N` attempts total,
 *   - gives every attempt its own registry file,
 *   - envelope-encrypts each registry with a UNIQUE artifact suffix
 *     (GITHUB_RUN_ID-a<idx>) right after the attempt finishes,
 *   - always exits 0 (a partial batch still commits its results).
 *
 * Usage:
 *   node scripts/grok-factory-batch.mjs --count 6 --hedge 3 [--email X] [--factory-args "--signup-first"]
 *
 * Env:
 *   GROK_FACTORY_PATH  override factory script path (used by local dry tests)
 *
 * Security: plaintext registries are written to scripts/.tmp-grok-registry-* files
 * (gitignored), then deleted by grok-enc.mjs. No plaintext ever reaches the repo.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const count = Math.max(1, parseInt(opt("--count", "1"), 10) || 1);
const hedge = Math.max(1, parseInt(opt("--hedge", "1"), 10) || 1);
const extra = (opt("--factory-args", "") || "").trim();
const factoryArgs = extra ? extra.split(/\s+/).filter(Boolean) : [];
const email = (opt("--email", "") || "").trim() || null;

const RUN_ID = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
const FACTORY = process.env.GROK_FACTORY_PATH || path.join(__dir, "grok-factory.mjs");
const ENC = path.join(__dir, "grok-enc.mjs");
const log = (...a) => console.log(`[batch ${new Date().toISOString().slice(11, 19)}]`, ...a);

log(`starting: count=${count} hedge=${hedge} run_id=${RUN_ID} extra=[${factoryArgs.join(" ")}]`);

function spawnAsync(cmd, argv, env = process.env, timeoutMs = 0) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, { stdio: "inherit", env });
    let killer = null;
    if (timeoutMs > 0) {
      killer = setTimeout(() => {
        console.error(`[batch] attempt timeout ${Math.round(timeoutMs / 60000)}min - killing child pid ${p.pid}`);
        try { p.kill("SIGKILL"); } catch (e) { /* ignore */ }
      }, timeoutMs);
    }
    const fin = (code) => { if (killer) clearTimeout(killer); resolve(code ?? 1); };
    p.on("close", (code) => fin(code));
    p.on("error", (e) => { console.error("[batch] spawn error:", e.message); fin(1); });
  });
}

async function attempt(idx) {
  const reg = path.join(__dir, `.tmp-grok-registry-${RUN_ID}-${idx}.json`);
  let code = 1;
  try {
    const fargs = [...factoryArgs, "--registry", reg];
    if (email && count === 1) fargs.unshift(email);
    code = await spawnAsync("node", [FACTORY, ...fargs], process.env, 45 * 60 * 1000);
    log(`attempt ${idx} exit=${code}`);
  } catch (e) {
    log(`attempt ${idx} threw: ${e.message}`);
  } finally {
    if (fs.existsSync(reg)) {
      const encCode = await spawnAsync("node", [ENC, reg], { ...process.env, GITHUB_RUN_ID: `${RUN_ID}-a${idx}` });
      log(`attempt ${idx} encrypted (exit=${encCode})`);
    } else {
      log(`attempt ${idx} produced no registry (no account created)`);
    }
  }
  return code;
}

let next = 0;
let done = 0;
const running = new Set();
await new Promise((resolve) => {
  const pump = () => {
    while (running.size < hedge && next < count) {
      const my = next++;
      const p = attempt(my).then(() => {
        running.delete(p);
        done++;
        log(`progress ${done}/${count}`);
        if (done >= count) resolve();
        else pump();
      });
      running.add(p);
    }
    if (done >= count) resolve();
  };
  pump();
});
log(`batch complete: ${done}/${count} attempts (hedge=${hedge})`);
process.exit(0);
