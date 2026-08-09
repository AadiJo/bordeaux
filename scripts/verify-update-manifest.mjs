import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import yaml from "js-yaml";

const platform = process.argv[2];
const outputDirectory = path.resolve(process.argv[3] ?? "release");
const manifestName = platform === "mac" ? "beta-mac.yml" : platform === "windows" ? "beta.yml" : null;
const expectedExtension = platform === "mac" ? ".zip" : platform === "windows" ? ".exe" : null;

if (!manifestName || !expectedExtension) throw new Error("Update manifest platform must be mac or windows");

const packageManifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const manifestPath = path.join(outputDirectory, manifestName);
if (!fs.existsSync(manifestPath)) throw new Error(`Missing ${platform} update manifest: ${manifestPath}`);

const updateManifest = yaml.load(fs.readFileSync(manifestPath, "utf8"));
if (!updateManifest || typeof updateManifest !== "object" || Array.isArray(updateManifest)) {
  throw new Error(`${manifestName} must contain an update manifest object`);
}
if (updateManifest.version !== packageManifest.version) {
  throw new Error(`${manifestName} version ${updateManifest.version ?? "<missing>"} does not match ${packageManifest.version}`);
}
if (!Array.isArray(updateManifest.files) || updateManifest.files.length === 0) {
  throw new Error(`${manifestName} does not reference any update files`);
}

let hasInstallable = false;
for (const entry of updateManifest.files) {
  const url = typeof entry?.url === "string" ? entry.url : "";
  if (!url || path.basename(url) !== url || url.includes("\\")) {
    throw new Error(`${manifestName} contains an unsafe or invalid update URL: ${url || "<missing>"}`);
  }
  const artifact = path.join(outputDirectory, url);
  if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) {
    throw new Error(`${manifestName} references a missing artifact: ${url}`);
  }
  if (typeof entry.sha512 !== "string" || entry.sha512.length < 32) {
    throw new Error(`${manifestName} is missing the SHA-512 digest for ${url}`);
  }
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || fs.statSync(artifact).size !== entry.size) {
    throw new Error(`${manifestName} has an invalid size for ${url}`);
  }
  const digest = createHash("sha512").update(fs.readFileSync(artifact)).digest("base64");
  if (digest !== entry.sha512) throw new Error(`${manifestName} has an invalid SHA-512 digest for ${url}`);
  hasInstallable ||= url.toLowerCase().endsWith(expectedExtension);
}

if (!hasInstallable) throw new Error(`${manifestName} does not reference a ${platform} ${expectedExtension} update`);
console.log(`Verified ${manifestName} for Bordeaux ${packageManifest.version} (${updateManifest.files.length} files).`);
