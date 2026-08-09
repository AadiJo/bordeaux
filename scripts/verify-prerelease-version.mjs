import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const requested = process.argv[2] ?? process.env.RELEASE_VERSION ?? manifest.version;

if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(requested)) {
  throw new Error(`Prerelease version ${requested || "<missing>"} must look like 0.2.0-beta.1`);
}
if (requested !== manifest.version) {
  throw new Error(`Requested prerelease ${requested} must match the checked-in package version ${manifest.version}`);
}

console.log(`Verified Bordeaux beta version ${requested}.`);
