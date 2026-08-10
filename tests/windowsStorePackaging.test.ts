import { describe, expect, it } from "vitest";
import { windowsStoreIdentity, windowsStoreVersion } from "../scripts/windows-store-config.mjs";

describe("Windows Store packaging", () => {
  it("maps beta versions below their eventual stable release", () => {
    expect(windowsStoreVersion("0.2.0-beta.1")).toBe("0.2.0.1");
    expect(windowsStoreVersion("0.2.0")).toBe("0.2.0.65535");
    expect(() => windowsStoreVersion("0.2.0-alpha.1")).toThrow(/stable or beta/);
    expect(() => windowsStoreVersion("0.2.0-beta.65535")).toThrow(/below 65535/);
  });

  it("requires the identity values issued by Partner Center", () => {
    expect(windowsStoreIdentity({
      WINDOWS_STORE_IDENTITY_NAME: "Zw96042.Bordeaux",
      WINDOWS_STORE_PUBLISHER: "CN=Zw96042",
      WINDOWS_STORE_PUBLISHER_DISPLAY_NAME: "Zachary Wilson",
    })).toEqual({
      identityName: "Zw96042.Bordeaux",
      publisher: "CN=Zw96042",
      publisherDisplayName: "Zachary Wilson",
      applicationId: "Bordeaux",
    });
    expect(() => windowsStoreIdentity({})).toThrow(/WINDOWS_STORE_IDENTITY_NAME/);
  });
});
