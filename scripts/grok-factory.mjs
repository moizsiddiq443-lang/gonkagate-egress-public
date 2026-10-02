#!/usr/bin/env node
/**
 * grok-factory.mjs — create grok.com (accounts.x.ai) accounts via temp mail (v2).
 * Hardened 2026-09-29 for the 100-account GHA burst:
 *   - emailnator dotGmail MINTED FROM THE RUNNER IP when no email arg (--new / omit)
 *   - password GENERATED IN-RUN (random) when omitted — nothing sensitive in dispatch inputs
 *   - RESET-RAIL claim: reset-password?email=X auto-sends OTP (works on fresh + recycled
 *     shared-mailbox addresses; NOT suppressed for temp mail like signup OTPs)
 *   - auto signup-step first if the reset rail reports "no account"
 *   - session auto-detection after reset (sso cookie) — skips the sign-in turnstile when possible
 *   - sign-in fallback (login with email → password → wait for sso cookie)
 *   - DEVICE-FLOW OAuth mint → access_token + refresh_token (usable by grok-cli / bridge)
 *
 * Usage:
 *   node grok-factory.mjs [email] [password] [--new] [--headed] [--registry <path>] [--code NNNNNN]
 * Exit codes: 0 = account created+tokens, 3 = existing/claim-failed, 4 = blocked/captcha, 1 = error/timeout.
 *
 * Registry entry: { email, password, sso, access_token, refresh_token, expires_at, created, model_tier }
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const EMAILNATOR_BASE = "https://www.emailnator.com";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"; // grok-cli oauth client
const SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const AUTH = "https://auth.x.ai";

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0",
];
const TZ_POOL = ["Asia/Karachi", "America/New_York", "Europe/London", "Asia/Dubai", "Australia/Sydney"];
const LANG_POOL = ["en-US", "en-GB", "en-CA", "en-AU"];
const PLATFORM_POOL = ["Win32", "MacIntel", "Linux x86_64"];
const CONC_POOL = [4, 8, 16];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const HDRS = {
  "Accept": "application/json",
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  "X-Requested-With": "XMLHttpRequest",
  "Origin": EMAILNATOR_BASE,
  "Referer": EMAILNATOR_BASE + "/inbox",
};

const STEALTH = (plat, conc) => `
Object.defineProperty(navigator, "webdriver", { get: () => undefined });
const _qp = navigator.permissions && navigator.permissions.query;
if (_qp) navigator.permissions.query = (p) => p && p.name === "notifications" ? Promise.resolve({ state: Notification.permission, onchange: null }) : _qp(p);
try { Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"], configurable: true }); } catch (e) {}
try { Object.defineProperty(navigator, "platform", { get: () => "${plat}", configurable: true }); } catch (e) {}
try { Object.defineProperty(navigator, "hardwareConcurrency", { get: () => ${conc}, configurable: true }); } catch (e) {}
`;

function findChromium() {
  const candidates = [
    process.env.PW_CHROMIUM,
    "C:/Users/hp/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
    "/home/runner/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
    "/home/runner/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  for (const base of [path.join(process.env.LOCALAPPDATA || "", "ms-playwright"), "/home/runner/.cache/ms-playwright", path.join(process.env.HOME || "", ".cache/ms-playwright")]) {
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        if (!d.startsWith("chromium")) continue;
        for (const sub of ["chrome-win64/chrome.exe", "chrome-linux/chrome", "chrome-linux/headless_shell"]) {
          const exe = path.join(base, d, sub);
          if (fs.existsSync(exe)) return exe;
        }
      }
    }
  }
  return null;
}

// Email pool selection: rotate across fresh emailnator pools (2=plusGmail, 8=googlemail; 3=dotGmail is BURNED).
const EMAIL_TYPES = String(process.env.GROK_EMAIL_TYPES || "2,8").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
const MAX_CYCLES = Number(process.env.GROK_MAX_CYCLES || 4);
let emailTypeIdx = 0;
function nextEmailType() { const t = EMAIL_TYPES[emailTypeIdx % EMAIL_TYPES.length]; emailTypeIdx++; return t; }
async function enatorGen(type) {
  const t = type || nextEmailType();
  const r = await fetch(`${EMAILNATOR_BASE}/api/generate-email`, {
    method: "POST", headers: HDRS, body: JSON.stringify({ ids: [t] }),
  });
  const d = await r.json();
  const em = d.email || d.address || String(d);
  console.log(new Date().toISOString().slice(11, 19), "enatorGen type=" + t + " ->", em);
  return em;
}

async function enatorList(email) {
  const r = await fetch(`${EMAILNATOR_BASE}/api/message-list`, {
    method: "POST", headers: HDRS, body: JSON.stringify({ email, limit: 30 }),
  });
  const d = await r.json();
  return (d && d.messages) || [];
}

async function enatorWaitCode(email, tries = 18, gapMs = 10000, seen = new Set()) {
  for (let i = 0; i < tries; i++) {
    try {
      const msgs = await enatorList(email);
      const hit = msgs.find((m) => /x\.ai|SpaceXAI|confirmation code/i.test((m.from || "") + (m.subject || "")) && !seen.has(m.subject));
      if (hit) {
        seen.add(m.subject); // skip on later retries (stale-code protection)
        const m = (hit.subject || "").match(/(\d{3})[\s-]*(\d{3})/) || (hit.subject || "").match(/(\d{6})/);
        if (m) return m[1] + (m[2] ? m[2] : "");
      }
    } catch (e) { /* transient */ }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return null;
}

