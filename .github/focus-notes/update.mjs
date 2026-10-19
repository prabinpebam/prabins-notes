#!/usr/bin/env node
/**
 * Update app (DST-06, D-137), run by .github/workflows/update.yml. No dependencies, Node 20 or later.
 *
 *   update.mjs latest <releases.json>     prints version=<x.y.z> if a newer release is out, else version=
 *   update.mjs plan --version <x.y.z> --template <tgz> --bundle <tgz> --out <dir>
 *                                         stages the template-managed files that changed, and plan.json
 *   update.mjs open --plan <dir>          opens or updates the one update pull request (GH_TOKEN)
 *
 * An update changes only allow-listed files that the release's .focus-notes/managed.json lists,
 * never notes/, private/ or the workspace format. The release's template is read in memory, never
 * unpacked, and refused if it holds links. Workflow files are listed, with their SHA-256, for you to
 * copy by hand: the workflow's own token may not change them. Nothing merges by itself.
 */
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const SOURCE = "prabinpebam/focus-notes";
export const BRANCH = "focus-notes/update";
export const BOT = "github-actions[bot]";
export const PIN = ".focus-notes/app.json";
export const MANIFEST = ".focus-notes/managed.json";
export const MIN_AGE_DAYS = 3;

/** The only files an update may ever change, whatever a release's manifest says. */
const ALLOWED = new Set([PIN, MANIFEST, ".github/workflows/pages.yml", ".github/workflows/update.yml", "README.md", "AGENTS.md"]);
const ALLOWED_SCRIPT = /^\.github\/focus-notes\/[A-Za-z0-9._-]+\.mjs$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const SHA256 = /^[0-9a-f]{64}$/;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** -1, 0 or 1. A suffixed version (1.0.0-beta.1) comes before the plain one. */
export function compareVersions(a, b) {
  const x = VERSION.exec(a), y = VERSION.exec(b);
  if (!x || !y) throw new Error(`Not a version: ${x ? b : a}`);
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
  if (x[4] === y[4]) return 0;
  if (!x[4] || !y[4]) return x[4] ? -1 : 1;
  return x[4] < y[4] ? -1 : 1;
}

/** The files a release must have for an instance to take it. */
export const assetsOf = (version) => [`focus-notes-web-${version}.tgz`, `focus-notes-workspace-${version}.tgz`, "SHA256SUMS"];

/**
 * The newest published release tagged exactly v<x.y.z> with a bundle, a template and SHA256SUMS:
 * never a draft, the rolling `preview`, a dry run (`-dryrun`) or any other suffixed tag. Stage exits
 * below 1.0.0 are pre-releases on GitHub, and count. A release must have been out for 3 days, so a
 * bad one can be withdrawn first, unless `skipWait`.
 */
export function pickLatest(releases, { now = Date.now(), skipWait = false } = {}) {
  let best = null;
  for (const r of releases ?? []) {
    if (r?.draft || !/^v\d+\.\d+\.\d+$/.test(r?.tag_name ?? "")) continue;
    const published = Date.parse(r.published_at ?? "");
    if (Number.isNaN(published) || (!skipWait && now - published < MIN_AGE_DAYS * 86_400_000)) continue;
    const version = r.tag_name.slice(1);
    const names = new Set((r.assets ?? []).map((a) => a.name));
    if (assetsOf(version).every((n) => names.has(n)) && (!best || compareVersions(version, best) > 0)) best = version;
  }
  return best;
}

/** The pinned release, as the Deploy app workflow reads it, with the workflows' hashes if recorded. */
export function readPin(text) {
  const pin = JSON.parse(text);
  if (typeof pin?.version !== "string" || !VERSION.test(pin.version)) throw new Error(`${PIN} has no version`);
  if (typeof pin.sha256 !== "string" || !SHA256.test(pin.sha256)) throw new Error(`${PIN} has no SHA-256`);
  const workflows = pin.workflows ?? {};
  for (const [p, h] of Object.entries(workflows)) {
    if (!ALLOWED.has(p) || !isWorkflow(p)) throw new Error(`${PIN} records a hash for ${p}, which isn't a template workflow`);
    if (typeof h !== "string" || !SHA256.test(h)) throw new Error(`${PIN} has a bad SHA-256 for ${p}`);
  }
  return { version: pin.version, sha256: pin.sha256, ...(pin.workflows ? { workflows } : {}) };
}

