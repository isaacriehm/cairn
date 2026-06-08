/**
 * Deterministic glob baseline derived from framework conventions detected
 * in Phase 1. The mapper LLM still adds project-specific globs on top;
 * these are always included regardless of LLM output.
 *
 * Pure function. Uses existsSync for file-presence checks only.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DetectionResult } from "./types.js";

export interface InferredGlobs {
  route_handler_globs: string[];
  dto_globs: string[];
  generator_source_globs: string[];
  high_stakes_globs: string[];
  off_limits_globs: string[];
}

export function inferGlobsFromDetection(
  detection: DetectionResult,
  repoRoot: string,
): InferredGlobs {
  const route_handler_globs: string[] = [];
  const dto_globs: string[] = [];
  const generator_source_globs: string[] = [];

  const sigs = detection.stack_signatures;
  const has = (rel: string) => existsSync(join(repoRoot, rel));

  // ── NestJS ───────────────────────────────────────────────
  if (has("nest-cli.json")) {
    route_handler_globs.push("**/*.controller.ts");
    dto_globs.push("**/*.dto.ts");
  }

  // ── Ruby ─────────────────────────────────────────────────
  if (sigs.some((s) => s.kind === "ruby")) {
    route_handler_globs.push("app/controllers/**/*.rb");
    dto_globs.push("app/forms/**/*.rb", "app/serializers/**/*.rb");
  }

  // ── Python ───────────────────────────────────────────────
  if (sigs.some((s) => s.kind === "python")) {
    route_handler_globs.push("**/views.py", "**/routes.py", "**/api/**/*.py");
  }

  // ── Go ───────────────────────────────────────────────────
  if (sigs.some((s) => s.kind === "go")) {
    route_handler_globs.push("**/handlers/**/*.go", "**/routes/**/*.go");
  }

  // ── Rust ─────────────────────────────────────────────────
  if (sigs.some((s) => s.kind === "rust")) {
    route_handler_globs.push("**/handlers.rs", "**/routes.rs");
  }

  // ── Java (Spring) ────────────────────────────────────────
  if (sigs.some((s) => s.kind === "java")) {
    route_handler_globs.push("**/*Controller.java", "**/*Resource.java");
    dto_globs.push("**/dto/**/*.java", "**/*Dto.java", "**/*Request.java");
  }

  // ── Kotlin (Spring / Ktor) ───────────────────────────────
  if (sigs.some((s) => s.kind === "kotlin")) {
    route_handler_globs.push("**/*Controller.kt", "**/routes/**/*.kt");
    dto_globs.push("**/dto/**/*.kt", "**/*Dto.kt", "**/*Request.kt");
  }

  // ── C# (.NET) ────────────────────────────────────────────
  if (sigs.some((s) => s.kind === "csharp")) {
    route_handler_globs.push("**/Controllers/**/*.cs", "**/*Controller.cs");
    dto_globs.push("**/Dtos/**/*.cs", "**/*Dto.cs");
  }

  // ── PHP (Laravel / Symfony) ──────────────────────────────
  if (sigs.some((s) => s.kind === "php")) {
    route_handler_globs.push("app/Http/Controllers/**/*.php", "**/*Controller.php");
    dto_globs.push("app/Http/Requests/**/*.php");
  }

  // ── Elixir (Phoenix) ─────────────────────────────────────
  if (sigs.some((s) => s.kind === "elixir")) {
    route_handler_globs.push("lib/**/*_controller.ex", "lib/**/controllers/**/*.ex");
  }

  // ── Prisma ───────────────────────────────────────────────
  if (has("prisma/schema.prisma")) {
    generator_source_globs.push("prisma/schema.prisma");
  }

  // ── Drizzle ──────────────────────────────────────────────
  if (
    has("drizzle.config.ts") ||
    has("drizzle.config.js") ||
    has("drizzle.config.mjs")
  ) {
    generator_source_globs.push("**/db/schema.ts", "**/schema.ts");
  }

  // ── Protobuf ─────────────────────────────────────────────
  if (hasGlob(repoRoot, ".proto")) {
    generator_source_globs.push("**/*.proto");
  }

  // ── GraphQL ──────────────────────────────────────────────
  if (hasGlob(repoRoot, ".graphql") || hasGlob(repoRoot, ".gql")) {
    generator_source_globs.push("**/*.graphql", "**/*.gql");
  }

  // ── OpenAPI / Swagger ────────────────────────────────────
  if (
    has("openapi.json") ||
    has("openapi.yaml") ||
    has("swagger.json") ||
    has("swagger.yaml")
  ) {
    generator_source_globs.push("openapi.{json,yaml}", "swagger.{json,yaml}");
  }

  // ── Always-on ────────────────────────────────────────────
  const high_stakes_globs = [
    "**/auth/**",
    "**/billing/**",
    "**/payment*/**",
    "**/security/**",
    "**/secrets/**",
  ];

  const off_limits_globs = [
    "**/vendor/**",
    "**/__generated__/**",
    "**/*.generated.ts",
    "**/*.pb.go",
  ];

  return {
    route_handler_globs,
    dto_globs,
    generator_source_globs,
    high_stakes_globs,
    off_limits_globs,
  };
}

/**
 * Returns true if any conventional top-level directory or file associated
 * with the given extension exists. Checks known common locations only —
 * avoids recursive tree walks for init performance.
 *
 * Proto: look for protos/, proto/, or *.proto at root.
 * GraphQL: look for schema.graphql/schema.gql at root or graphql/ dir.
 */
function hasGlob(repoRoot: string, ext: string): boolean {
  if (ext === ".proto") {
    return (
      existsSync(join(repoRoot, "protos")) ||
      existsSync(join(repoRoot, "proto")) ||
      existsSync(join(repoRoot, "schema.proto")) ||
      existsSync(join(repoRoot, "service.proto"))
    );
  }
  if (ext === ".graphql" || ext === ".gql") {
    return (
      existsSync(join(repoRoot, "graphql")) ||
      existsSync(join(repoRoot, "schema.graphql")) ||
      existsSync(join(repoRoot, "schema.gql")) ||
      existsSync(join(repoRoot, "graph"))
    );
  }
  return false;
}
