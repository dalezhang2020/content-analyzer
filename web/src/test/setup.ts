import "@testing-library/jest-dom/vitest";
import fc from "fast-check";

// Feature: video-creation-workbench
// Deterministic fast-check seed so CI property-test failures are reproducible.
// See design.md §Property-based Test Configuration.
fc.configureGlobal({ seed: 0xbeef, numRuns: 100 });
