import { describe, expect, it } from "vitest";
import { classifyUpdate, detectEcosystem, parseTitle } from "~/server/github";

describe("classifyUpdate", () => {
  it("detects patch bumps", () => {
    expect(classifyUpdate("1.2.3", "1.2.4")).toBe("patch");
  });

  it("detects minor bumps", () => {
    expect(classifyUpdate("1.2.3", "1.3.0")).toBe("minor");
  });

  it("detects major bumps", () => {
    expect(classifyUpdate("1.2.3", "2.0.0")).toBe("major");
  });

  it("strips a leading v before comparing", () => {
    expect(classifyUpdate("v1.2.3", "v1.2.4")).toBe("patch");
    expect(classifyUpdate("v1.0.0", "v2.0.0")).toBe("major");
  });

  it("handles two-segment versions", () => {
    expect(classifyUpdate("1.2", "1.3")).toBe("minor");
    expect(classifyUpdate("1.2", "2.0")).toBe("major");
  });

  it("handles a patch bump that extends the segment count", () => {
    expect(classifyUpdate("1.0", "1.0.1")).toBe("patch");
  });

  it("treats double-digit minors correctly", () => {
    expect(classifyUpdate("1.2.0", "1.10.0")).toBe("minor");
  });

  it("returns unknown when either side is missing", () => {
    expect(classifyUpdate(null, "1.0.0")).toBe("unknown");
    expect(classifyUpdate("1.0.0", null)).toBe("unknown");
  });

  it("returns unknown for non-numeric versions", () => {
    expect(classifyUpdate("latest", "edge")).toBe("unknown");
    expect(classifyUpdate("1.0.0", "alpha")).toBe("unknown");
  });

  it("returns unknown when nothing changed in the first three segments", () => {
    expect(classifyUpdate("1.2.3", "1.2.3")).toBe("unknown");
  });
});

describe("parseTitle", () => {
  it("parses a standard Dependabot bump title", () => {
    expect(parseTitle("Bump lodash from 4.17.20 to 4.17.21")).toEqual({
      dependency: "lodash",
      from: "4.17.20",
      to: "4.17.21",
    });
  });

  it("parses titles wrapped in backticks", () => {
    expect(parseTitle("Bump `lodash` from `4.17.20` to `4.17.21`")).toEqual({
      dependency: "lodash",
      from: "4.17.20",
      to: "4.17.21",
    });
  });

  it("strips a conventional-commit prefix", () => {
    expect(parseTitle("chore(deps): bump @types/node from 20.1.0 to 20.2.0")).toEqual({
      dependency: "@types/node",
      from: "20.1.0",
      to: "20.2.0",
    });
  });

  it("stops the version capture at a trailing directory hint", () => {
    expect(parseTitle("Bump axios from 1.6.0 to 1.7.0 in /frontend")).toEqual({
      dependency: "axios",
      from: "1.6.0",
      to: "1.7.0",
    });
  });

  it("is case-insensitive on the bump keyword", () => {
    expect(parseTitle("bump react from 18.2.0 to 19.0.0").dependency).toBe("react");
  });

  it("returns nulls for grouped update titles it cannot parse", () => {
    expect(parseTitle("Bump the npm group with 3 updates")).toEqual({
      dependency: null,
      from: null,
      to: null,
    });
  });
});

describe("detectEcosystem", () => {
  it("maps known Dependabot ecosystem labels", () => {
    expect(detectEcosystem(["npm_and_yarn"])).toBe("npm");
    expect(detectEcosystem(["docker"])).toBe("docker");
    expect(detectEcosystem(["github_actions"])).toBe("github-actions");
    expect(detectEcosystem(["github-actions"])).toBe("github-actions");
    expect(detectEcosystem(["python"])).toBe("pip");
    expect(detectEcosystem(["go_modules"])).toBe("go");
  });

  it("is case-insensitive", () => {
    expect(detectEcosystem(["Docker"])).toBe("docker");
  });

  it("returns the first recognized label when several are present", () => {
    expect(detectEcosystem(["dependencies", "npm_and_yarn"])).toBe("npm");
  });

  it("falls back to other when no label is recognized", () => {
    expect(detectEcosystem(["dependencies"])).toBe("other");
    expect(detectEcosystem([])).toBe("other");
  });
});
