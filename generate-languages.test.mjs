import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("./generate-languages.mjs", import.meta.url);
const mock = `
const repo = (owner, name, fork = false) => ({ owner: { login: owner }, name, fork });
const userPath = process.env.INCLUDE_PRIVATE === "true"
  ? "/user/repos?affiliation=owner"
  : "/users/sosuisen/repos?type=owner";
const orgPath = "/orgs/petajournal/repos?type=" + (process.env.INCLUDE_PRIVATE === "true" ? "all" : "public");
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname + new URL(url).search;
  if (url.startsWith("https://raw.githubusercontent.com/")) {
    return { ok: true, json: async () => ({}) };
  }
  if (path === userPath + "&per_page=100&page=1") {
    return { ok: true, json: async () => [repo("sosuisen", "one"), ...Array.from({ length: 99 }, (_, i) => repo("sosuisen", "fork" + i, true))] };
  }
  if (path === userPath + "&per_page=100&page=2") {
    return { ok: true, json: async () => [] };
  }
  if (path === orgPath + "&per_page=100&page=1") {
    if (process.env.FAIL_ORG === "true") return { ok: false, status: 403, statusText: "Forbidden" };
    return { ok: true, json: async () => [repo("petajournal", "two"), repo("petajournal", "skip"), ...Array.from({ length: 98 }, (_, i) => repo("petajournal", "fork" + i, true))] };
  }
  if (path === orgPath + "&per_page=100&page=2") {
    return { ok: true, json: async () => [repo("sosuisen", "one")] };
  }
  if (path === "/repos/sosuisen/one/languages") {
    return { ok: true, json: async () => ({ JavaScript: 100 }) };
  }
  if (path === "/repos/petajournal/two/languages") {
    return { ok: true, json: async () => ({ Python: 300, HTML: 500 }) };
  }
  throw new Error("Unexpected request: " + path);
};
await import(${JSON.stringify(script.href)});
`;

for (const includePrivate of ["false", "true"]) {
  test(`aggregates user and organization repositories (INCLUDE_PRIVATE=${includePrivate})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "languages-test-"));
    try {
      const output = join(dir, "languages.svg");
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", mock], {
        encoding: "utf8",
        env: {
          ...process.env,
          GH_TOKEN: "test",
          GH_USER: "sosuisen",
          GH_ORGS: "petajournal, PETAJOURNAL",
          INCLUDE_PRIVATE: includePrivate,
          IGNORED_LANGUAGES: "HTML",
          SKIPPED_REPOS: "skip",
          OUTPUT: output,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Repositories: 2/);
      const svg = await readFile(output, "utf8");
      const visibility = includePrivate === "true" ? "public and private repositories" : "public repositories";
      assert.ok(svg.includes(`Languages: sosuisen + petajournal (${visibility})`));
      assert.match(svg, /Python<\/text>.*75\.0%/);
      assert.match(svg, /JavaScript<\/text>.*25\.0%/);
      assert.doesNotMatch(svg, /HTML/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("fails when an organization cannot be listed", async () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", mock], {
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: "test", GH_USER: "sosuisen", GH_ORGS: "petajournal", INCLUDE_PRIVATE: "false", FAIL_ORG: "true" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /403 Forbidden: \/orgs\/petajournal\/repos/);
});
