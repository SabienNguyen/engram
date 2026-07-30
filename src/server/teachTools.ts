import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Ctx, json, err } from './context.js';
import { applyEvidence, decayDaysLeft, effectiveLevel } from '../student/model.js';
import { LEVELS } from '../types.js';
import { analogies, nextLessons, workingSet } from '../queries/queries.js';
import { slugify } from '../vault/parsePage.js';

function requireSlug(raw: string, field: string): string | { error: string } {
  const s = slugify(raw);
  if (!s) return { error: `invalid ${field}: "${raw}" slugifies to empty string` };
  return s;
}

export const COMPILE_CONTRACT = `Extract 3-10 atomic concepts from this source. For each concept call write_page:
kebab-case slug, clear title, a self-contained explanatory body using [[wiki-links]] to other concepts,
difficulty 1-5, status "draft", sources ["raw/<file>"]. Prefer linking to existingPages over creating
near-duplicates. Then verify each returned proposedLinks candidate per its instructions.`;

const KINDS = ['exposed', 'explained-correctly', 'applied-correctly', 'rubric-passed', 'struggled', 'misconception'] as const;

export function registerTeachTools(server: McpServer, ctx: Ctx): void {
  server.registerTool(
    'compile_source',
    {
      description: 'Fetch a raw source plus compile instructions. You do the extraction via write_page calls.',
      inputSchema: { file: z.string() },
    },
    async ({ file }) => {
      if (!ctx.store.listRaw().includes(file)) return err(`raw file not found: ${file}`);
      const { pages } = await ctx.snapshot();
      return json({
        source: ctx.store.readRaw(file),
        existingPages: [...pages.values()].map((p) => ({ slug: p.slug, title: p.meta.title })),
        instructions: COMPILE_CONTRACT.replace('<file>', file),
      });
    }
  );

  server.registerTool(
    'list_paths',
    { description: 'List curated learning paths (rabbit holes).', inputSchema: {} },
    async () => json(ctx.store.listPathDocs())
  );

  server.registerTool(
    'read_path',
    { description: 'Read one curated path: ordered pages + narrative.', inputSchema: { slug: z.string() } },
    async ({ slug: rawSlug }) => {
      const slugResult = requireSlug(rawSlug, 'slug');
      if (typeof slugResult !== 'string') return err(slugResult.error);
      const doc = ctx.store.readPathDoc(slugResult);
      return doc ? json(doc) : err(`path not found: ${slugResult}`);
    }
  );

  server.registerTool(
    'create_path',
    {
      description: 'Create a curated learning path from existing pages, in teaching order, with narrative.',
      inputSchema: {
        slug: z.string(), title: z.string(), pages: z.array(z.string()).min(1), narrative: z.string(),
      },
    },
    async ({ slug: rawSlug, title, pages: rawPageSlugs, narrative }) => {
      const slugResult = requireSlug(rawSlug, 'slug');
      if (typeof slugResult !== 'string') return err(slugResult.error);
      const slug = slugResult;
      const pageSlugs = rawPageSlugs.map((s) => slugify(s));
      if (pageSlugs.some((s) => !s)) return err(`invalid pages: one or more slugify to empty string`);
      const { pages } = await ctx.snapshot();
      const missing = pageSlugs.filter((s) => !pages.has(s));
      if (missing.length) return err(`pages not found: ${missing.join(', ')}`);
      ctx.store.writePathDoc(slug, title, pageSlugs, narrative);
      return json({ created: slug });
    }
  );

  server.registerTool(
    'get_student_state',
    {
      description:
        "Student's mastery map with decay-adjusted effective levels. Pass slug for full per-page detail (evidence notes, misconceptions).",
      inputSchema: { student: z.string(), slug: z.string().optional() },
    },
    async ({ student, slug: rawSlug }) => {
      const state = ctx.store.readStudent(student);
      const now = new Date();
      const out: Record<string, unknown> = {};
      for (const [slug, m] of Object.entries(state)) {
        const effective = effectiveLevel(m, now);
        out[slug] = {
          level: m.level,
          effective,
          last_reinforced: m.last_reinforced,
          misconceptions: m.misconceptions,
          evidenceCount: m.evidence.length,
          // The spacing signal, computed where the decay rules live: days until the standing
          // drops a rung (null when nothing is decaying), and whether it ALREADY has — the two
          // numbers a review queue needs, so no consumer re-derives the windows.
          days_left: decayDaysLeft(m, now),
          slipped: LEVELS.indexOf(effective) < LEVELS.indexOf(m.level),
        };
      }
      if (rawSlug === undefined) return json(out);
      const slugResult = requireSlug(rawSlug, 'slug');
      if (typeof slugResult !== 'string') return err(slugResult.error);
      const m = state[slugResult];
      return json({
        ...out,
        detail: m
          ? {
              level: m.level,
              effective: effectiveLevel(m, now),
              last_reinforced: m.last_reinforced,
              // Carry the decay countdown INTO detail, not just the top-level map: a consumer that
              // asks for one slug's detail (the page reader does) gets a self-contained answer and
              // never re-derives the window from level + last_reinforced. Same numbers as out[slug].
              days_left: decayDaysLeft(m, now),
              slipped: LEVELS.indexOf(effectiveLevel(m, now)) < LEVELS.indexOf(m.level),
              evidence: m.evidence,
              misconceptions: m.misconceptions,
            }
          : null,
        ...(m ? {} : { note: `no mastery record for slug: ${slugResult}` }),
      });
    }
  );

  server.registerTool(
    'record_evidence',
    {
      description:
        'Record graded evidence about a student on a page. Mastery only changes through this tool. '
        + 'When the student demonstrably corrects a previously recorded misconception, pass '
        + '`resolves` quoting it — otherwise it stays active and keeps returning in review plans.',
      inputSchema: {
        student: z.string(), slug: z.string(), kind: z.enum(KINDS), note: z.string(),
        misconception: z.string().optional(),
        resolves: z.string().optional(),
      },
    },
    async ({ student, slug: rawSlug, kind, note, misconception, resolves }) => {
      const slugResult = requireSlug(rawSlug, 'slug');
      if (typeof slugResult !== 'string') return err(slugResult.error);
      const slug = slugResult;
      const { pages } = await ctx.snapshot();
      if (!pages.has(slug)) return err(`page not found: ${slug}`);
      const now = new Date();
      const next = applyEvidence(ctx.store.readStudent(student), slug, kind, note, now, misconception, resolves);
      ctx.store.writeStudent(student, next);
      return json({
        slug,
        level: next[slug].level,
        effective: effectiveLevel(next[slug], now),
        misconceptions: next[slug].misconceptions,
      });
    }
  );

  server.registerTool(
    'next_lessons',
    {
      description:
        'Ranked next topics with reasons (review-due / unmet-prereq / frontier). Call at session start.',
      inputSchema: { student: z.string(), goal: z.string().optional(), k: z.number().optional() },
    },
    async ({ student, goal: rawGoal, k }) => {
      const snap = await ctx.snapshot();
      // Slugify the goal like every other page reference in this file. unmetPrereqs uses it as a
      // slug key, so a tutor naming a goal the way a learner phrased it ("Chain Rule", "Newton's
      // Laws") must resolve to the page ("chain-rule", "newtons-laws"), not 404 — the same
      // input-normalisation record_evidence/find_analogies/read_path already give their slugs.
      let goal: string | undefined;
      if (rawGoal !== undefined) {
        const goalResult = requireSlug(rawGoal, 'goal');
        if (typeof goalResult !== 'string') return err(goalResult.error);
        goal = goalResult;
        if (!snap.pages.has(goal)) return err(`page not found: ${goal}`);
      }
      const out = nextLessons(
        ctx.store.readStudent(student), snap.pages, snap.index, new Date(), goal, k ?? 3
      );
      return json(snap.embeddingsError ? { lessons: out, note: snap.embeddingsError } : { lessons: out });
    }
  );

  server.registerTool(
    'find_analogies',
    {
      description: "Bridge a new topic to the student's known pages (cross-domain analogies).",
      inputSchema: { student: z.string(), slug: z.string(), k: z.number().optional() },
    },
    async ({ student, slug: rawSlug, k }) => {
      const slugResult = requireSlug(rawSlug, 'slug');
      if (typeof slugResult !== 'string') return err(slugResult.error);
      const slug = slugResult;
      const snap = await ctx.snapshot();
      if (!snap.pages.has(slug)) return err(`page not found: ${slug}`);
      const out = analogies(
        slug, ctx.store.readStudent(student), snap.pages, snap.index, new Date(), k ?? 3
      );
      return json({ analogies: out, ...(snap.embeddingsError ? { note: snap.embeddingsError } : {}) });
    }
  );

  server.registerTool(
    'working_set',
    {
      description:
        "The student's recently-exercised pages (ranked by evidence recency) plus their 1-hop "
        + 'graph neighbors, with decay flags. Deterministic and read-only — consult it to assemble '
        + 'session context or check recent work cheaply, before running any full search.',
      inputSchema: { student: z.string(), k: z.number().optional() },
    },
    async ({ student, k }) => {
      const { pages, edges } = await ctx.snapshot();
      const now = new Date();
      // Cap 50: this is the cheap pre-search view; a caller wanting the whole vault wants
      // list_pages. Floor at 0 so a negative k cannot reach slice() and drop seeds from the end.
      const cap = Math.max(0, Math.min(Math.floor(k ?? 20), 50));
      return json({
        generatedAt: now.toISOString(),
        members: workingSet(ctx.store.readStudent(student), pages, edges, now, cap),
      });
    }
  );
}
