import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { windowsStoreIdentity, windowsStoreVersion } from "./windows-store-config.mjs";

const outputDirectory = path.resolve(process.argv[2] || "release");
const packages = fs.readdirSync(outputDirectory).filter((name) => /-windows-store-x64\.appx$/i.test(name));
if (packages.length !== 1) throw new Error(`Expected one Windows Store AppX in ${outputDirectory}, found ${packages.length}`);

const packagePath = path.join(outputDirectory, packages[0]);
if (fs.statSync(packagePath).size < 1_000_000) throw new Error(`${packages[0]} is unexpectedly small`);
const entries = execFileSync("tar", ["-tf", packagePath], { encoding: "utf8" });
if (/AppxSignature\.p7x/i.test(entries)) throw new Error("Store upload package must be unsigned so Microsoft can sign it after certification");
const appxManifest = execFileSync("tar", ["-xOf", packagePath, "AppxManifest.xml"], { encoding: "utf8" });
const identity = windowsStoreIdentity();
const packageManifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
const version = windowsStoreVersion(packageManifest.version);
for (const expected of [
  `Name="${identity.identityName}"`,
  `Publisher='${identity.publisher}'`,
  `Version="${version}"`,
  `Application Id="${identity.applicationId}"`,
  "runFullTrust",
]) {
  if (!appxManifest.includes(expected)) throw new Error(`${packages[0]} manifest is missing ${expected}`);
}
console.log(`Verified unsigned Microsoft Store package ${packages[0]} (${version}).`);
