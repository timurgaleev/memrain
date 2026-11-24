// Lint config for the memrain daemon.
//
// The compiler already gates types (`bun run typecheck`). This layer catches
// what types cannot: a value bound and never used, a variable shadowing an
// outer one, a promise nobody awaited, an `any` that erases a boundary. Those
// are the shapes behind the fixture bugs this repo keeps hitting.
//
// Formatting is deliberately OFF. This codebase has 74k lines of existing
// layout and a reformat would bury every future diff in noise; the value here
// is the correctness rules, not the whitespace.
import antfu from "@antfu/eslint-config";

export default antfu({
  type: "lib",
  typescript: true,
  // No frontend in this repo — the daemon is MCP-only, and admin/dist is built.
  jsx: false,
  vue: false,
  react: false,
  // See the note above: rules yes, restyling no.
  stylistic: false,
  formatters: false,
  ignores: [
    "node_modules/**",
    "dist/**",
    "admin/dist/**",
  ],
}, {
  rules: {
    // ---------------------------------------------------------------------
    // Turned OFF: house conventions this codebase made on purpose.
    //
    // A first run reported 2375 problems, of which roughly 2000 were these.
    // Adopting them would mean a two-thousand-edit reformat that buries every
    // future diff, in exchange for no defect caught. Each is listed with its
    // reason so a reader can tell a deliberate deviation from an oversight.
    // ---------------------------------------------------------------------

    // 808 hits. We read env through `process.env["NAME"]` throughout. Bracket
    // access on an index signature is the honest form and survives a future
    // `noPropertyAccessFromIndexSignature`; dot access reads as a declared
    // property that does not exist.
    "dot-notation": "off",
    // 728 hits across sort-imports / sort-named-imports / sort-exports /
    // sort-named-exports. Import order carries no meaning here and enforcing
    // one rewrites the head of nearly every file.
    "perfectionist/sort-imports": "off",
    "perfectionist/sort-named-imports": "off",
    "perfectionist/sort-exports": "off",
    "perfectionist/sort-named-exports": "off",
    // 310 hits. This is an ESM daemon on Bun; `process` and `Buffer` are
    // globals here and `require()` is not available. The rule targets a
    // CommonJS world we do not live in.
    "node/prefer-global/process": "off",
    "node/prefer-global/buffer": "off",
    // 192 hits. Inline `import { type X }` keeps a symbol next to its source;
    // splitting every one into a second statement is churn.
    "import/consistent-type-specifier-style": "off",
    // Cosmetic: concatenation vs template, import placement, literal casing.
    "prefer-template": "off",
    "import/first": "off",
    "unicorn/number-literal-case": "off",
    // Return types are inferred and checked by tsc; requiring them written out
    // is a style choice, and `bun run typecheck` already owns correctness here.
    "ts/explicit-function-return-type": "off",
    "ts/method-signature-style": "off",
    // We import with explicit .ts extensions — that is how Bun resolves.
    "antfu/no-import-dist": "off",
    "ts/consistent-type-definitions": "off",
    // console IS the log surface for a daemon with no logger dependency.
    "no-console": "off",
    // jsdoc block styling; the comments here are prose for humans, not a
    // generated API reference.
    "jsdoc/no-multi-asterisks": "off",
    "jsdoc/empty-tags": "off",

    // ---------------------------------------------------------------------
    // Kept, and raised to errors: the reason this config is here at all.
    //
    // The regexp family is the find. This daemon runs regexes over note text
    // and search queries it did not write, so a pattern that backtracks
    // super-linearly is an availability bug reachable from user input, not a
    // style nit. tsc cannot see any of these.
    // ---------------------------------------------------------------------
    "regexp/no-super-linear-backtracking": "error",
    "regexp/no-super-linear-move": "error",
    "regexp/no-dupe-disjunctions": "error",
    "regexp/no-contradiction-with-assertion": "error",
    "regexp/no-useless-lazy": "error",
    "regexp/no-unused-capturing-group": "error",
    "no-cond-assign": ["error", "always"],
  },
});