/** A plain relative path: ASCII segments of letters, digits, `.`, `_` and `-`, never `.` or `..`. */
export function checkPath(p) {
  const ok = typeof p === "string" && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p) && p.split("/").every((s) => s !== "." && s !== "..");
  if (!ok) throw new Error(`Not a plain relative path: ${JSON.stringify(p)}`);
  return p;
}

/** A path an update may change: plain, never notes, private notes, the format or .git, and allow-listed. */
export function checkManagedPath(p) {
  checkPath(p);
  const lower = p.toLowerCase();
  if (lower.split("/").includes(".git") || /^(notes|private)(\/|$)/.test(lower) || [".gitmodules", ".focus-notes/workspace.json"].includes(lower)) {
    throw new Error(`An update never changes ${p}`);
  }
  if (!ALLOWED.has(p) && !ALLOWED_SCRIPT.test(p)) throw new Error(`${p} isn't a template-managed file`);
  return p;
}

/** The template-managed files a manifest lists, checked; it must list the pin. */
export function readManifest(text) {
  const { managed } = JSON.parse(text);
  if (!Array.isArray(managed)) throw new Error(`${MANIFEST} has no managed list`);
  const paths = managed.map(checkManagedPath);
  if (new Set(paths).size !== paths.length) throw new Error(`${MANIFEST} lists a file twice`);
  if (!paths.includes(PIN)) throw new Error(`${MANIFEST} doesn't list ${PIN}`);
  return paths;
}

export const isWorkflow = (p) => p.startsWith(".github/workflows/");

/**
 * A .tgz's regular files, read in memory: path -> bytes. Folders are skipped; links, devices and any
 * other member, a path that isn't plain, a .git segment, a duplicate or a bad header checksum throw.
 */
export function readTgz(gz) {
  const data = gunzipSync(gz);
  const files = new Map();
  let longName = null;
  for (let off = 0; off + 512 <= data.length;) {
    const h = data.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (at, n) => { const s = h.subarray(at, at + n); const z = s.indexOf(0); return s.subarray(0, z < 0 ? n : z).toString("utf8"); };
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (parseInt(field(148, 8).trim(), 8) !== sum) throw new Error("A template member has a bad header checksum");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
    // POSIX ustar has a name prefix; GNU's format ("ustar  ") keeps other fields there.
    const prefix = h.subarray(257, 263).toString("latin1") === "ustar\0" ? field(345, 155) : "";
    const body = data.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "g") continue;
    if (type === "L" || type === "x") {
      const pax = type === "x" ? /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8")) : null;
      if (type === "L") longName = body.toString("utf8").replace(/\0+$/, "");
      else if (pax) longName = pax[1];
      continue;
    }
    const raw = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const name = raw.replace(/^\.\//, "").replace(/\/$/, "");
    if (type === "5" && (name === "" || name === ".")) continue;
    checkPath(name);
    if (name.toLowerCase().split("/").includes(".git")) throw new Error(`The template holds ${name}`);
    if (type === "5") continue;
    if (type !== "0") throw new Error(`The template's ${name} is not a plain file (type ${type})`);
    if (files.has(name)) throw new Error(`The template holds ${name} twice`);
    files.set(name, Buffer.from(body));
  }
  return files;
}

/**
 * What an update to `version` changes. `readNext` reads the release's template, `readCurrent` this
 * repository; each returns the bytes (or text), or null for a missing file. The release's template
 * must pin exactly the bundle that was checked. Files the template no longer has are left alone.
 */
export function planUpdate({ version, bundleSha256, readNext, readCurrent }) {
  const bytes = (x) => (x === null || x === undefined ? null : Buffer.from(x));
  const pin = readPin(bytes(readNext(PIN)));
  if (pin.version !== version) throw new Error(`The release's template pins ${pin.version}, not ${version}`);
  if (pin.sha256 !== bundleSha256) throw new Error("The release's template pins a different bundle from the one checked");
  const write = [], manual = [], hashes = {};
  for (const p of readManifest(bytes(readNext(MANIFEST)))) {
    const next = bytes(readNext(p)), current = bytes(readCurrent(p));
    if (next === null || (current !== null && next.equals(current))) continue;
    if (isWorkflow(p)) { manual.push(p); hashes[p] = sha256(next); } else write.push(p);
  }
  return { version, write, manual, hashes };
}

