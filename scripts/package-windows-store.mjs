import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { windowsStoreIdentity, windowsStoreVersion } from "./windows-store-config.mjs";

if (process.platform !== "win32") throw new Error("Microsoft Store AppX packages must be built on Windows");

const manifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
const identity = windowsStoreIdentity();
const storeVersion = windowsStoreVersion(manifest.version);
const buildNumber = storeVersion.split(".").at(-1);
const electronBuilderCli = path.resolve("node_modules/electron-builder/out/cli/cli.js");
const artifactName = "${productName}-${version}-windows-store-${arch}.${ext}";
const args = [
  electronBuilderCli,
  "--win", "appx",
  "--x64",
  "--publish", "never",
  "--config.appx.identityName", identity.identityName,
  "--config.appx.publisher", identity.publisher,
  "--config.appx.publisherDisplayName", identity.publisherDisplayName,
  "--config.appx.applicationId", identity.applicationId,
  "--config.appx.languages", "en-US",
  "--config.appx.backgroundColor", "#12151b",
  "--config.appx.showNameOnTiles", "true",
  "--config.appx.setBuildNumber", "true",
  "--config.appx.artifactName", artifactName,
];

console.log(`Building Microsoft Store AppX ${storeVersion} for ${identity.publisherDisplayName}.`);
const result = spawnSync(process.execPath, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    BUILD_NUMBER: buildNumber,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    CSC_LINK: "",
    CSC_KEY_PASSWORD: "",
    WIN_CSC_LINK: "",
    WIN_CSC_KEY_PASSWORD: "",
  },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
