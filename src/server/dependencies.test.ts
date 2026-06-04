import { describe, expect, it } from "vitest";
import {
  parseDockerfile,
  parsePackageJson,
  parsePyprojectToml,
  parseRequirementsTxt,
} from "~/server/dependencies";

describe("parsePackageJson", () => {
  it("collects runtime and dev dependencies", () => {
    const deps = parsePackageJson(
      JSON.stringify({
        dependencies: { react: "^19.0.0" },
        devDependencies: { vitest: "^4.0.0" },
      }),
    );
    expect(deps).toContainEqual({
      name: "react",
      version: "^19.0.0",
      ecosystem: "npm",
      dev: false,
    });
    expect(deps).toContainEqual({ name: "vitest", version: "^4.0.0", ecosystem: "npm", dev: true });
  });

  it("includes optionalDependencies", () => {
    const deps = parsePackageJson(
      JSON.stringify({
        optionalDependencies: { fsevents: "^2.3.0" },
      }),
    );
    expect(deps).toContainEqual({
      name: "fsevents",
      version: "^2.3.0",
      ecosystem: "npm",
      dev: false,
    });
  });

  it("does not duplicate a package present in both deps and optionalDependencies", () => {
    const deps = parsePackageJson(
      JSON.stringify({
        dependencies: { sharp: "^0.34.0" },
        optionalDependencies: { sharp: "^0.34.0" },
      }),
    );
    expect(deps.filter((d) => d.name === "sharp")).toHaveLength(1);
  });

  it("includes peerDependencies only when not already declared", () => {
    const deps = parsePackageJson(
      JSON.stringify({
        dependencies: { react: "^19.0.0" },
        peerDependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
      }),
    );
    expect(deps.filter((d) => d.name === "react")).toHaveLength(1);
    expect(deps.some((d) => d.name === "react-dom")).toBe(true);
  });

  it("returns an empty array for invalid JSON", () => {
    expect(parsePackageJson("{ not json")).toEqual([]);
  });
});

describe("parseDockerfile", () => {
  it("parses image name and tag", () => {
    expect(parseDockerfile("FROM node:20-alpine")).toEqual([
      { name: "node", version: "20-alpine", ecosystem: "docker", dev: false },
    ]);
  });

  it("handles a registry with a port without mistaking it for a tag", () => {
    const [dep] = parseDockerfile("FROM registry.example.com:5000/team/app");
    expect(dep).toEqual({
      name: "registry.example.com:5000/team/app",
      version: null,
      ecosystem: "docker",
      dev: false,
    });
  });

  it("strips a digest pin", () => {
    const [dep] = parseDockerfile("FROM node:20@sha256:abcdef");
    expect(dep?.name).toBe("node");
    expect(dep?.version).toBe("20");
  });

  it("supports --platform and AS stage aliases", () => {
    const [dep] = parseDockerfile("FROM --platform=linux/amd64 golang:1.22 AS builder");
    expect(dep).toEqual({ name: "golang", version: "1.22", ecosystem: "docker", dev: false });
  });

  it("skips ARG-templated and stage-reference images", () => {
    const out = parseDockerfile(
      ["FROM $BASE_IMAGE", "FROM node:20 AS base", "FROM base AS final"].join("\n"),
    );
    expect(out.map((d) => d.name)).toEqual(["node", "base"]);
  });

  it("ignores comments and deduplicates repeated images", () => {
    const out = parseDockerfile(["# a comment", "FROM node:20", "FROM node:20"].join("\n"));
    expect(out).toHaveLength(1);
  });
});

describe("parseRequirementsTxt", () => {
  it("parses pinned and unpinned requirements", () => {
    const out = parseRequirementsTxt(["flask==2.3.0", "requests"].join("\n"));
    expect(out).toContainEqual({
      name: "flask",
      version: "==2.3.0",
      ecosystem: "python",
      dev: false,
    });
    expect(out).toContainEqual({
      name: "requests",
      version: null,
      ecosystem: "python",
      dev: false,
    });
  });

  it("strips extras from the package name", () => {
    const [dep] = parseRequirementsTxt("uvicorn[standard]>=0.20");
    expect(dep?.name).toBe("uvicorn");
    expect(dep?.version).toBe(">=0.20");
  });

  it("ignores comments, blank lines, and option flags", () => {
    const out = parseRequirementsTxt(
      ["# deps", "", "-r other.txt", "--index-url https://x", "django==5.0"].join("\n"),
    );
    expect(out).toEqual([{ name: "django", version: "==5.0", ecosystem: "python", dev: false }]);
  });

  it("drops an inline comment from the version", () => {
    const [dep] = parseRequirementsTxt("numpy==1.26.0  # pinned for compat");
    expect(dep?.version).toBe("==1.26.0");
  });
});

describe("parsePyprojectToml", () => {
  it("parses PEP 621 dependencies", () => {
    const toml = [
      "[project]",
      'name = "demo"',
      "dependencies = [",
      '  "fastapi>=0.110",',
      '  "pydantic==2.6.0",',
      "]",
    ].join("\n");
    const out = parsePyprojectToml(toml);
    expect(out).toContainEqual({
      name: "fastapi",
      version: ">=0.110",
      ecosystem: "python",
      dev: false,
    });
    expect(out).toContainEqual({
      name: "pydantic",
      version: "==2.6.0",
      ecosystem: "python",
      dev: false,
    });
  });

  it("parses Poetry dependencies and skips the python constraint", () => {
    const toml = [
      "[tool.poetry.dependencies]",
      'python = "^3.11"',
      'requests = "^2.31"',
      'httpx = { version = "^0.27", optional = true }',
    ].join("\n");
    const out = parsePyprojectToml(toml);
    expect(out.some((d) => d.name === "python")).toBe(false);
    expect(out).toContainEqual({
      name: "requests",
      version: "^2.31",
      ecosystem: "python",
      dev: false,
    });
    expect(out).toContainEqual({
      name: "httpx",
      version: "^0.27",
      ecosystem: "python",
      dev: false,
    });
  });

  it("returns an empty array when there is nothing to parse", () => {
    expect(parsePyprojectToml('[build-system]\nrequires = ["hatchling"]')).toEqual([]);
  });
});
