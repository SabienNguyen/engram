---
name: no-slop-code
description: Implementation standards for the Loreweaver MCP server — use before writing or editing any TypeScript here, and when reviewing a diff. Covers the boundary rules a contributor would otherwise break (the server never teaches, mastery only moves through record_evidence, the prereq graph stays acyclic, links require a rationale, the vault stays plain Obsidian markdown) plus the code-slop patterns this repo rejects: comments that restate the line, speculative abstraction, swallowed errors, casual dependencies, and tests that assert nothing.
---

# No-Slop Code (loreweaver)

This server is ~1,136 LOC across 13 tools with three runtime dependencies
(`@modelcontextprotocol/sdk`, `gray-matter`, `zod`). Smallness is the feature: it is the memory layer
for any MCP-capable agent, so every addition is surface that every consumer inherits.

Read the module you are editing before writing. Match its density and comment style.

## Boundary rules — breaking these is the worst slop

**1. The server never teaches.** It is memory + graph queries only. No pedagogy, no prompt
engineering beyond the contract strings, and **no model calls of any kind** — there is no LLM client
in this package and there must not be one. Teaching lives in the agent.

The corollary the agent side owes back: the agent never parses markdown. That is why tools return
structured JSON rather than raw files.

**2. Mastery only moves through `record_evidence`.** `applyEvidence` in `src/student/model.ts` is the
one writer. Never promote a level from presenting material, from a read, or from a query. Never let a
`struggled` demotion fall below `exposed`, and never let `misconception` change the level at all.

**3. Every query reads the *effective* level, not the stored one.** Decay is real: `effectiveLevel()`
drops `mastered` after 45 days and `practicing` after 21. The raw level is kept for history only.
Code that compares `m.level` directly where it should call `effectiveLevel(m, now)` silently
resurrects stale mastery.

**4. The prereq graph stays acyclic.** `wouldCreateCycle` gates both `write_page`'s incoming prereqs
and `link_pages`. A rejected edge returns a warning or an error — it is never written and then
flagged later.

**5. Links require a justification.** `write_page` *proposes*; it never auto-links. The agent
verifies each candidate against `VERIFY_CONTRACT` and calls `link_pages`, which demands a rationale,
appends to `review-log.md`, and persists the rationale for later reads. Do not add a code path that
creates a typed edge without one.

**6. The vault stays plain, Obsidian-compatible markdown.** Frontmatter plus `[[wiki-links]]`. No
sidecar format, no database, no proprietary index in `pages/`. `.index/` is derived and disposable —
deleting it must only cost recomputation, never data.

**7. Slugs are slugified; paths are not.** `slugify` normalizes every slug at the boundary. `sources`
holds file paths and must never be slugified — the comment saying so in `parsePage.ts` exists because
it is an easy and destructive mistake.

## Degrade gracefully, and report it

Embeddings are optional. The house pattern is to keep serving with reduced quality and *say so in the
response* rather than failing the call:

- `Ctx.snapshot()` catches an embedding failure and returns `embeddingsError` alongside the pages.
- `next_lessons` and `find_analogies` surface that as a `note` field in their JSON.
- `frontier()` falls back to easiest-unexplored ordering when there is no index.
- `search` seeds semantic expansion only from lexical hits — no hits means no seed and no noise.

So: a degraded path returns partial results plus the reason. It does not throw, and it does not
pretend the result is complete.

Warnings work the same way. A parse problem is recorded in `page.warnings` and forces `status` down
from `solid` to `draft` — the page still loads.

## Errors

Tools return `err(message)` from `src/server/context.ts` with an actionable message naming the
offending value (`page not found: ${slug}`, `invalid ${field}: "${raw}" slugifies to empty string`).
A corrupt student file throws with the path in the message, because silently returning `{}` would
look like a student with no history.

Rejected slop:

```ts
try { ... } catch {}                    // swallowed
catch (e) { return {} }                 // corrupt data read as empty state
return err('error')                     // no value, no field, unactionable
```

An empty catch is acceptable only where the failure is expected and irrelevant, and a comment says
which — `readRationales()` treating a corrupt cache as empty is the one example.

## Comments

See the `no-slop-prose` skill for the standard. In short: state the invariant or the hazard, never
restate the line. `graph.ts`'s one-line cycle-direction note and `parsePage.ts`'s
`// sources are file paths, not slugs` each prevent a whole class of bug in a single sentence.

Delete on sight: `// Create the server`, `// Loop through the pages`, `// Error handling`, `// NEW:`,
commented-out blocks.

## Abstraction and dependencies

- Three runtime dependencies. Adding a fourth needs a justification in the commit body. Anything
  achievable in twenty lines of Node stdlib does not warrant a package.
- `EmbeddingProvider` is the one pluggable interface, and it earns it: three real implementations
  (`ollama`, `fake`, `none`) with tests using `fake`. That is the bar for a new abstraction — a
  consumer today, not a hypothetical one.
- Do not add a config option nothing reads, an interface with one implementation, or a wrapper layer
  "for future flexibility".
- Tool count is a public surface. Prefer an argument on an existing tool over a fourteenth tool, and
  say why in the description.

## Tools are an API — treat their shape as a contract

- Response shape is load-bearing. `next_lessons` always wraps as `{lessons, note?}`; a caller that
  destructures `.lessons` breaks if you return a bare array. Changing a shape is a breaking change,
  so say so in the commit.
- Every string field that names a page goes through `requireSlug`, which returns an error object
  rather than a coerced empty slug.
- `description` and contract text are executable instructions for a model. Vague wording becomes
  wrong behavior — hold them to the bar in `no-slop-prose`.

## Tests must assert behavior

`vitest run`, 11 test files. Use `fake` embeddings for determinism.

- Assert observable results: returned JSON, file contents on disk, the student state after
  `applyEvidence`.
- Decay and promotion logic needs explicit `now` injection — every function taking a `Date` does so
  to be testable. Test the boundary days (day 21, day 22, day 45, day 46), not just the happy path.
- Cover the rejection you just wrote: the cycle that must be refused, the slug that must error, the
  corrupt file that must throw.

Slop tests to avoid: asserting a spy was called; `expect(true).toBe(true)`; a test that would still
pass with the feature reverted; snapshots re-recorded until green.

## Self-check before committing

1. Does anything here call a model, or otherwise start teaching?
2. Does every mastery read go through `effectiveLevel`?
3. Can a new typed edge be created without a rationale?
4. Does a degraded path return a `note`/`warnings` explaining itself, or does it lie by omission?
5. Did you run `npm test` — and are you reporting the real result?
