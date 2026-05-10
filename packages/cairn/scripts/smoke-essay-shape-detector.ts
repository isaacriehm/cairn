/**
 * smoke-essay-shape-detector — verify the diff-aware sot-align
 * short-circuit's regex matches the cases it should and skips the
 * cases it should. Tested in isolation; the full integration with
 * `executeSotAlign` is exercised by smoke-init-phases-all + the
 * read-enricher / write-guardian smokes.
 *
 * Layer A's `executeSotAlign` reads `tool_input.{old_string,
 * new_string, content}` and skips alignFile when neither contains
 * essay-class shape. Variable renames, type tweaks, and single-line
 * bugfixes thus skip the per-edit Haiku dedup pass.
 */

import assert from "node:assert/strict";
import { containsEssayClassShape } from "@isaacriehm/cairn-core";

console.log("smoke-essay-shape-detector — start");

interface Case {
  label: string;
  text: string;
  expect: boolean;
}

const cases: Case[] = [
  // Should match — actual prose changes
  {
    label: "JSDoc block /** ... */",
    text: "/**\n * Adds two numbers and returns the sum.\n * @param a first\n * @param b second\n */",
    expect: true,
  },
  {
    label: "JSDoc continuation line — single * with content",
    text: "   * @returns the new value\n",
    expect: true,
  },
  {
    label: "Three consecutive // lines",
    text: "// first comment line\n// second comment line\n// third comment line\n",
    expect: true,
  },
  {
    label: "Python triple-quote docstring",
    text: '    """Compute the next state given inputs."""\n',
    expect: true,
  },
  {
    label: "JSDoc deletion (only old_string carries shape)",
    text: "/**\n * Old description\n */",
    expect: true,
  },

  // Should NOT match — mechanical edits
  {
    label: "Variable rename",
    text: "const userName = user.firstName;",
    expect: false,
  },
  {
    label: "Type annotation tweak",
    text: "let count: string = '0';",
    expect: false,
  },
  {
    label: "Single-line // comment (one line, not 3+)",
    text: "// fix typo\n",
    expect: false,
  },
  {
    label: "Two-line // block (still under 3 threshold)",
    text: "// step one\n// step two\n",
    expect: false,
  },
  {
    label: "Empty string",
    text: "",
    expect: false,
  },
  {
    label: "Whitespace only",
    text: "    \n\n",
    expect: false,
  },
  {
    label: "Pure code with no comments",
    text: "function add(a: number, b: number) { return a + b; }",
    expect: false,
  },
  {
    label: "Trailing inline comment",
    text: "const x = 1; // inline note\n",
    expect: false,
  },
  {
    label: "Console statement that mentions /** in a string",
    text: "console.log('uses /** marker syntax');",
    expect: false,
  },
];

let failures = 0;
for (const c of cases) {
  const got = containsEssayClassShape(c.text);
  if (got !== c.expect) {
    console.log(`  ✗ ${c.label} — expected ${c.expect}, got ${got}`);
    failures += 1;
  } else {
    console.log(`  ✓ ${c.label}`);
  }
}

// Edge case: trailing inline comment with /** literal in a string.
// The regex `/\*\*[\s\S]*?\*/` will match a literal `/**...*/` inside
// a string. This is a documented false-positive — we accept it
// because (a) it's rare in real code and (b) the cost of the Haiku
// pass is bounded. Verify the test case above to make this explicit:
const fpText = "const note = '/** literal in string */';";
if (containsEssayClassShape(fpText) === true) {
  console.log("  ✓ documented false-positive: literal /** ... */ in string triggers run (acceptable)");
}

if (failures > 0) {
  console.log(`smoke-essay-shape-detector — FAILED (${failures} case${failures === 1 ? "" : "s"})`);
  process.exit(1);
}

console.log(`smoke-essay-shape-detector — pass (${cases.length} cases)`);
