# Engram — Teaching-Memory MCP Server

**Date:** 2026-07-10
**Status:** Approved design

## Problem

Agentic systems have no durable *teaching* memory. Karpathy's LLM-wiki pattern
(markdown + wiki-links, LLM-compiled) gives a teacher durable, linkable knowledge but
no model of the student. Google's Guided Learning / LearnLM gives tutor behavior but no
persistent knowledge graph and only session-scoped student state. Engram is the
union plus the missing piece: a **linked markdown knowledge vault**, a **persistent
evidence-graded student model**, and **graph queries that turn any agent into a
competent tutor** — exposed over MCP so any agentic system can plug in.

## Architecture

```
┌─ teaching agent (Claude Code / claude.ai / custom) ─┐
│   pedagogy lives HERE (tutor prompt/skill)          │
└───────────────┬─────────────────────────────────────┘
                │ MCP (stdio)
┌───────────────▼─────────────────────────────────────┐
│  engram MCP server (TypeScript, Node)           │
│  graph math · embeddings · student state · queries  │
└───────────────┬─────────────────────────────────────┘
                │ reads/writes
┌───────────────▼─────────────────────────────────────┐
│  vault/  (plain markdown — Obsidian-compatible)     │
└─────────────────────────────────────────────────────┘
```

**Boundary rule:** the MCP server is memory + graph queries only — it never teaches.
The agent is pedagogy only — it never parses markdown. This keeps the server reusable
by any MCP-capable agent.

## Vault format

```
vault/
  raw/                      # source dumps (papers, transcripts) awaiting compile
  pages/<domain>/<slug>.md  # one concept per file
  paths/<slug>.md           # curated rabbit holes: ordered page lists + narrative
  students/<name>.json      # mastery, evidence, misconceptions
  review-log.md             # every auto-accepted link, newest first
.index/                     # derived, gitignored: embedding + parsed-graph cache
```

### Page format

```markdown
---
title: Backpropagation
prereqs: [chain-rule, gradient-descent]   # typed edges (page slugs)
deepens: [jacobians, autodiff-internals]  # optional-depth rabbit holes
tags: [deep-learning]
difficulty: 3        # 1-5
status: solid        # stub | draft | solid
sources: [raw/cs231n-notes.md]
---
# Backpropagation
...prose with inline [[wiki-links]] (typed as `related`)...
```

Link types and what the tutor uses them for:

| Type | Meaning | Tutor use |
|------|---------|-----------|
| `prereq` | must understand target first | lesson ordering, gap detection |
| `deepens` | optional depth | "want to go deeper?" rabbit holes |
| `related` | lateral connection (inline links) | analogies, known→new bridges |

**Invariant:** `prereq` edges form a DAG. Any topological sort is a valid lesson
sequence; "what next" becomes a graph query.

Paths (`paths/<slug>.md`) are curated rabbit holes: frontmatter `pages: [slug, ...]`
(ordered) plus narrative prose explaining the trail.

## Linking pipeline (accuracy machinery)

Runs on every page write / compile:

1. **Propose** — candidate edges from embedding similarity + lexical overlap between
   the new/changed page and existing pages, top-k, both directions.
2. **Verify** — an LLM judges each candidate individually and must produce a one-line
   rationale naming what specifically breaks or is enriched without the link
   (e.g. "backprop's derivation is unintelligible without chain-rule"). No rationale →
   no link. Rationales live in `review-log.md` and the `.index/` graph cache (returned
   by `read_page`); page frontmatter stays clean slugs-only.
3. **Validate (mechanical)** —
   - link target exists, else create target as `status: stub` page
   - prereq DAG stays acyclic; a cycle rejects the edge and logs it
   - warnings: orphan pages (no inbound links), hub pages (20+ inbound)

**Review policy:** auto-accept + review queue. Verified links go live immediately;
every new edge is appended to `review-log.md` (date, edge, type, rationale) for human
skimming in Obsidian. Bad edges are deleted/retyped by editing the page; the next index
rebuild picks it up.

## Embedding index — one index, three uses

Every page is embedded into a single shared cross-domain index (`.index/`):

1. **Link proposal** — candidates for the linking pipeline
2. **Frontier query** — unmastered pages nearest the student's mastered region =
   natural next topics, including cross-domain hops
3. **Analogy query** — the student's nearest *mastered* pages to the current topic,
   so the tutor can bridge from what the student already knows

Provider is pluggable behind an interface; default is local via Ollama
(`nomic-embed-text`) to stay API-key-free. Index rebuilds incrementally on file change
(hash-based).

## Student model

`students/<name>.json`, keyed by page slug:

