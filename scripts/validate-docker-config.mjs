#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checkStandalone = process.argv.includes("--check-standalone");
let failures = 0;

const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failures++;
};
const read = (rel) => {
  const p = join(root, rel);
  if (!existsSync(p)) {
    check(false, `${rel} bestaat`);
    return null;
  }
  check(true, `${rel} bestaat`);
  return readFileSync(p, "utf8");
};
const has = (text, re, msg) => check(re.test(text), msg);

const docker = read("Dockerfile");
if (docker) {
  has(docker, /^FROM\s+node:24-bookworm-slim/m, "Dockerfile: node:24-bookworm-slim");
  has(docker, /\.next\/standalone/, "Dockerfile: kopieert .next/standalone");
  has(docker, /\.next\/static/, "Dockerfile: kopieert .next/static");
  has(docker, /COPY[^\n]*\/public/, "Dockerfile: kopieert public");
  has(docker, /^EXPOSE\s+3000/m, "Dockerfile: EXPOSE 3000");
  has(docker, /HEALTHCHECK[\s\S]*\/api\/health/, "Dockerfile: HEALTHCHECK /api/health");
  has(docker, /HOSTNAME=0\.0\.0\.0/, "Dockerfile: HOSTNAME=0.0.0.0");
  has(docker, /DATA_DIR=\/data/, "Dockerfile: DATA_DIR=/data");
  has(docker, /VOLUME\s+\["\/data"\]/, "Dockerfile: VOLUME /data");
  has(docker, /CMD\s+\["node",\s*"server\.js"\]/, "Dockerfile: CMD node server.js");
}

const ignore = read(".dockerignore");
if (ignore) {
  const lines = ignore.split(/\r?\n/).map((l) => l.trim());
  for (const entry of [".env", "data", "node_modules", ".next"]) {
    check(lines.includes(entry), `.dockerignore sluit ${entry} uit`);
  }
}

const compose = read("docker-compose.yml");
if (compose) {
  has(compose, /:\/data["']?\s*$/m, "compose: volume naar /data");
  has(compose, /:3000["']?\s*$/m, "compose: poort 3000");
  has(compose, /OPENROUTER_API_KEY/, "compose: OPENROUTER_API_KEY");
  has(compose, /PICNIC_MIN_ORDER_CENTS/, "compose: PICNIC_MIN_ORDER_CENTS");
  has(compose, /^\s*build:\s*\./m, "compose: build: .");
  has(compose, /image:\s*ghcr\.io\//, "compose: ghcr.io image");
}

const xml = read("unraid/boodschappenlijstje-template.xml");
if (xml) {
  has(xml, /<Container\s+version="2"/, "template: <Container version=\"2\">");
  has(xml, /<WebUI>[^<]+<\/WebUI>/, "template: <WebUI>");
  has(xml, /Target="\/data"/, "template: /data pad");
  has(xml, /Name="OPENROUTER_API_KEY"[^>]*Mask="true"/, "template: OPENROUTER_API_KEY Mask=true");
  has(xml, /<Network>bridge<\/Network>/, "template: bridge netwerk");
  const body = xml.replace(/<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
  const stack = [];
  let wellFormed = true;
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g)) {
    if (m[4]) continue;
    if (m[1]) {
      if (stack.pop() !== m[2]) wellFormed = false;
    } else stack.push(m[2]);
  }
  check(wellFormed && stack.length === 0, "template: well-formed XML (tags gebalanceerd)");
}

const wf = read(".github/workflows/docker-publish.yml");
if (wf) {
  has(wf, /ghcr\.io/, "workflow: ghcr.io");
  has(wf, /linux\/amd64/, "workflow: linux/amd64");
  has(wf, /docker\/build-push-action@v6/, "workflow: build-push-action@v6");
  has(wf, /type=gha/, "workflow: gha cache");
  has(wf, /workflow_dispatch/, "workflow: workflow_dispatch");
}

for (const f of ["Dockerfile", "docker-entrypoint.sh", "docker-compose.yml"]) {
  const p = join(root, f);
  if (existsSync(p)) check(!readFileSync(p, "utf8").includes("\r"), `${f}: geen CRLF`);
}
if (existsSync(join(root, "scripts"))) {
  for (const f of readdirSync(join(root, "scripts")).filter((n) => n.endsWith(".sh"))) {
    check(!readFileSync(join(root, "scripts", f), "utf8").includes("\r"), `scripts/${f}: geen CRLF`);
  }
}

if (checkStandalone) {
  check(existsSync(join(root, ".next", "standalone", "server.js")), ".next/standalone/server.js bestaat");
  check(existsSync(join(root, ".next", "static")), ".next/static bestaat");
}

console.log(failures ? `\n${failures} controle(s) mislukt` : "\nAlle controles geslaagd");
process.exit(failures ? 1 : 0);
