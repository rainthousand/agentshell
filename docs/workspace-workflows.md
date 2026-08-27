# Multi-Repository Workflows

AgentShell's multi-repository core treats repository roots as explicit, bounded inputs. It does not discover arbitrary directories from the home folder and does not modify any repository.

## Workspace Guard

`workspaceGuard(roots, options)` accepts at least two exact Git repository roots. The default maximum is eight and callers may lower or raise it with `maxRoots`, up to the hard safety ceiling of 32.

One response aligns every repository by a local identifier such as `root-1` and reports:

- current or detached branch state;
- dirty and untracked counts;
- upstream name and ahead/behind counts when Git provides tracking data;
- cross-repository totals and whether branch names are aligned.

Absolute workspace paths, file names, and raw Git output are not returned. The filesystem root, the user's home directory, duplicate canonical paths, nested repository directories, and non-Git roots are rejected. Git commands are read-only: `rev-parse` validates each exact root and porcelain v2 status provides the summary.

## Compare Search

`compareSearch(roots, query, options)` runs the same literal or regular-expression search over at least two explicit directories. Results remain grouped in input order, including roots with no matches, so an agent can compare corresponding codebases without merging unrelated evidence.

Search output is bounded at four levels:

- maximum roots;
- maximum returned matches globally;
- maximum returned matches per root;
- maximum returned matches per file and preview length.

Allocation is round-robin across roots to keep a noisy repository from consuming the complete global budget. Candidates are stably ordered by file, line, and column before allocation. Common generated, dependency, cache, and VCS directories are ignored. Searches use `rg --json` when available and an asynchronous, deadline-bounded local fallback otherwise. Fallback timeouts return a structured `SEARCH_TIMEOUT` failure. The response exposes relative file paths only, redacts common secret-like assignments from previews, and never uploads data.

## Core API Examples

```js
import { workspaceGuard } from "../src/commands/workspace-guard.js";
import { compareSearch } from "../src/commands/compare-search.js";

const guard = await workspaceGuard([repoA, repoB], {
  compact: true,
  maxRoots: 4
});

const comparison = await compareSearch([repoA, repoB], "OrderService", {
  compact: true,
  fixedStrings: true,
  maxMatches: 30,
  maxMatchesPerRoot: 15
});
```

These modules intentionally do not register public CLI routes yet. CLI wiring can be added separately after the response contracts and real-project behavior are accepted.
