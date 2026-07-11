export interface EmbeddingProvider {
  name: string;
  embed(texts: string[]): Promise<number[][]>;
}

export class OllamaProvider implements EmbeddingProvider {
  name = 'ollama';
  constructor(
    private model = 'nomic-embed-text',
    private baseUrl = 'http://localhost:11434'
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const prompt of texts) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, prompt }),
        });
      } catch (e) {
        throw new Error(`ollama unreachable: ${(e as Error).message}`);
      }
      if (!res.ok) throw new Error(`ollama error: HTTP ${res.status}`);
      out.push((await res.json()).embedding as number[]);
    }
    return out;
  }
}

export class FakeProvider implements EmbeddingProvider {
  name = 'fake';
  private static DIM = 32;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(FakeProvider.DIM).fill(0);
      const s = t.toLowerCase();
      for (let i = 0; i < s.length - 2; i++) {
        let h = 0;
        for (let j = i; j < i + 3; j++) h = (h * 31 + s.charCodeAt(j)) >>> 0;
        v[h % FakeProvider.DIM] += 1;
      }
      const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

export function getProvider(
  env: Record<string, string | undefined> = process.env
): EmbeddingProvider | null {
  const mode = env.LOREWEAVER_EMBEDDINGS ?? 'ollama';
  if (mode === 'none') return null;
  if (mode === 'fake') return new FakeProvider();
  return new OllamaProvider();
}