```json
{
  "backpropagation": {
    "level": "practicing",
    "evidence": [
      {"date": "2026-07-10", "kind": "explained-correctly",
       "note": "derived chain rule application, confused Jacobian shape"}
    ],
    "misconceptions": ["thinks gradients flow forward"],
    "last_reinforced": "2026-07-10"
  }
}
```

- Levels: `unseen → exposed → practicing → mastered`. Mastery **only rises via graded
  evidence** recorded by the teaching agent (`record_evidence`).
- **Decay:** effective level is computed at read time from `last_reinforced`, so
  due-reviews surface automatically in `next_lessons` without a background process.
  Defaults (configurable): `mastered` reads as `practicing` after 45 days
  unreinforced; `practicing` reads as `exposed` after 21 days. Stored level is never
  mutated by decay — only the effective (read-time) level.
- Multi-student ready (one file per student); single-student in practice.

## MCP tool surface (13 tools)

| Group | Tool | Behavior |
|---|---|---|
| Graph | `search` | semantic + lexical search over pages |
| | `read_page` | page content + resolved edges (in/out, typed) + rationales |
| | `write_page` | create/update page; triggers linking pipeline + reindex |
| | `link_pages` / `unlink_pages` | manual typed edge with rationale / removal |
| Compile | `compile_source` | raw/ file → one or more linked pages (Karpathy-style) |
| Paths | `create_path` / `read_path` / `list_paths` | curated rabbit-hole trails |
| Student | `get_student_state` | mastery map (+ per-page detail on request) |
| | `record_evidence` | append graded evidence; updates level + misconceptions |
| | `next_lessons` | ranked next topics with reasons: unmet-prereq / frontier-proximity / review-due |
| | `find_analogies` | student's nearest mastered pages to a given page |

`next_lessons` is the crown jewel: one call returns "teach these 3 next, and why," so
even a naive agent teaches in sensible order.

## Content flow (two write paths)

1. **Compile:** drop sources into `raw/`; `compile_source` extracts concepts, writes
   one page per concept, runs the linking pipeline.
2. **Teach-time:** when a lesson hits a `stub` (created by the link validator), the
   teaching agent writes that page on the spot via `write_page`, links it, continues.

## Tutor behavior (ships with repo, not in server)

A tutor prompt / Claude Code skill encoding LearnLM-style moves:

- open sessions with `next_lessons`; state the why
- probe before telling; grade every substantive exchange via `record_evidence`
- bridge every new concept with `find_analogies`
- offer `deepens` rabbit holes when the student shows appetite
- record misconceptions verbatim; re-probe them next session

## Error handling

- Malformed frontmatter → page loads as `draft` with a logged warning; never crashes
  the server.
- Missing Ollama / embedding provider → server degrades: linking pipeline falls back
  to lexical-only proposal; frontier/analogy tools return a clear "embeddings
  unavailable" error.
- Concurrent vault edits (human in Obsidian + agent) → hash-based incremental reindex
  on each tool call; last-write-wins on pages, which is acceptable for single-user.

## Testing

- **Unit:** link parsing, frontmatter parsing, DAG cycle detection, decay math,
  frontier/analogy ranking (with fixture embeddings).
- **Integration:** drive the MCP server over stdio against a fixture vault; assert
  tool responses end-to-end.
- **Verify gate:** LLM judge mocked in tests; prompt contract tested separately.

## Tech stack

TypeScript + official MCP SDK (`@modelcontextprotocol/sdk`), Node ≥ 20, `gray-matter`
for frontmatter, `vitest` for tests, Ollama for embeddings (pluggable). No database —
markdown is the source of truth; `.index/` is a rebuildable cache.

## Deliverable 2: `fable-plan-sonnet-execute` skill

A personal Claude Code skill at `~/.claude/skills/fable-plan-sonnet-execute/SKILL.md`
encoding the build workflow (used to build Engram itself):

- **Plan on Fable:** brainstorm → spec → implementation plan happen in the main
  session (Fable, high effort). No implementation code is written by the main session.
- **Execute on Sonnet:** each plan task is dispatched as an `Agent` subagent with
  `model: "sonnet"`, one task per agent, TDD required, full task text + spec pointers
  in the prompt.
- **Review on Fable/Opus:** the main session reviews each subagent diff against the
  plan before accepting.
- **Escalation rule:** a task that fails review twice on Sonnet is re-dispatched once
  with `model: "opus"`; if that fails, stop and surface to the user.

## Out of scope (v1)

- Web UI / graph visualization (use Obsidian)
- Multi-user auth, remote MCP transport (stdio only)
- Quiz/flashcard generation (the tutor prompt can improvise; no dedicated tooling)
- Automatic mastery inference without evidence
