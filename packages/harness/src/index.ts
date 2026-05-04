/**
 * @isaacriehm/harness — umbrella re-export.
 *
 * Adopters who don't want to think about sub-packages can `import { ... }
 * from "@isaacriehm/harness"`. Power users compose `harness-core`,
 * `harness-runtime`, and frontend adapters directly. See docs/ARCHITECTURE.md
 * §3.5.
 */

export * from "@isaacriehm/harness-core";
export * from "@isaacriehm/harness-runtime";
export * from "@isaacriehm/harness-frontend-discord";
export * from "@isaacriehm/harness-frontend-stub";
