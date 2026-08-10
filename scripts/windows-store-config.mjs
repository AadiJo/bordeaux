const VERSION_COMPONENT_MAX = 65_535;

function requireValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Microsoft Store packaging requires ${name}`);
  return value;
}

function requireXmlSafe(value, name) {
  if (/[<>&']/.test(value)) throw new Error(`${name} contains a character that cannot be written safely to the AppX manifest`);
  return value;
}

export function windowsStoreVersion(packageVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(packageVersion);
  if (!match) throw new Error(`Microsoft Store builds require a stable or beta package version, received ${packageVersion}`);
  const components = match.slice(1, 4).map(Number);
  const build = match[4] === undefined ? VERSION_COMPONENT_MAX : Number(match[4]);
  if ([...components, build].some((value) => !Number.isInteger(value) || value < 0 || value > VERSION_COMPONENT_MAX)) {
    throw new Error(`Microsoft Store version components must be between 0 and ${VERSION_COMPONENT_MAX}`);
  }
  if (match[4] !== undefined && build === VERSION_COMPONENT_MAX) {
    throw new Error(`Beta numbers must be below ${VERSION_COMPONENT_MAX} so the stable release can sort after them`);
  }
  return `${components.join(".")}.${build}`;
}

export function windowsStoreIdentity(environment = process.env) {
  const identityName = requireValue(environment, "WINDOWS_STORE_IDENTITY_NAME");
  const publisher = requireXmlSafe(requireValue(environment, "WINDOWS_STORE_PUBLISHER"), "WINDOWS_STORE_PUBLISHER");
  const publisherDisplayName = requireXmlSafe(requireValue(environment, "WINDOWS_STORE_PUBLISHER_DISPLAY_NAME"), "WINDOWS_STORE_PUBLISHER_DISPLAY_NAME");
  const applicationId = environment.WINDOWS_STORE_APPLICATION_ID?.trim() || "Bordeaux";
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(identityName)) throw new Error("WINDOWS_STORE_IDENTITY_NAME must be 3-50 letters, numbers, periods, or dashes");
  if (!/^CN=/.test(publisher)) throw new Error("WINDOWS_STORE_PUBLISHER must be the Partner Center publisher value beginning with CN=");
  if (!/^([A-Za-z][A-Za-z0-9]*)(\.[A-Za-z][A-Za-z0-9]*)*$/.test(applicationId)) {
    throw new Error("WINDOWS_STORE_APPLICATION_ID must contain letter-led alphanumeric fields separated by periods");
  }
  return { identityName, publisher, publisherDisplayName, applicationId };
}
