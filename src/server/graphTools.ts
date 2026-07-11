import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Ctx, json, err } from './context.js';
import { proposeLinks, VERIFY_CONTRACT } from '../linking/propose.js';
import { wouldCreateCycle, graphWarnings } from '../graph/graph.js';
import type { LinkType, PageMeta } from '../types.js';

const LINK_TYPES = ['prereq', 'deepens', 'related'] as const;

export function registerGraphTools(server: McpServer, ctx: Ctx): void {
  server.registerTool(
    'search',
    {
      description: 'Search vault pages lexically and semantically. Returns top matches.',
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      const { pages, index } = await ctx.snapshot();
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const scores = new Map<string, number>();
      for (const p of pages.values()) {
        let s = 0;
        const t = p.meta.title.toLowerCase();
        const body = p.body.toLowerCase();
        for (const tok of tokens) {
          if (t.includes(tok)) s += 3;
          if (p.meta.tags.some((tag) => tag.includes(tok))) s += 2;
          if (body.includes(tok)) s += 1;
        }
        if (s > 0) scores.set(p.slug, s);
      }
      if (index) {
        // seed semantic scores from lexical hits (or all pages if none)
        const seeds = scores.size ? [...scores.keys()] : [...pages.keys()].slice(0, 1);
        for (const { slug, score } of index.similarToMany(seeds, 8)) {
          scores.set(slug, (scores.get(slug) ?? 0) + score);
        }
      }
      const out = [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([slug, score]) => {
          const p = pages.get(slug)!;
          return { slug, title: p.meta.title, status: p.meta.status, score: +score.toFixed(2) };
        });
      return json(out);
    }
  );

  server.registerTool(
    'read_page',
    {
      description: 'Read a page: content, metadata, and typed in/out edges with rationales.',
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      const { pages, edges } = await ctx.snapshot();
      const page = pages.get(slug);
      if (!page) return err(`page not found: ${slug}`);
      const rationales = ctx.store.readRationales();
      const withR = (src: string, dst: string, type: LinkType) => rationales[`${src}->${dst}:${type}`];
      return json({
        page: { slug: page.slug, domain: page.domain, meta: page.meta, body: page.body, warnings: page.warnings },
        edges: {
          out: edges.filter((e) => e.src === slug).map((e) => ({ dst: e.dst, type: e.type, rationale: withR(e.src, e.dst, e.type) })),
          in: edges.filter((e) => e.dst === slug).map((e) => ({ src: e.src, type: e.type, rationale: withR(e.src, e.dst, e.type) })),
        },
      });
    }
  );

  server.registerTool(
    'write_page',
    {
      description:
        'Create or update a page. Returns proposed link candidates you MUST verify per the returned instructions.',
      inputSchema: {
        slug: z.string(),
        title: z.string(),
        body: z.string(),
        domain: z.string().optional(),
        prereqs: z.array(z.string()).optional(),
        deepens: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        difficulty: z.number().min(1).max(5).optional(),
        status: z.enum(['stub', 'draft', 'solid']).optional(),
        sources: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const { pages } = await ctx.snapshot();
      const old = pages.get(args.slug);
      const meta: PageMeta = {
        title: args.title,
        prereqs: args.prereqs ?? old?.meta.prereqs ?? [],
        deepens: args.deepens ?? old?.meta.deepens ?? [],
        tags: args.tags ?? old?.meta.tags ?? [],
        difficulty: args.difficulty ?? old?.meta.difficulty ?? 3,
        status: args.status ?? (old && old.meta.status !== 'stub' ? old.meta.status : 'draft'),
        sources: args.sources ?? old?.meta.sources ?? [],
      };
      ctx.store.writePage(args.slug, meta, args.body, args.domain ?? old?.domain ?? '');
      const snap = await ctx.snapshot();
      const page = snap.pages.get(args.slug)!;
      return json({
        page: { slug: page.slug, domain: page.domain, meta: page.meta, warnings: page.warnings },
        proposedLinks: proposeLinks(page, snap.pages, snap.edges, snap.index),
        instructions: VERIFY_CONTRACT,
        graphWarnings: graphWarnings(snap.pages, snap.edges).slice(0, 10),
      });
    }
  );

  server.registerTool(
    'link_pages',
    {
      description:
        'Add a verified typed link src->dst with a one-line rationale naming what breaks/enriches without it.',
      inputSchema: {
        src: z.string(),
        dst: z.string(),
        type: z.enum(LINK_TYPES),
        rationale: z.string().min(10),
      },
    },
    async ({ src, dst, type, rationale }) => {
      const { pages, edges } = await ctx.snapshot();
      const srcPage = pages.get(src);
      if (!srcPage) return err(`page not found: ${src}`);
      if (type === 'prereq' && wouldCreateCycle(edges, src, dst)) {
        return err(`rejected: would create prereq cycle ${src} -> ${dst}`);
      }
      let stubCreated = false;
      if (!pages.has(dst)) {
        ctx.store.createStub(dst);
        stubCreated = true;
      }
      if (type === 'related') {
        if (!srcPage.inlineLinks.includes(dst)) {
          const line = `- [[${dst}]] — ${rationale}`;
          const body = srcPage.body.includes('## Links')
            ? srcPage.body.replace('## Links', `## Links\n${line}`)
            : `${srcPage.body.trimEnd()}\n\n## Links\n${line}\n`;
          ctx.store.writePage(src, srcPage.meta, body, srcPage.domain);
        }
      } else {
        const list = type === 'prereq' ? srcPage.meta.prereqs : srcPage.meta.deepens;
        if (!list.includes(dst)) list.push(dst);
        ctx.store.writePage(src, srcPage.meta, srcPage.body, srcPage.domain);
      }
      const today = new Date().toISOString().slice(0, 10);
      ctx.store.appendReviewLog(`- ${today} [${type}] ${src} -> ${dst} — ${rationale}`);
      ctx.store.saveRationale(`${src}->${dst}:${type}`, rationale);
      return json({ linked: { src, dst, type }, stubCreated });
    }
  );

  server.registerTool(
    'unlink_pages',
    {
      description: 'Remove a prereq/deepens edge. Related links live in prose; edit via write_page.',
      inputSchema: { src: z.string(), dst: z.string(), type: z.enum(LINK_TYPES) },
    },
    async ({ src, dst, type }) => {
      if (type === 'related') return err('related links live in prose — edit the body via write_page');
      const { pages } = await ctx.snapshot();
      const page = pages.get(src);
      if (!page) return err(`page not found: ${src}`);
      const list = type === 'prereq' ? page.meta.prereqs : page.meta.deepens;
      const i = list.indexOf(dst);
      if (i >= 0) list.splice(i, 1);
      ctx.store.writePage(src, page.meta, page.body, page.domain);
      return json({ unlinked: true });
    }
  );
}