async function clickByText(page, text, { exact = true } = {}) {
  const loc = page.locator("button", { hasText: exact ? text : undefined }).filter({ hasText: text }).first();
  await loc.click({ timeout: 8000 });
}

async function clickAny(page, labels) {
  // robust: matches <button>, input[type=submit], [role=button] by innerText OR value,
  // exact-or-startswith, case-insensitive (consent forms use input[type=submit] value="Allow")
  for (const label of labels) {
    try {
      const found = await page.evaluate((lab) => {
        const els = [...document.querySelectorAll("button, input[type=submit], [role=button]")];
        const el = els.find((x) => {
          const t = ((x.innerText || x.value || "").trim().toLowerCase());
          return t === lab.toLowerCase() || t.startsWith(lab.toLowerCase());
        });
        if (el) { el.click(); return true; }
        return false;
      }, label);
      if (found) return label;
    } catch (e) { /* try next */ }
  }
  return null;
}

async function bodyText(page) {
  try { return (await page.locator("body").innerText()) || ""; } catch { return ""; }
}

async function hasSso(ctx) {
  const cks = await ctx.cookies().catch(() => []);
  return (cks || []).some((c) => ["sso", "x-userid", "sso-rw"].includes(c.name));
}

function makePassword() {
  return "Grok!" + randomBytes(9).toString("base64url");
}

