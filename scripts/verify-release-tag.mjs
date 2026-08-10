import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const argument = process.argv[2];
const isTagBuild = argument !== undefined || process.env.GITHUB_REF_TYPE === "tag";

if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error(`Production version ${manifest.version || "<missing>"} must look like 0.2.0 without a prerelease suffix`);
}

if (!isTagBuild) {
  console.log(`Verified Bordeaux production version ${manifest.version}; release tag check skipped outside a tag build.`);
} else {
  const tag = argument ?? process.env.GITHUB_REF_NAME;
  const expected = `v${manifest.version}`;
  if (tag !== expected) throw new Error(`Release tag ${tag || "<missing>"} must equal package version tag ${expected}`);
  console.log(`Verified release tag ${tag}.`);
}
