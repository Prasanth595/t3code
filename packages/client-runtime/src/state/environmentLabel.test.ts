import { describe, expect, it } from "vite-plus/test";

import {
  ENVIRONMENT_NICKNAME_MAX_LENGTH,
  environmentDisplayLabel,
  validateEnvironmentNickname,
  withEnvironmentNickname,
  type EnvironmentLabelSubject,
} from "./environmentLabel.ts";

function environment(
  environmentId: string,
  overrides: Partial<EnvironmentLabelSubject> = {},
): EnvironmentLabelSubject {
  return {
    environmentId,
    label: "SwerveStation",
    displayUrl: null,
    platformOs: null,
    wsl: false,
    ...overrides,
  };
}

function labels(environments: readonly EnvironmentLabelSubject[], primary: string | null = null) {
  return environments.map((entry) => environmentDisplayLabel(entry, environments, primary));
}

describe("environmentDisplayLabel", () => {
  it("shows unique names bare", () => {
    const environments = [
      environment("a", { label: "Fedora", displayUrl: "http://localhost:3773/" }),
      environment("b", { displayUrl: "http://localhost:5964/" }),
    ];
    expect(labels(environments, "a")).toEqual(["Fedora", "SwerveStation"]);
  });

  it("names the client's own environment 'this device' first", () => {
    const environments = [
      environment("primary", { platformOs: "windows", displayUrl: "http://localhost:3773/" }),
      environment("wsl", { platformOs: "linux", wsl: true, displayUrl: "http://localhost:5964/" }),
    ];
    expect(labels(environments, "primary")).toEqual([
      "SwerveStation · this device",
      "SwerveStation · WSL",
    ]);
  });

  it("tells colliding environments apart by OS", () => {
    const environments = [
      environment("a", { platformOs: "windows" }),
      environment("b", { platformOs: "linux" }),
      environment("c", { platformOs: "darwin" }),
    ];
    expect(labels(environments)).toEqual([
      "SwerveStation · Windows",
      "SwerveStation · Linux",
      "SwerveStation · macOS",
    ]);
  });

  it("falls back to host:port without scheme or trailing slash when OS does not differ", () => {
    const environments = [
      environment("a", { platformOs: "linux", displayUrl: "http://192.168.1.20:3773/" }),
      environment("b", { platformOs: "linux", displayUrl: "https://swerve.tail.ts.net/" }),
      environment("c", { platformOs: "linux", displayUrl: "wroll@swerve" }),
    ];
    expect(labels(environments)).toEqual([
      "SwerveStation · 192.168.1.20:3773",
      "SwerveStation · swerve.tail.ts.net",
      "SwerveStation · wroll@swerve",
    ]);
  });

  it("falls back to host:port when the OS is not known yet", () => {
    const environments = [
      environment("a", { platformOs: "windows", displayUrl: "http://10.0.0.2:3773/" }),
      environment("b", { displayUrl: "http://10.0.0.3:3773/" }),
    ];
    expect(labels(environments)).toEqual([
      "SwerveStation · 10.0.0.2:3773",
      "SwerveStation · 10.0.0.3:3773",
    ]);
  });

  it("falls back to a short environment id when nothing else differs", () => {
    const environments = [
      environment("0f4c2a91-aaaa-4bbb-8ccc-111111111111"),
      environment("7d21e6b0-aaaa-4bbb-8ccc-222222222222"),
    ];
    expect(labels(environments)).toEqual(["SwerveStation · 0f4c2a91", "SwerveStation · 7d21e6b0"]);
  });

  it("disambiguates colliding nicknames the same way", () => {
    const environments = [
      environment("primary", { label: "Work", platformOs: "windows" }),
      environment("laptop", { label: "Work", platformOs: "darwin" }),
      environment("box", { label: "Home", platformOs: "linux" }),
    ];
    expect(labels(environments, "primary")).toEqual(["Work · this device", "Work · macOS", "Home"]);
  });
});

describe("environment nicknames", () => {
  it("trims, rejects empty and over-long names", () => {
    expect(validateEnvironmentNickname("  Desk  ")).toEqual({ ok: true, nickname: "Desk" });
    expect(validateEnvironmentNickname("   ").ok).toBe(false);
    expect(validateEnvironmentNickname("x".repeat(ENVIRONMENT_NICKNAME_MAX_LENGTH)).ok).toBe(true);
    expect(validateEnvironmentNickname("x".repeat(ENVIRONMENT_NICKNAME_MAX_LENGTH + 1)).ok).toBe(
      false,
    );
  });

  it("sets and clears one environment's nickname without touching others", () => {
    const set = withEnvironmentNickname({ other: "Laptop" }, "desk", "Desk");
    expect(set).toEqual({ other: "Laptop", desk: "Desk" });
    expect(withEnvironmentNickname(set, "desk", null)).toEqual({ other: "Laptop" });
  });
});