async function uiLogin(page, ctx, email, password, log) {
  // full UI sign-in: email → password → turnstile auto-solve → login click.
  // Used when the reset chain did NOT establish an sso session, or when the
  // device flow redirects to the login page.
  log("UI login (email+password+turnstile)");
  await page.goto("https://accounts.x.ai/sign-in?redirect=grok-com", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(10000);
  await clickAny(page, ["login with email"]);
  await page.waitForTimeout(4000);
  await page.locator("input[name=email], input[type=email]").first().fill(email);
  await page.waitForTimeout(500);
  await clickAny(page, ["next"]);
  await page.waitForTimeout(6000);
  await page.locator("input[name=password], input[type=password]").first().fill(password);
  await page.waitForTimeout(12000); // turnstile auto-solve
  const c3 = await clickAny(page, ["login"]);
  log("clicked login:", c3);
  await page.waitForTimeout(4000);
  if (!c3) {
    const r3 = await page.evaluate(`(() => {
      const els = [...document.querySelectorAll('button, [role=button], input[type=submit]')];
      const b = els.find(x => (x.innerText || x.value || '').trim().toLowerCase() === 'login');
      if (b) { b.click(); return 'login-exact2'; }
      return null;
    })()`);
    log("login fallback:", r3);
  }
  let ok = false;
  for (let i = 0; i < 30; i++) {
    if (await hasSso(ctx)) { ok = true; break; }
    const u = await page.evaluate("location.href").catch(() => "");
    if (/grok\.com/.test(String(u))) { ok = true; break; }
    await page.waitForTimeout(2000);
  }
  return ok;
}

async function deviceFlow(page, ctx, email, password, log) {
  const r = await fetch(`${AUTH}/oauth2/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
  });
  if (!r.ok) throw new Error("device/code " + r.status + " " + (await r.text()).slice(0, 200));
  const dc = await r.json();
  log("device code OK, user_code:", dc.user_code);

  // consent via REAL PAGE navigation — the browser executes the Cloudflare JS
  // challenge, which page.request / raw fetch cannot (both get the ie6-oldie
  // challenge on auth.x.ai/oauth2/device/verify). Real pages render fine.
  await page.goto(dc.verification_uri_complete, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(10000);
  let b = await bodyText(page);
  log("device page1:", b.replace(/\s+/g, " ").slice(0, 180));
  if (/log into your account|login with google|login with email/i.test(b)) {
    // no usable sso session — device flow bounced to the login form.
    // Sign in inline, then re-enter the consent URL.
    log("device flow hit a LOGIN page — inline UI login, then re-enter consent");
    const okL = await uiLogin(page, ctx, email, password, log);
    if (!okL) throw new Error("NO_AUTH: inline login inside device flow failed");
    await page.goto(dc.verification_uri_complete, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(10000);
    b = await bodyText(page);
    log("device page1b:", b.replace(/\s+/g, " ").slice(0, 180));
  }
  const c4 = await clickAny(page, ["continue", "next", "authorize"]);
  log("device click1:", c4);
await page.waitForTimeout(6000);
  b = await bodyText(page);
  if (/second factor|verify your account|authenticator app|\bADM\b|Google Authenticator|KeePass/i.test(b)) {
    // consent-page MFA wall — 2FA step-up that the sso session does NOT satisfy for
    // this account (observed ~1/3 of pool). Not solvable without the TOTP seed →
    // fail FAST (skip the 200s token-poll waste) unless email-2FA is offered.

    log("MFA_WALL on consent page — 2FA step-up required; text:", b.replace(/\s+/g, " ").slice(0, 240));
    const e2 = await clickAny(page, ["email", "send code to email", "verify by email", "use email"]);
    if (e2) {
      log("clicked email-2FA option:", e2);
      await page.waitForTimeout(4000);
      const ec = await enatorWaitCode(email, 10, 10000, new Set());
      if (ec) {
        log("email-2FA code:", ec.slice(0, 3) + "-" + ec.slice(3));
        await page.locator("input").last().fill(ec);
        await page.waitForTimeout(500);
        await clickAny(page, ["verify", "continue", "confirm"]);
        await page.waitForTimeout(5000);
      } else {
        log("no email-2FA code arrived");
      }
    } else {
      throw new Error("MFA_ACCOUNT: consent demands 2FA (unsolvable)");
    }
  }
  log("consent page:", b.replace(/\s+/g, " ").slice(0, 220));
  let c5 = await clickAny(page, ["allow", "authorize", "approve"]);
  log("device click2:", c5);
  // completion detection + allow retry (the approve POST occasionally races/
  // fails silently → grant never registers; re-click submits again)
  let completed = false;
  for (let attempt =  0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await page.waitForTimeout(8000);
      c5 = await clickAny(page, ["allow", "authorize", "approve"]);
      log("device click2 retry:", attempt + 1, c5);
    } else {
      await page.waitForTimeout(10000);
    }
    b = await bodyText(page);
    log("post-consent sample:", b.replace(/\s+/g, " ").slice(0, 160));
    if (/you can close this window|signed in|approved|successful|complete/i.test(b)) { completed = true; break; }
    if (/enter the code shown/i.test(b)) {
      // re-auth: page bounced back to the code entry — click continue again
      const cc = await clickAny(page, ["continue", "next", "authorize"]);
      log("re-auth continue:", cc);
      await page.waitForTimeout(6000);
      b = await bodyText(page);
      if (/second factor/i.test(b)) throw new Error("MFA_ACCOUNT: re-auth demands 2FA");
      continue;

    }
  }
  if (!completed) log("CONSENT_INCOMPLETE — polling anyway (grant may still register)");

  // token poll (node fetch fine here — no CF on /oauth2/token)
  // Hardened: 90×5s = 7.5 min; every ~30s re-visit the consent URL and re-click
  // allow — the approve POST occasionally races/fails silently, leaving the grant
  // unregistered while the page sits on "Authorize". Re-click re-submits.
  let token = null;
  for (let i = 0; i < 90; i++) {
    const tr = await fetch(`${AUTH}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: dc.device_code, client_id: CLIENT_ID }).toString(),
    });
    const j = await tr.json().catch(() => ({}));
    if (j.access_token) { token = j; break; }
    if (j.error === "authorization_pending") {
      if (i > 0 && i % 6 === 0) {
        // ~every 30s: re-check consent page; if still showing an authorize/allow
        // control, click it again (idempotent re-approve)
        try {
          await page.goto(dc.verification_uri_complete, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(4000);
          const rb = await bodyText(page);
          if (!/you can close this window|approved|successful|complete/i.test(rb)) {
            const rc = await clickAny(page, ["allow", "authorize", "approve"]);
            if (rc) log("token-poll re-click consent:", rc);
          }
        } catch (e) { /* poll continues regardless */ }
      }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (j.error === "slow_down") { await new Promise((r) => setTimeout(r, 7000)); continue; }
    throw new Error("token poll: " + JSON.stringify(j));
  }
  if (!token) throw new Error("token poll timeout");
  return token;
}