export const prTitle = (version, actionNeeded = false) => `Update Focus Notes to ${version}${actionNeeded ? " (action needed)" : ""}`;

/** The version an update pull request's title names, or null. */
export const titleVersion = (title) => /^Update Focus Notes to (\S+?)(?: \(action needed\))?$/.exec(title ?? "")?.[1] ?? null;

/**
 * One update pull request at a time, from BRANCH: create it, move it to the new version, or leave it.
 * A version whose pull request was closed without merging is skipped; the next release opens a new one.
 */
export function decide({ version, open, closed }) {
  const mine = (prs) => (prs ?? []).filter((pr) => pr.head?.ref === BRANCH);
  const current = mine(open)[0];
  if (current) return titleVersion(current.title) === version ? { action: "none", number: current.number } : { action: "update", number: current.number };
  const refused = mine(closed).find((pr) => titleVersion(pr.title) === version);
  if (refused) return { action: "none", number: refused.number, closed: true };
  return { action: "create" };
}

/** The bot branch moves only if its tip is the bot's own commit, on one parent on the default branch. */
export function botBranchOk({ tip, compareStatus }) {
  if (tip?.author?.login !== BOT) return { ok: false, reason: `${BRANCH}'s last commit isn't ${BOT}'s; it's left as it is` };
  if ((tip.parents ?? []).length !== 1) return { ok: false, reason: `${BRANCH}'s last commit isn't a single commit; it's left as it is` };
  if (!["identical", "behind"].includes(compareStatus)) return { ok: false, reason: `${BRANCH} isn't based on the default branch; it's left as it is` };
  return { ok: true };
}

export const compareLink = (repo, base) => `https://github.com/${repo}/compare/${base}...${BRANCH}?expand=1`;

export function prBody({ from, version, write, manual, hashes }) {
  const lines = [
    `Focus Notes [${version}](https://github.com/${SOURCE}/releases/tag/v${version}) is out; this repository deploys ${from}.`,
    "",
    "Its web app bundle and this repository's template files were checked against the release's SHA256SUMS and its attestation, made by the release workflow for that exact tag on a GitHub-hosted runner.",
    "",
    "**Changes** (only template-managed files, never your notes):",
    ...write.map((p) => `- \`${p}\``),
  ];
  if (write.some((p) => ALLOWED_SCRIPT.test(p))) lines.push("", "**Review closely:** this changes the update script itself (`.github/focus-notes/`), which runs with permission to write to this repository.");
  if (manual.length) {
    lines.push("", `**Action needed: copy these yourself.** The workflow's token may not change workflow files, so take them from the release's \`focus-notes-workspace-${version}.tgz\` or the template repository, and check each SHA-256:`);
    lines.push(...manual.map((p) => `- \`${p}\`, SHA-256 \`${hashes[p]}\``));
  }
  lines.push("", "Merging deploys the new version. Nothing changes until you merge (DST-06).");
  return lines.join("\n");
}

/** A file's bytes, or null unless it's a regular file whose real path is inside `dir`. */
function readIn(dir, p) {
  const file = join(dir, ...checkPath(p).split("/"));
  try {
    const inside = realpathSync(file).startsWith(realpathSync(dir) + sep);
    return inside && lstatSync(file).isFile() ? readFileSync(file) : null;
  } catch {
    return null;
  }
}

function plan({ version, template, bundle, out }) {
  const next = readTgz(readFileSync(template));
  const current = readPin(readFileSync(PIN, "utf8"));
  const result = planUpdate({ version, bundleSha256: sha256(readFileSync(bundle)), readNext: (p) => next.get(p) ?? null, readCurrent: (p) => readIn(".", p) });
  for (const p of result.write) {
    const to = join(out, "files", ...p.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, next.get(p));
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "plan.json"), JSON.stringify({ ...result, from: current.version }, null, 2));
  console.log(`Update to ${version}: ${result.write.join(", ")}${result.manual.length ? `; copy by hand: ${result.manual.join(", ")}` : ""}`);
}

