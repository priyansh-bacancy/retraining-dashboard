import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("dashboard uses same-origin Next.js route handlers", async () => {
  const api = await readFile(new URL("app/api.ts", root), "utf8");
  const jobsRoute = await readFile(new URL("app/api/v1/jobs/route.ts", root), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

  assert.match(api, /API_BASE\s*=\s*["']\/api["']/);
  assert.match(jobsRoute, /export async function GET/);
  assert.equal(packageJson.scripts.dev, "next dev");
  assert.equal(packageJson.scripts.build, "next build");
  assert.equal(packageJson.scripts["dev:api"], undefined);
});

test("dashboard package has no Python or separate web-server runtime", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(packageJson.dependencies.fastify, undefined);
  assert.equal(packageJson.dependencies.vinext, undefined);
});
