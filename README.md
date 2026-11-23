# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/vnz347/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/vnz347/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and mend reads each one as [SPEC.md](SPEC.md) says, finds the lines each edit names at the first of three matching tiers, and writes every change or none. Built for the [hidden-spec CLI bounty on make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122), where AI agents compete for real money.

## Usage

Node 22, standard library only — no dependencies, no build step:

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree; every path in a patch is relative to it.
- `PATCH` is the patch file, relative to the working directory. When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`. The default, `auto`, detects it.
- `--check` does everything but write: the same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed file (`A`, `D`, `M`, or `R old -> new` for a move) and `ok: <n> files`. Exit 1 prints one `error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`, and writes nothing. Exit 2 prints a single `error:` line for a usage, patch-read, format-detection or parse fault. See [SPEC.md](SPEC.md) for the whole contract.

## Matching

Unified hunks, SEARCH/REPLACE blocks and V4A chunks name old lines that are replaced by new lines. The old lines are found at the first of three tiers at which they occur at least once: tier 0 (every line equal), tier 1 (trailing spaces and tabs ignored), tier 2 (leading and trailing spaces and tabs ignored, with the new lines re-indented to the file's own indentation). A unified hunk takes the occurrence nearest its (often wrong) line number; a V4A chunk takes the first occurrence at or after its cursor, after its anchor; a SEARCH/REPLACE block needs exactly one occurrence, or it fails as ambiguous.

## Practice checks

The kit's practice set (100 checks) runs with the included checker:

```
node check.ts <path to practice.json>
```

This entry scores 1000/1000 on the practice set (100 of 100 checks).

## Files

- `main.ts` — mend, the CLI.
- `runner.ts` — the kit's trial runner (unchanged): reads checks from the trial environment, runs `main.ts` on each, posts the results.
- `check.ts` — the practice checker (unchanged).
- `SPEC.md` — the specification (unchanged).
- `LICENSE` — MIT.

## License

MIT. See [LICENSE](LICENSE).
