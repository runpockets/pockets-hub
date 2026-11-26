#!/usr/bin/env node
/**
 * Strict Pockets Hub catalog & submission validator (Node 22+, zero dependencies).
 *
 * Usage:
 *   node scripts/validate-catalog.mjs [catalog.json] [--base <base-catalog.json>] [--offline]
 *   node scripts/validate-catalog.mjs --local <pocket-dir>
 *
 * Environment:
 *   GITHUB_TOKEN           Optional token to avoid GitHub API rate limits in CI.
 *   ALLOW_VERIFIED_CHANGE  Set to "1" by maintainers when intentionally approving
 *                          a `verified: true` change in a PR.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_CATALOG_ENTRIES = 200;
const MAX_ROOT_CONFIG_BYTES = 128 * 1024;
const MAX_SNAPSHOT_FILES = 2000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const REPO_SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_])?$/;
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const IMAGE_RE = /^[^\s-][^\s]*$/;
const HEALTHCHECK_RE = /^\/(?!\/)[^\s?#]*$/;
const STORAGE_PATH_RE = /^\/(?!(?:\.|\.\.)(?:\/|$))[A-Za-z0-9_.-]+(?:\/(?!(?:\.|\.\.)(?:\/|$))[A-Za-z0-9_.-]+)*$/;
const PREVIEW_HOST_RE = /^(?!.*\.(?:localhost|local|internal|test|invalid)$)(?!.*\.home\.arpa$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ENV_NAME_RE = /^(?!(?:HOST|PORT|DATA_DIR)$)(?!POCKETS_)[A-Za-z_][A-Za-z0-9_]*$/;
const HIDDEN_DISPLAY_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/;

const EXCLUDED_DIRS = new Set([".git", "node_modules", "data", "dist", "target"]);
const FORBIDDEN_CREDENTIAL_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
]);
const FORBIDDEN_CREDENTIAL_EXTS = new Set([".pem", ".key", ".p12", ".pfx"]);
const ALLOWED_CATALOG_ENTRY_KEYS = new Set(["repo", "name", "description", "verified", "ref"]);

const STARTER_PLACEHOLDER_DESCRIPTIONS = [
  "a small persistent web app you control",
  "a minimal pocket starter",
  "minimal hello pocket",
  "starter pocket",
];

// ---------------------------------------------------------------------------
// Minimal strict YAML subset parser for `pocket.yaml` (zero dependencies).
// Rejects multi-document streams, anchors/aliases, merge keys, and duplicate
// keys — matching Pockets' canonical manifest parser.
// ---------------------------------------------------------------------------

function stripYamlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function parseYamlScalar(raw, lineNo) {
  const s = raw.trim();
  if (s === "") return "";
  if (s.startsWith("&") || s.startsWith("*")) {
    throw new Error(`Line ${lineNo}: YAML anchors and aliases are forbidden.`);
  }
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) {
      throw new Error(`Line ${lineNo}: Unterminated double-quoted string.`);
    }
    try {
      return JSON.parse(s);
    } catch (err) {
      throw new Error(`Line ${lineNo}: Invalid double-quoted string (${err.message}).`);
    }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) {
      throw new Error(`Line ${lineNo}: Unterminated single-quoted string.`);
    }
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    const items = [];
    let current = "";
    let quote = null;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (quote) {
        current += ch;
        if (ch === "\\" && quote === '"') {
          current += inner[++i] ?? "";
        } else if (ch === quote) {
          quote = null;
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === ",") {
        items.push(parseYamlScalar(current, lineNo));
        current = "";
      } else {
        current += ch;
      }
    }
    items.push(parseYamlScalar(current, lineNo));
    return items;
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?[0-9]+$/.test(s)) return Number(s);
  return s;
}

export function parseStrictPocketYaml(text) {
  if (Buffer.byteLength(text, "utf8") > MAX_ROOT_CONFIG_BYTES) {
    throw new Error("pocket.yaml exceeds the 128 KiB size limit.");
  }
  if (text.includes("\t")) {
    throw new Error("pocket.yaml must use spaces, not tabs, for indentation.");
  }
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  const lines = [];
  let sawDocStart = false;
  for (let idx = 0; idx < rawLines.length; idx++) {
    const lineNo = idx + 1;
    const cleaned = stripYamlComment(rawLines[idx]);
    const trimmed = cleaned.trim();
    if (trimmed === "") continue;
    if (trimmed === "---") {
      if (sawDocStart || lines.length > 0) {
        throw new Error(`Line ${lineNo}: Multiple YAML documents are forbidden.`);
      }
      sawDocStart = true;
      continue;
    }
    if (trimmed === "...") {
      break;
    }
    const indent = cleaned.length - cleaned.trimStart().length;
    lines.push({ indent, text: trimmed, lineNo });
  }

  let cursor = 0;

  function parseBlock(minIndent) {
    if (cursor >= lines.length) return {};
    if (lines[cursor].text.startsWith("- ") || lines[cursor].text === "-") {
      return parseSeq(lines[cursor].indent);
    }
    return parseMap(minIndent);
  }

  function splitKeyValue(text, lineNo) {
    let quote = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\" && quote === '"') i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ":" && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
        const key = text.slice(0, i).trim();
        const val = text.slice(i + 1).trim();
        if (key === "<<") {
          throw new Error(`Line ${lineNo}: YAML merge keys (<<) are forbidden.`);
        }
        return [key.replace(/^["']|["']$/g, ""), val];
      }
    }
    throw new Error(`Line ${lineNo}: Expected 'key: value' mapping entry.`);
  }

  function parseMap(expectedIndent) {
    const obj = {};
    while (cursor < lines.length) {
      const { indent, text, lineNo } = lines[cursor];
      if (indent < expectedIndent) break;
      if (indent > expectedIndent) {
        throw new Error(`Line ${lineNo}: Unexpected indentation.`);
      }
      if (text.startsWith("- ") || text === "-") break;
      const [key, valStr] = splitKeyValue(text, lineNo);
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        throw new Error(`Line ${lineNo}: Duplicate YAML key '${key}'.`);
      }
      cursor++;
      if (valStr === "") {
        if (cursor < lines.length && lines[cursor].indent > indent) {
          obj[key] = parseBlock(lines[cursor].indent);
        } else {
          obj[key] = null;
        }
      } else {
        if (valStr === "|" || valStr === ">" || valStr === "|-" || valStr === ">-") {
          throw new Error(`Line ${lineNo}: Block scalars are not supported for '${key}'.`);
        }
        obj[key] = parseYamlScalar(valStr, lineNo);
      }
    }
    return obj;
  }

  function parseSeq(seqIndent) {
    const arr = [];
    while (cursor < lines.length) {
      const { indent, text, lineNo } = lines[cursor];
      if (indent < seqIndent) break;
      if (indent > seqIndent) {
        throw new Error(`Line ${lineNo}: Unexpected sequence indentation.`);
      }
      if (!(text.startsWith("- ") || text === "-")) break;
      const rest = text === "-" ? "" : text.slice(2).trim();
      cursor++;
      if (rest === "") {
        if (cursor < lines.length && lines[cursor].indent > seqIndent) {
          arr.push(parseBlock(lines[cursor].indent));
        } else {
          arr.push(null);
        }
      } else if (/^[A-Za-z0-9_.-]+\s*:/.test(rest)) {
        // Inline first key of an object item inside a sequence.
        const itemIndent = indent + 2;
        const [k, vStr] = splitKeyValue(rest, lineNo);
        const item = {};
        if (vStr === "") {
          item[k] = cursor < lines.length && lines[cursor].indent > itemIndent
            ? parseBlock(lines[cursor].indent)
            : null;
        } else {
          item[k] = parseYamlScalar(vStr, lineNo);
        }
        if (cursor < lines.length && lines[cursor].indent >= itemIndent) {
          const more = parseMap(lines[cursor].indent);
          for (const [mk, mv] of Object.entries(more)) {
            if (Object.prototype.hasOwnProperty.call(item, mk)) {
              throw new Error(`Line ${lineNo}: Duplicate YAML key '${mk}'.`);
            }
            item[mk] = mv;
          }
        }
        arr.push(item);
      } else {
        arr.push(parseYamlScalar(rest, lineNo));
      }
    }
    return arr;
  }

  const parsed = parseBlock(lines[0]?.indent ?? 0);
  if (cursor < lines.length) {
    throw new Error(`Line ${lines[cursor].lineNo}: Unexpected trailing content.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("pocket.yaml root must be a YAML mapping.");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Strict pocket.yaml schema & content validation
// ---------------------------------------------------------------------------

function checkNoUnknownKeys(obj, allowed, scope, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push(`${scope}: unknown field '${key}' is not allowed.`);
    }
  }
}

function checkDisplayLine(value, maxLen, field, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string.`);
    return;
  }
  if (value.length > maxLen) {
    errors.push(`${field} must be at most ${maxLen} characters.`);
  }
  if (HIDDEN_DISPLAY_RE.test(value)) {
    errors.push(`${field} must be a single line with no control or bidi characters.`);
  }
}

export function validatePocketManifest(yamlText) {
  const errors = [];
  let manifest;
  try {
    manifest = parseStrictPocketYaml(yamlText);
  } catch (err) {
    return { ok: false, errors: [`pocket.yaml parse error: ${err.message}`], manifest: null };
  }

  checkNoUnknownKeys(
    manifest,
    new Set([
      "apiVersion",
      "kind",
      "metadata",
      "runtime",
      "web",
      "storage",
      "previewApis",
      "runtimeVariables",
    ]),
    "pocket.yaml",
    errors,
  );

  if (manifest.apiVersion !== "pockets.dev/v1alpha1") {
    errors.push("apiVersion must be 'pockets.dev/v1alpha1'.");
  }
  if (manifest.kind !== "Pocket") {
    errors.push("kind must be 'Pocket'.");
  }

  // metadata
  const md = manifest.metadata;
  if (!md || typeof md !== "object" || Array.isArray(md)) {
    errors.push("metadata must be an object.");
  } else {
    checkNoUnknownKeys(md, new Set(["id", "name", "version", "description"]), "metadata", errors);
    if (typeof md.id !== "string" || !ID_RE.test(md.id) || md.id.length > 63) {
      errors.push("metadata.id must be a lowercase alphanumeric slug with single hyphens (max 63 chars).");
    }
    checkDisplayLine(md.name, 80, "metadata.name", errors);
    checkDisplayLine(md.version, 64, "metadata.version", errors);
    checkDisplayLine(md.description, 240, "metadata.description", errors);
    if (typeof md.description === "string") {
      const lower = md.description.trim().toLowerCase();
      if (
        lower.includes("__pocket_") ||
        STARTER_PLACEHOLDER_DESCRIPTIONS.some((p) => lower === p || lower.startsWith(p))
      ) {
        errors.push("metadata.description still contains a starter placeholder; describe what your Pocket does.");
      }
    }
  }

  // runtime
  const rt = manifest.runtime;
  if (!rt || typeof rt !== "object" || Array.isArray(rt)) {
    errors.push("runtime must be an object.");
  } else {
    checkNoUnknownKeys(rt, new Set(["image", "architectures"]), "runtime", errors);
    if (typeof rt.image !== "string" || !IMAGE_RE.test(rt.image)) {
      errors.push("runtime.image must be a valid non-empty image reference without spaces or leading '-'.");
    }
    if (!Array.isArray(rt.architectures) || rt.architectures.length < 1 || rt.architectures.length > 2) {
      errors.push("runtime.architectures must contain 1 or 2 architectures ('arm64', 'amd64').");
    } else {
      const seen = new Set();
      for (const arch of rt.architectures) {
        if (arch !== "arm64" && arch !== "amd64") {
          errors.push(`runtime.architectures contains unsupported architecture '${arch}'.`);
        } else if (seen.has(arch)) {
          errors.push(`runtime.architectures contains duplicate architecture '${arch}'.`);
        }
        seen.add(arch);
      }
    }
  }

  // web
  const web = manifest.web;
  if (!web || typeof web !== "object" || Array.isArray(web)) {
    errors.push("web must be an object.");
  } else {
    checkNoUnknownKeys(web, new Set(["port", "healthcheck"]), "web", errors);
    if (!Number.isInteger(web.port) || web.port < 1 || web.port > 65535) {
      errors.push("web.port must be an integer between 1 and 65535.");
    }
    if (typeof web.healthcheck !== "string" || !HEALTHCHECK_RE.test(web.healthcheck)) {
      errors.push("web.healthcheck must be an absolute path like '/health' with no query string or spaces.");
    }
  }

  // storage
  const storage = manifest.storage;
  if (!storage || typeof storage !== "object" || Array.isArray(storage)) {
    errors.push("storage must be an object.");
  } else {
    checkNoUnknownKeys(storage, new Set(["name", "path"]), "storage", errors);
    if (typeof storage.name !== "string" || !ID_RE.test(storage.name) || storage.name.length > 63) {
      errors.push("storage.name must be a lowercase alphanumeric slug with single hyphens (max 63 chars).");
    }
    if (typeof storage.path !== "string" || !STORAGE_PATH_RE.test(storage.path)) {
      errors.push("storage.path must be a clean absolute container path like '/data'.");
    }
  }

  // previewApis (optional)
  if (manifest.previewApis !== undefined) {
    if (!Array.isArray(manifest.previewApis)) {
      errors.push("previewApis must be an array.");
    } else {
      if (manifest.previewApis.length > 16) {
        errors.push("previewApis supports at most 16 entries.");
      }
      const hosts = new Set();
      manifest.previewApis.forEach((api, idx) => {
        const scope = `previewApis[${idx}]`;
        if (!api || typeof api !== "object" || Array.isArray(api)) {
          errors.push(`${scope} must be an object.`);
          return;
        }
        checkNoUnknownKeys(api, new Set(["host", "name", "purpose"]), scope, errors);
        if (typeof api.host !== "string" || api.host.length > 253 || !PREVIEW_HOST_RE.test(api.host)) {
          errors.push(`${scope}.host must be a lowercase public hostname (no schemes, ports, paths, or private TLDs).`);
        } else if (hosts.has(api.host)) {
          errors.push(`${scope}.host '${api.host}' is duplicated.`);
        } else {
          hosts.add(api.host);
        }
        checkDisplayLine(api.name, 80, `${scope}.name`, errors);
        checkDisplayLine(api.purpose, 240, `${scope}.purpose`, errors);
      });
    }
  }

  // runtimeVariables (optional)
  if (manifest.runtimeVariables !== undefined) {
    if (!Array.isArray(manifest.runtimeVariables)) {
      errors.push("runtimeVariables must be an array.");
    } else {
      if (manifest.runtimeVariables.length > 32) {
        errors.push("runtimeVariables supports at most 32 entries.");
      }
      const names = new Set();
      manifest.runtimeVariables.forEach((v, idx) => {
        const scope = `runtimeVariables[${idx}]`;
        if (!v || typeof v !== "object" || Array.isArray(v)) {
          errors.push(`${scope} must be an object.`);
          return;
        }
        checkNoUnknownKeys(v, new Set(["name", "kind", "purpose", "required"]), scope, errors);
        if (typeof v.name !== "string" || v.name.length > 128 || !ENV_NAME_RE.test(v.name)) {
          errors.push(`${scope}.name must be a valid non-reserved environment variable name.`);
        } else if (names.has(v.name)) {
          errors.push(`${scope}.name '${v.name}' is duplicated.`);
        } else {
          names.add(v.name);
        }
        if (v.kind !== "secret" && v.kind !== "plain") {
          errors.push(`${scope}.kind must be 'secret' or 'plain'.`);
        }
        checkDisplayLine(v.purpose, 240, `${scope}.purpose`, errors);
        if (v.required !== undefined && typeof v.required !== "boolean") {
          errors.push(`${scope}.required must be a boolean.`);
        }
      });
    }
  }

  return { ok: errors.length === 0, errors, manifest };
}

// ---------------------------------------------------------------------------
// Strict Containerfile security audit
// ---------------------------------------------------------------------------

export function validateContainerfile(text) {
  const errors = [];
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, errors: ["Containerfile must be non-empty."] };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_ROOT_CONFIG_BYTES) {
    errors.push("Containerfile exceeds the 128 KiB size limit.");
  }

  // Join backslash-continued lines for instruction inspection.
  const logicalLines = [];
  let buf = "";
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      if (buf) {
        logicalLines.push(buf);
        buf = "";
      }
      continue;
    }
    if (trimmed.endsWith("\\")) {
      buf += `${trimmed.slice(0, -1)} `;
    } else {
      logicalLines.push((buf + trimmed).trim());
      buf = "";
    }
  }
  if (buf) logicalLines.push(buf.trim());

  let fromCount = 0;
  let lastUser = null;

  for (const line of logicalLines) {
    const match = /^([A-Za-z]+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const instr = match[1].toUpperCase();
    const args = match[2].trim();

    if (instr === "FROM") {
      fromCount++;
      lastUser = null; // New stage resets active user.
    } else if (instr === "USER") {
      const userSpec = args.split(/\s+/)[0] ?? "";
      lastUser = userSpec;
    } else if (instr === "ADD") {
      if (/\bhttps?:\/\//i.test(args)) {
        errors.push("Containerfile must not use 'ADD http(s)://...' to fetch unverified remote URLs during build.");
      }
    } else if (instr === "RUN") {
      if (/\b(?:curl|wget)\b[^|]*\|\s*(?:ba|z|da)?sh\b/i.test(args)) {
        errors.push("Containerfile must not pipe curl/wget directly into a shell in RUN instructions.");
      }
      if (/\b(?:docker|podman)\.sock\b/i.test(args)) {
        errors.push("Containerfile must not reference container engine sockets.");
      }
      if (/--privileged\b/i.test(args)) {
        errors.push("Containerfile must not use --privileged.");
      }
    } else if (instr === "ENV") {
      const secretAssign = /\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*)\s*(?:=|\s+)\s*([^\s]+)/i.exec(args);
      if (secretAssign) {
        const val = secretAssign[2].replace(/^["']|["']$/g, "");
        if (val !== "" && !val.startsWith("$")) {
          errors.push(`Containerfile ENV '${secretAssign[1]}' appears to hardcode a credential; declare it under runtimeVariables instead.`);
        }
      }
    }
  }

  if (fromCount === 0) {
    errors.push("Containerfile must contain at least one FROM instruction.");
  }
  if (!lastUser) {
    errors.push("Containerfile must end its final stage with a non-root USER instruction (for example, 'USER node').");
  } else {
    const userPart = lastUser.split(":")[0].toLowerCase();
    if (userPart === "root" || userPart === "0") {
      errors.push("Containerfile final USER must be non-root (found root/0).");
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// File tree hygiene audit (shared by GitHub tree & local directory checks)
// ---------------------------------------------------------------------------

export function validateTreeEntries(entries) {
  const errors = [];
  let count = 0;
  let totalBytes = 0;
  let hasReadme = false;
  let hasLicense = false;

  for (const entry of entries) {
    const rel = entry.path.replace(/\\/g, "/").replace(/^\.\//, "");
    const parts = rel.split("/");
    if (parts.some((p) => EXCLUDED_DIRS.has(p))) continue;

    if (entry.isSymlink) {
      errors.push(`Repository contains symbolic link '${rel}' (Pockets rejects symlinks).`);
      continue;
    }

    const base = parts[parts.length - 1];
    const baseLower = base.toLowerCase();
    if (parts.length === 1) {
      if (baseLower === "readme.md" || baseLower === "readme") hasReadme = true;
      if (baseLower === "license" || baseLower === "license.md" || baseLower === "license.txt") {
        hasLicense = true;
      }
    }

    if (FORBIDDEN_CREDENTIAL_NAMES.has(baseLower)) {
      errors.push(`Repository commits secret/credential file '${rel}'. Remove it before submitting.`);
    }
    const ext = path.extname(baseLower);
    if (FORBIDDEN_CREDENTIAL_EXTS.has(ext)) {
      errors.push(`Repository commits private key/certificate '${rel}'. Remove it before submitting.`);
    }

    if (entry.size > MAX_FILE_BYTES) {
      errors.push(`File '${rel}' exceeds Pockets' 5 MiB per-file snapshot limit.`);
    }
    count++;
    totalBytes += entry.size;
  }

  if (count > MAX_SNAPSHOT_FILES) {
    errors.push(`Repository contains ${count} files (exceeds Pockets' 2,000 file limit).`);
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    errors.push(`Repository exceeds Pockets' 50 MiB total snapshot limit.`);
  }
  if (!hasReadme) {
    errors.push("Repository must include a root README.md.");
  }
  if (!hasLicense) {
    errors.push("Repository must include a root LICENSE file.");
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Catalog JSON & PR diff validation
// ---------------------------------------------------------------------------

export function validateCatalogStructure(rawBytes, baseRawBytes = null, options = {}) {
  const errors = [];
  if (rawBytes.length > MAX_CATALOG_BYTES) {
    return { ok: false, errors: ["catalog.json exceeds the 512 KiB maximum size."], catalog: null };
  }
  let catalog;
  try {
    catalog = JSON.parse(rawBytes.toString("utf8"));
  } catch (err) {
    return { ok: false, errors: [`catalog.json is not valid JSON: ${err.message}`], catalog: null };
  }

  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    return { ok: false, errors: ["catalog.json root must be a JSON object."], catalog: null };
  }
  checkNoUnknownKeys(catalog, new Set(["version", "pockets"]), "catalog.json", errors);
  if (catalog.version !== 1) {
    errors.push("catalog.json 'version' must be 1.");
  }
  if (!Array.isArray(catalog.pockets)) {
    errors.push("catalog.json 'pockets' must be an array.");
    return { ok: false, errors, catalog: null };
  }
  if (catalog.pockets.length > MAX_CATALOG_ENTRIES) {
    errors.push(`catalog.json supports at most ${MAX_CATALOG_ENTRIES} entries.`);
  }

  const seenRepos = new Set();
  catalog.pockets.forEach((entry, idx) => {
    const scope = `pockets[${idx}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${scope} must be an object.`);
      return;
    }
    checkNoUnknownKeys(entry, ALLOWED_CATALOG_ENTRY_KEYS, scope, errors);
    if (typeof entry.repo !== "string" || !REPO_SLUG_RE.test(entry.repo) || entry.repo.includes("..")) {
      errors.push(`${scope}.repo must be a valid GitHub 'owner/repo' slug.`);
    } else {
      const lower = entry.repo.toLowerCase();
      if (seenRepos.has(lower)) {
        errors.push(`${scope}.repo '${entry.repo}' is duplicated in catalog.json.`);
      }
      seenRepos.add(lower);
    }
    if (entry.name !== undefined) {
      checkDisplayLine(entry.name, 80, `${scope}.name`, errors);
    }
    if (entry.description !== undefined) {
      checkDisplayLine(entry.description, 240, `${scope}.description`, errors);
    }
    if (entry.verified !== undefined && typeof entry.verified !== "boolean") {
      errors.push(`${scope}.verified must be a boolean.`);
    }
    if (entry.ref !== undefined) {
      if (typeof entry.ref !== "string" || !/^[A-Za-z0-9._/-]{1,100}$/.test(entry.ref) || entry.ref.includes("..")) {
        errors.push(`${scope}.ref must be a valid git ref or commit SHA.`);
      }
    }
  });

  // PR diff guard: prevent non-maintainers from self-assigning `verified: true`.
  if (baseRawBytes && !options.allowVerifiedChange) {
    let baseCatalog = null;
    try {
      baseCatalog = JSON.parse(baseRawBytes.toString("utf8"));
    } catch {
      baseCatalog = null;
    }
    const baseVerified = new Map();
    if (baseCatalog && Array.isArray(baseCatalog.pockets)) {
      for (const entry of baseCatalog.pockets) {
        if (entry && typeof entry.repo === "string") {
          baseVerified.set(entry.repo.toLowerCase(), entry.verified === true);
        }
      }
    }
    for (const entry of catalog.pockets) {
      if (!entry || typeof entry.repo !== "string") continue;
      const wasVerified = baseVerified.get(entry.repo.toLowerCase()) === true;
      if (entry.verified === true && !wasVerified) {
        errors.push(
          `${entry.repo}: community submissions must set "verified": false (only maintainers grant Verified status).`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, catalog };
}

// ---------------------------------------------------------------------------
// Remote GitHub repository validator
// ---------------------------------------------------------------------------

async function githubFetch(url, headers = {}) {
  const token = process.env.GITHUB_TOKEN;
  const reqHeaders = {
    "User-Agent": "pockets-hub-validator/1",
    ...headers,
  };
  if (token) {
    reqHeaders.Authorization = `Bearer ${token}`;
  }
  return fetch(url, { headers: reqHeaders, signal: AbortSignal.timeout(15_000) });
}

async function validateRemoteRepo(entry) {
  const errors = [];
  const slug = entry.repo;
  const repoRes = await githubFetch(`https://api.github.com/repos/${slug}`, {
    Accept: "application/vnd.github+json",
  });
  if (repoRes.status === 404) {
    return { ok: false, errors: [`${slug}: repository not found or private.`], manifestId: null };
  }
  if (!repoRes.ok) {
    return { ok: false, errors: [`${slug}: GitHub API returned HTTP ${repoRes.status}.`], manifestId: null };
  }
  const meta = await repoRes.json();
  if (meta.private) errors.push(`${slug}: repository must be public.`);
  if (meta.archived) errors.push(`${slug}: archived repositories cannot be listed.`);
  if (meta.disabled) errors.push(`${slug}: disabled repositories cannot be listed.`);

  const ref = entry.ref || meta.default_branch || "HEAD";
  const rawBase = `https://raw.githubusercontent.com/${slug}/${encodeURIComponent(ref)}`;

  const [manifestRes, cfRes, treeRes] = await Promise.all([
    githubFetch(`${rawBase}/pocket.yaml`),
    githubFetch(`${rawBase}/Containerfile`),
    githubFetch(`https://api.github.com/repos/${slug}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
      Accept: "application/vnd.github+json",
    }),
  ]);

  let manifestId = null;
  if (!manifestRes.ok) {
    errors.push(`${slug}: missing root pocket.yaml (HTTP ${manifestRes.status}).`);
  } else {
    const yamlText = await manifestRes.text();
    const res = validatePocketManifest(yamlText);
    if (!res.ok) {
      errors.push(...res.errors.map((e) => `${slug}: ${e}`));
    } else {
      manifestId = res.manifest.metadata.id;
    }
  }

  if (!cfRes.ok) {
    errors.push(`${slug}: missing root Containerfile (HTTP ${cfRes.status}).`);
  } else {
    const cfText = await cfRes.text();
    const cf = validateContainerfile(cfText);
    if (!cf.ok) {
      errors.push(...cf.errors.map((e) => `${slug}: ${e}`));
    }
  }

  if (treeRes.ok) {
    const treeJson = await treeRes.json();
    if (treeJson.truncated) {
      errors.push(`${slug}: repository tree is too large for Pockets snapshot limits.`);
    } else if (Array.isArray(treeJson.tree)) {
      const normalized = treeJson.tree
        .filter((node) => node.type === "blob")
        .map((node) => ({
          path: node.path,
          size: node.size ?? 0,
          isSymlink: node.mode === "120000",
        }));
      const treeCheck = validateTreeEntries(normalized);
      if (!treeCheck.ok) {
        errors.push(...treeCheck.errors.map((e) => `${slug}: ${e}`));
      }
    }
  }

  return { ok: errors.length === 0, errors, manifestId };
}

// ---------------------------------------------------------------------------
// Local directory validation mode (--local <dir>)
// ---------------------------------------------------------------------------

function walkLocalDir(root, dir = root, out = []) {
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(dirent.name)) continue;
    const full = path.join(dir, dirent.name);
    const rel = path.relative(root, full).replace(/\\/g, "/");
    if (dirent.isSymbolicLink()) {
      out.push({ path: rel, size: 0, isSymlink: true });
    } else if (dirent.isDirectory()) {
      walkLocalDir(root, full, out);
    } else if (dirent.isFile()) {
      const stat = fs.statSync(full);
      out.push({ path: rel, size: stat.size, isSymlink: false });
    }
  }
  return out;
}

export function validateLocalPocketDir(dir) {
  const errors = [];
  const manifestPath = path.join(dir, "pocket.yaml");
  const cfPath = path.join(dir, "Containerfile");

  if (!fs.existsSync(manifestPath)) {
    errors.push("Missing root pocket.yaml.");
  } else {
    const res = validatePocketManifest(fs.readFileSync(manifestPath, "utf8"));
    errors.push(...res.errors);
  }

  if (!fs.existsSync(cfPath)) {
    errors.push("Missing root Containerfile.");
  } else {
    const res = validateContainerfile(fs.readFileSync(cfPath, "utf8"));
    errors.push(...res.errors);
  }

  const tree = validateTreeEntries(walkLocalDir(dir));
  errors.push(...tree.errors);

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let catalogPath = "catalog.json";
  let basePath = null;
  let localDir = null;
  let offline = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base") {
      basePath = args[++i];
    } else if (args[i] === "--local") {
      localDir = args[++i];
    } else if (args[i] === "--offline") {
      offline = true;
    } else if (!args[i].startsWith("-")) {
      catalogPath = args[i];
    }
  }

  if (localDir) {
    const result = validateLocalPocketDir(localDir);
    if (!result.ok) {
      for (const err of result.errors) console.error(`ERROR: ${err}`);
      process.exit(1);
    }
    console.log(`OK: ${localDir} passes all Pockets Hub submission checks.`);
    return;
  }

  const raw = fs.readFileSync(catalogPath);
  const baseRaw = basePath && fs.existsSync(basePath) ? fs.readFileSync(basePath) : null;
  const allowVerifiedChange = process.env.ALLOW_VERIFIED_CHANGE === "1";

  const structural = validateCatalogStructure(raw, baseRaw, { allowVerifiedChange });
  if (!structural.ok) {
    for (const err of structural.errors) console.error(`ERROR: ${err}`);
    process.exit(1);
  }

  if (offline) {
    console.log(`OK (offline): ${structural.catalog.pockets.length} catalog entries passed structural checks.`);
    return;
  }

  const allErrors = [];
  const manifestIds = new Map();
  for (const entry of structural.catalog.pockets) {
    const res = await validateRemoteRepo(entry);
    if (!res.ok) {
      allErrors.push(...res.errors);
    } else {
      if (res.manifestId) {
        const lowerId = res.manifestId.toLowerCase();
        if (manifestIds.has(lowerId)) {
          allErrors.push(
            `${entry.repo}: metadata.id '${res.manifestId}' collides with ${manifestIds.get(lowerId)}.`,
          );
        } else {
          manifestIds.set(lowerId, entry.repo);
        }
      }
      console.log(`OK: ${entry.repo} (id: ${res.manifestId})`);
    }
  }

  if (allErrors.length > 0) {
    for (const err of allErrors) console.error(`ERROR: ${err}`);
    process.exit(1);
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisFile)) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