async function main() {
  // robust arg parse: email/password are the FIRST non-flag positionals
  const args = process.argv.slice(2);
  const opts = { registry: null, code: null, headed: false, new: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--registry") { opts.registry = args[++i] || null; }
    else if (a === "--code") { opts.code = args[++i] || null; }
    else if (a === "--headed") { opts.headed = true; }
    else if (a === "--new") { opts.new = true; }
    else if (a === "--signup-first") { opts.signupFirst = true; }
    else if (a.startsWith("--")) { /* skip unknown flags */ }
    else positional.push(a);
  }
  const emailArg = positional[0] || null;
  const passwordArg = positional[1] || null;
  const registryPath = opts.registry;
  const manualCode = opts.code;
  const headed = opts.headed;
  const signupFirst = opts.signupFirst || false;
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

  let email = emailArg;
  if (!email || opts.new) {
    email = await enatorGen();
    log("MINTED EMAIL:", email);
  }
  let password = passwordArg;
  if (!password) {
    password = makePassword();
    log("generated random password (in-run)");
  }
  log("email:", email);

  const exe = findChromium();
  if (!exe) { console.error("FATAL: chromium not found (set PW_CHROMIUM)"); process.exit(1); }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: !headed,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
      "--window-size=1280,900",
    ],
  });
  const ctx = await browser.newContext({
    userAgent: pick(UA_POOL),
    locale: pick(LANG_POOL),
    viewport: { width: 1280 + Math.floor(Math.random() * 160), height: 800 + Math.floor(Math.random() * 160) },
    timezoneId: pick(TZ_POOL),
  });
  await ctx.addInitScript(STEALTH(pick(PLATFORM_POOL), pick(CONC_POOL)));
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  try {
    let enc = encodeURIComponent(email);
    // pre-snapshot inbox: dedup by CODE VALUE (emailnator message ids change every
// query, so id-based seen is useless). Parse existing code subjects into seen.
    const seen = new Set();
    for (let s = 0; s < 5; s++) {
      try {
        for (const m of await enatorList(email)) {
          const mm = (m.subject || "").match(/SpaceXAI confirmation code:\s*(\d{3})[\s-]*(\d{3})/);
          if (mm) seen.add(mm[1] + mm[2]);
        }
        if (seen.size > 0) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 3000));
    }
    log("pre-snapshot: " + seen.size + " existing xai codes known");

    // ---- 1+2. RESET RAIL + CODE-CATCH with REMINT cycles: xAI queue-delays
