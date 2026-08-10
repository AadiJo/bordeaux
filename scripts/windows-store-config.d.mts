export function windowsStoreVersion(packageVersion: string): string;
export function windowsStoreIdentity(environment?: NodeJS.ProcessEnv): {
  identityName: string;
  publisher: string;
  publisherDisplayName: string;
  applicationId: string;
};