async function open({ planDir }) {
  const { GH_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_STEP_SUMMARY: summary } = process.env;
  const p = JSON.parse(readFileSync(join(planDir, "plan.json"), "utf8"));
  if (!VERSION.test(p.version) || !p.write.length) throw new Error("plan.json has nothing to change");
  for (const f of [...p.write, ...p.manual]) checkManagedPath(f);
  if (p.write.some(isWorkflow)) throw new Error("A workflow file can't be part of the commit");
  for (const f of p.manual) if (!SHA256.test(p.hashes?.[f] ?? "")) throw new Error(`plan.json has no SHA-256 for ${f}`);
  const api = async (path, method = "GET", body) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      body: body && JSON.stringify(body),
    });
    if (!res.ok) throw Object.assign(new Error(`${method} ${path}: HTTP ${res.status}`), { status: res.status });
    return res.status === 204 ? null : res.json();
  };
  const { default_branch: base } = await api("");
  const head = encodeURIComponent(`${repo.split("/")[0]}:${BRANCH}`);
  const d = decide({ version: p.version, open: await api(`/pulls?state=open&head=${head}`), closed: await api(`/pulls?state=closed&head=${head}&per_page=100`) });
  if (d.action === "none") return console.log(d.closed ? `Pull request #${d.number} for ${p.version} was closed; waiting for a newer release.` : `Pull request #${d.number} already updates to ${p.version}.`);
  const baseSha = (await api(`/git/ref/heads/${base.split("/").map(encodeURIComponent).join("/")}`)).object.sha;
  const baseTree = (await api(`/git/commits/${baseSha}`)).tree.sha;
  const tree = p.write.map((f) => ({ path: f, mode: "100644", type: "blob", content: readFileSync(join(planDir, "files", ...f.split("/")), "utf8") }));
  const { sha: treeSha } = await api("/git/trees", "POST", { base_tree: baseTree, tree });
  const title = prTitle(p.version, p.manual.length > 0);
  const { sha } = await api("/git/commits", "POST", { message: title, tree: treeSha, parents: [baseSha] });
  // The bot branch is one bot commit on the default branch; anything else there is someone's work.
  const existing = await api(`/git/ref/heads/${BRANCH}`).catch((e) => { if (e.status === 404) return null; throw e; });
  const create = () => api("/git/refs", "POST", { ref: `refs/heads/${BRANCH}`, sha });
  if (!existing) {
    await create();
  } else {
    const tip = await api(`/commits/${existing.object.sha}`);
    const parent = tip.parents?.length === 1 ? tip.parents[0].sha : null;
    const compareStatus = parent ? (await api(`/compare/${encodeURIComponent(base)}...${parent}`)).status : null;
    const check = botBranchOk({ tip, compareStatus });
    if (!check.ok) return console.log(`::warning::${check.reason}. Delete the branch to let updates use it again.`);
    try {
      await api(`/git/refs/heads/${BRANCH}`, "PATCH", { sha, force: true });
    } catch (e) {
      if (![404, 422].includes(e.status)) throw e;
      await create();
    }
  }
  const pr = { title, body: prBody(p) };
  try {
    const done = d.action === "create" ? await api("/pulls", "POST", { ...pr, head: BRANCH, base }) : await api(`/pulls/${d.number}`, "PATCH", pr);
    console.log(`Pull request #${done.number}: ${title}`);
  } catch (e) {
    if (e.status !== 403 || d.action !== "create") throw e;
    // Actions may not open pull requests here (a repository setting): the branch is pushed, so link it.
    const link = compareLink(repo, base);
    if (summary) appendFileSync(summary, `### ${title}\n\nThis repository doesn't let GitHub Actions open pull requests, so open it yourself: ${link}\n\n${pr.body}\n`);
    console.log(`::warning::GitHub Actions may not open pull requests in this repository. The branch ${BRANCH} is ready: ${link}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  try {
    if (cmd === "latest") {
      const latest = pickLatest(JSON.parse(readFileSync(rest[0], "utf8")), { skipWait: process.env.SKIP_WAIT === "true" });
      const { version } = readPin(readFileSync(PIN, "utf8"));
      const newer = latest && compareVersions(latest, version) > 0 ? latest : "";
      console.error(newer ? `Focus Notes ${newer} is out; this repository deploys ${version}.` : `Up to date: ${version} (latest taken: ${latest ?? "none"}).`);
      console.log(`version=${newer}`);
    } else if (cmd === "plan") {
      plan({ version: arg("version"), template: arg("template"), bundle: arg("bundle"), out: arg("out") });
    } else if (cmd === "open") {
      await open({ planDir: arg("plan") });
    } else {
      throw new Error("Usage: update.mjs latest <releases.json> | plan ... | open --plan <dir>");
    }
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