//        code emails (~3min to hours). Poll inbox every 30s, re-trigger send
//        every ~3min, use the code the instant it lands (codes expire ~10-15min
//        after SEND). ~50% of recycled emailnator inboxes are DEAD (Google
//        spam-files xAI mail) → abandon after ~9min and remint a fresh inbox. ----
    let code = null;
    let b = "";
    let signupMode = signupFirst; // signup rail: fresh accounts have NO MFA wall
    for (let cycle = 1; cycle <= MAX_CYCLES && !code; cycle++) {
      if (cycle > 1) {
        email = await enatorGen();
        enc = encodeURIComponent(email);
        seen.clear();
        try { for (const m of await enatorList(email)) { const mm = (m.subject || "").match(/SpaceXAI confirmation code:\s*(\d{3})[\s-]*(\d{3})/); if (mm) seen.add(mm[1] + mm[2]); } } catch {}
        log("RE-MINT cycle " + cycle + ":", email);
        await page.goto("https://accounts.x.ai/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
      // ---- SIGNUP-FIRST: submit signup; if already-registered → reset rail ----
      let codeSent = false;
      if (signupMode) {
        log("SIGNUP-FIRST: submitting signup for " + email);
        await page.goto("https://accounts.x.ai/sign-up?redirect=grok-com", { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(6000);
        await clickAny(page, ["sign up with email"]);
        await page.waitForTimeout(3000);
        const mi = page.locator("input[type=email], input[name=email]").first();
        if (await mi.count()) {
          await mi.fill(email);
          await page.waitForTimeout(400);
          await mi.press("Enter").catch(() => {});
        }
        await page.waitForTimeout(10000);
        b = await bodyText(page);
        log("signup page after submit:", b.replace(/\s+/g, " ").slice(0, 160));
        if (/verify your email|we've emailed|confirmation code|code to/i.test(b)) {
          codeSent = true; log("SIGNUP: code page — waiting for code in inbox");
        } else if (/already|exists|in use|sign in instead/i.test(b)) {
          log("SIGNUP: already registered — falling back to reset rail"); signupMode = false;
        } else {
          log("SIGNUP: unknown state — will still try catch"); codeSent = true;
        }
      }
      // ---- reset rail (skipped when signup already sent the code) ----
      if (!codeSent) {
        await page.goto(`https://accounts.x.ai/reset-password?email=${enc}`, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(10000);
        b = await bodyText(page);
        log("reset page:", b.replace(/\s+/g, " ").slice(0, 160));
        if (/you have been blocked|attention required/i.test(b)) { console.error("BLOCKED: Cloudflare block page"); process.exit(4); }
        if (/too many code requests/i.test(b)) {
          log("RATE_LIMITED (address burned) - reminting fresh address");
          continue; // fast-fail: the address-level limit does not clear in 60s; take a fresh pool address
        }
        if (/no account|doesn't exist|not found|invalid email/i.test(b)) {
          log("EMAIL NOT REGISTERED — doing signup step first");
          await page.goto("https://accounts.x.ai/sign-up?redirect=grok-com", { waitUntil: "domcontentloaded", timeout: 45000 });
          await page.waitForTimeout(10000);
          await clickAny(page, ["sign up with email"]);
          await page.waitForTimeout(3000);
          await page.locator("input[type=email], input[name=email]").first().fill(email);
          await page.waitForTimeout(500);
          await clickAny(page, ["sign up"]);
          await page.waitForTimeout(8000);
          await page.goto(`https://accounts.x.ai/reset-password?email=${enc}`, { waitUntil: "domcontentloaded", timeout: 45000 });
          await page.waitForTimeout(10000);
          b = await bodyText(page);
          log("reset page after signup:", b.replace(/\s+/g, " ").slice(0, 160));
        }
        // if it didn't auto-send (turnstile gating), click the send button
        if (!/verify your email|code/i.test(b)) {
          const c = await clickAny(page, ["reset password", "send reset code", "send code", "continue"]);
          log("trigger send click:", c);
          await page.waitForTimeout(8000);
          b = await bodyText(page);
          log("reset page after click:", b.replace(/\s+/g, " ").slice(0, 160));
        }
      }

      // ---- code-catch (per inbox, bounded ~9 min / 3 sends) ----
      if (manualCode) { code = manualCode; log("using manual code:", code); break; }
      const t0 = Date.now();
      let sends = 0;
      const triggerSend = async () => {
        sends++;
        if (signupMode) {
          log("re-trigger SIGNUP send #" + sends);
          await page.goto("https://accounts.x.ai/sign-up?redirect=grok-com", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
          await page.waitForTimeout(5000);
          await clickAny(page, ["sign up with email"]);
          await page.waitForTimeout(2500);
          const mi2 = page.locator("input[type=email], input[name=email]").first();
          if (await mi2.count()) { await mi2.fill(email); await mi2.press("Enter").catch(() => {}); }
        } else {
          log("re-trigger reset send #" + sends);
          await page.goto(`https://accounts.x.ai/reset-password?email=${enc}`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        }
        await page.waitForTimeout(3000);
      };
      await triggerSend();
      const freshInbox = seen.size === 0; // no pre-existing codes = fresh pool address (fast delivery OK)
      const warmUntil = Date.now() + (freshInbox ? 8000 : 60000); // warm-up only for recycled inboxes with stale codes
      for (let i = 0; i < 18; i++) { // 30s ticks, ~9 min per inbox
        const msgs = await enatorList(email).catch(() => []);
        for (const m of msgs) {
          const sub = m.subject || "";
          if (signupMode && sub) log("  inbox:", sub.slice(0, 80));
          if (!/SpaceXAI confirmation code/i.test(sub)) {
            // signup-mode greedy: any code-ish subject carrying a 3-3 split code
            if (!(signupMode && /code|verify|confirmation/i.test(sub) && /(\d{3})[\s-](\d{3})/.test(sub))) continue;
          }
          const mm = sub.match(/SpaceXAI confirmation code:\s*(\d{3})[\s-]*(\d{3})/) || sub.match(/(\d{3})[\s-](\d{3})/);
          if (!mm) continue;
          const cv = mm[1] + mm[2];
          if (seen.has(cv)) continue;
          seen.add(cv);
          if (Date.now() < warmUntil) continue; // too fast = stale; skip submission
          code = cv; break;
        }
        if (code) break;
        if (i > 0 && i % 6 === 0) await triggerSend(); // every ~3 min
        await new Promise((r) => setTimeout(r, 30000));
      }
      log("cycle " + cycle + " ended: code=" + (code || "NONE") + " in " + Math.round((Date.now() - t0) / 1000) + "s (sends: " + sends + ")");
    }
    if (!code) { console.error("CODE_TIMEOUT: no code caught in 3 inbox cycles for " + email); process.exit(1); }
    log("code:", code.slice(0, 3) + "-" + code.slice(3));
    // ---- submit code (retry up to 4×: stale codes exhaust, then fresh lands) ----
    let codeOk = false;
    for (let attempt = 0; attempt < 4 && !codeOk; attempt++) {
      if (attempt > 0) {
        log("previous code rejected — re-entering catch for a fresh code");
        await triggerSend();
        const t1 = Date.now();
        const warmUntil = Date.now() + 60000;
        code = null;
        for (let i = 0; i < 18 && !code; i++) {
          const msgs = await enatorList(email).catch(() => []);
          for (const m of msgs) {
            const sub = m.subject || "";
            if (signupMode && sub) log("  inbox:", sub.slice(0, 80));
            if (!/SpaceXAI confirmation code/i.test(sub)) {
              if (!(signupMode && /code|verify|confirmation/i.test(sub) && /(\d{3})[\s-](\d{3})/.test(sub))) continue;
            }
            const mm = sub.match(/SpaceXAI confirmation code:\s*(\d{3})[\s-]*(\d{3})/) || sub.match(/(\d{3})[\s-](\d{3})/);
            if (!mm) continue;
            const cv = mm[1] + mm[2];
            if (seen.has(cv)) continue;
            seen.add(cv);
            if (Date.now() < warmUntil) continue; // too fast = stale
            code = cv; break;
          }
          if (code) break;
          if (i > 0 && i % 6 === 0) {
            await triggerSend();
          }
          await new Promise((r) => setTimeout(r, 30000));
        }
        if (!code) break;
        log("fresh code caught in", Math.round((Date.now() - t1) / 1000), "s:", code.slice(0, 3) + "-" + code.slice(3));
      }
      const codeInput = page.locator("input[name=code]:enabled").first();
      if (await codeInput.count()) await codeInput.fill(code);
      else {
        const anyIn = page.locator("input:not([disabled]):not([type=hidden])").last();
        await anyIn.fill(code).catch(() => {});
      }
      await page.waitForTimeout(500);
      const c1 = await clickAny(page, ["continue", "confirm email", "verify"]);
      log("clicked code-continue:", c1);
      await page.waitForTimeout(7000);
      b = await bodyText(page);
      log("after code:", b.replace(/\s+/g, " ").slice(0, 200));
      codeOk = !/verify your email|enter it below|invalid code/i.test(b);
    }
    if (!codeOk) throw new Error("CODE_REJECTED_X4: no valid code for " + email);

    // ---- 3. set new password ----
    if (/password/i.test(b)) {
      const pws = await page.locator("input[type=password]").count();
      await page.locator("input[type=password]").nth(0).fill(password);
      if (pws >= 2) await page.locator("input[type=password]").nth(1).fill(password);
      await page.waitForTimeout(500);
      const c2 = await clickAny(page, ["reset password", "create account", "save password", "continue", "submit"]);
      log("clicked password-save:", c2);
      await page.waitForTimeout(8000);
    }
    b = await bodyText(page);
    log("post-password page:", b.replace(/\s+/g, " ").slice(0, 200));
    if (/blocked|authentication failure/i.test(b)) throw new Error("ACCOUNT_BLOCKED: " + email);
    if (/successful|password.*(reset|changed|updated)|sign in|account/i.test(b)) log("PASSWORD SET OK");
    // EARLY-ABORT: the post-password page showing a 2FA challenge ("You must provide
    // a second factor ... Google Verify / Use recovery code") means the account has
    // 2FA enrolled → the OAuth consent page will ALWAYS demand the same step-up
    // (verified: every wave-3 wall'd run showed this exact challenge here first, and
    // no run with the clean ACCOUNT page ever hit the consent wall — the old
    // "MFA DETECTED + sso-bypass" hypothesis was a footer "Contact Support" false
    // positive). Abort fast instead of burning the device-flow + consent + poll.
    if (/must provide a second factor/i.test(b)) {
      console.error("MFA_ACCOUNT_EARLY: post-password 2FA challenge for " + email);
      process.exit(3);
    }

    // ---- 4. session: auto via reset OR sign-in fallback ----
    let authed = false;
    await page.waitForTimeout(4000);
    if (await hasSso(ctx)) {
      authed = true;
      log("session auto-established after reset (sso cookie present)");
    }
    if (!authed) {
      log("no sso after reset — doing sign-in");
      authed = await uiLogin(page, ctx, email, password, log);
    }
    log("authed:", authed);
    if (!authed) throw new Error("NO_AUTH: sign-in did not establish a session for " + email);

    // ---- 5. device-flow OAuth mint ----
    const token = await deviceFlow(page, ctx, email, password, log);
    log("TOKEN OK access:", token.access_token.length, "refresh:", token.refresh_token ? token.refresh_token.length : 0, "expires_in:", token.expires_in);

    // ---- 6. registry ----
    const cookies = await ctx.cookies();
    const sso = (cookies.find((c) => c.name === "sso") || {}).value || null;
    const entry = {
      email, password, sso,
      access_token: token.access_token,
      refresh_token: token.refresh_token || "",
      expires_at: Date.now() + (token.expires_in || 21600) * 1000,
      created: new Date().toISOString(),
      model_tier: "basic",
      source: "grok-factory-v2",
    };
    if (registryPath) {
      const reg = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, "utf8")) : [];
      reg.push(entry);
      fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2));
    }
    console.log("ACCOUNT_OK " + JSON.stringify({ email, sso: !!sso, token: token.access_token.length }));
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error("ERROR:", e.message);
    try { await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]); } catch {}
    process.exit(1);
  }
}

main();