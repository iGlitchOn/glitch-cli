import type { Content, GoogleGenAI } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import {
  VERTEX_CONTINUE_PROMPT,
  normalizeHistoryForVertex,
} from '../core/history.js';
import { withRetryBackoff } from '../core/retry.js';
import {
  CustomProviderAdapter,
  buildCustomRequestBody,
  buildEndpointUrl,
} from '../providers/custom.js';
import { VertexProviderAdapter } from '../providers/vertex.js';

describe('Etapa 4: Proveedor personalizado, historial anti-400 de Vertex y reintentos', () => {
  it('agrega un turno de usuario "continúa" si el historial termina en turno de modelo sin functionCall', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'Hola' }] },
      { role: 'model', parts: [{ text: 'Respuesta parcial' }] },
    ];

    const normalized = normalizeHistoryForVertex(history);
    expect(normalized).toHaveLength(3);
    expect(normalized[2]).toEqual({
      role: 'user',
      parts: [{ text: VERTEX_CONTINUE_PROMPT }],
    });
  });

  it('descarta el turno parcial final del modelo si solo tiene thoughts', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'Explica esto' }] },
      {
        role: 'model',
        parts: [
          {
            text: 'Pensando internamente...',
            thought: true,
            thoughtSignature: 'sig-123',
          },
        ],
      },
    ];

    const normalized = normalizeHistoryForVertex(history);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.role).toBe('user');
  });

  it('NO agrega "continúa" si el último turno del modelo contiene un functionCall y conserva thoughtSignature', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'Lee el archivo' }] },
      {
        role: 'model',
        parts: [
          {
            text: 'Voy a usar read_file',
            thought: true,
            thoughtSignature: 'sig-abc-999',
          },
          {
            functionCall: { name: 'read_file', args: { path: 'a.txt' } },
            thoughtSignature: 'sig-call-1',
          },
        ],
      },
    ];

    const normalized = normalizeHistoryForVertex(history);
    expect(normalized).toHaveLength(2);
    expect(normalized[1]?.parts?.[0]?.thoughtSignature).toBe('sig-abc-999');
    expect(normalized[1]?.parts?.[1]?.thoughtSignature).toBe('sig-call-1');
  });

  it('reintenta hasta 3 veces con backoff solo para 429 y errores de red (aplicando anti-400 en cada intento)', async () => {
    const seenContentsPerAttempt: Content[][] = [];
    let calls = 0;

    const fakeAi = {
      models: {
        generateContentStream: vi.fn(
          async (params: { contents: Content[] }) => {
            calls++;
            seenContentsPerAttempt.push(params.contents);
            if (calls <= 2) {
              const rateErr = new Error('429 Too Many Requests') as Error & {
                status?: number;
              };
              rateErr.status = 429;
              throw rateErr;
            }
            return (async function* () {
              yield {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: 'Respuesta tras retry',
                          thoughtSignature: 'sig-final',
                        },
                      ],
                    },
                  },
                ],
              };
            })();
          },
        ),
      },
    } as unknown as GoogleGenAI;

    const adapter = new VertexProviderAdapter(fakeAi, {
      maxRetries: 3,
      baseDelayMs: 1,
    });

    const historyEndingWithModel: Content[] = [
      { role: 'user', parts: [{ text: 'Inicio' }] },
      { role: 'model', parts: [{ text: 'Cortado' }] },
    ];

    const chunks = [];
    for await (const ch of adapter.streamTurn(historyEndingWithModel, {
      model: 'gemini-4-argon',
      effort: 'high',
      includeThoughts: true,
      subMode: 'agent',
    })) {
      chunks.push(ch);
    }

    expect(calls).toBe(3);
    expect(seenContentsPerAttempt).toHaveLength(3);
    for (const attemptContents of seenContentsPerAttempt) {
      expect(attemptContents.at(-1)).toEqual({
        role: 'user',
        parts: [{ text: 'continúa' }],
      });
    }
    expect(chunks[0]?.text).toBe('Respuesta tras retry');
    expect(chunks[0]?.rawParts?.[0]?.thoughtSignature).toBe('sig-final');

    // No debe reintentar en error 400
    let badRequestCalls = 0;
    await expect(
      withRetryBackoff(
        async () => {
          badRequestCalls++;
          const err400 = new Error('400 Bad Request') as Error & {
            status?: number;
          };
          err400.status = 400;
          throw err400;
        },
        { maxRetries: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('400 Bad Request');
    expect(badRequestCalls).toBe(1);
  });

  it('adapta API personalizada (/v1/chat/completions y /v1/responses) mapeando effort a reasoning_effort y ocultando la API key en errores', async () => {
    expect(
      buildEndpointUrl('https://api.example.com', 'chat_completions'),
    ).toBe('https://api.example.com/v1/chat/completions');
    expect(buildEndpointUrl('https://api.example.com/v1', 'responses')).toBe(
      'https://api.example.com/v1/responses',
    );

    const history: Content[] = [{ role: 'user', parts: [{ text: 'Hola' }] }];
    const bodyChat = buildCustomRequestBody(
      {
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-secret-123456789',
        format: 'chat_completions',
      },
      history,
      {
        model: 'o3-mini',
        effort: 'high',
        includeThoughts: true,
        subMode: 'agent',
      },
    );
    expect(bodyChat['reasoning_effort']).toBe('high');

    const bodyResponses = buildCustomRequestBody(
      {
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-secret-123456789',
        format: 'responses',
      },
      history,
      {
        model: 'o3-mini',
        effort: 'low',
        includeThoughts: true,
        subMode: 'agent',
      },
    );
    expect(bodyResponses['reasoning']).toEqual({ effort: 'low' });

    const secretKey = 'sk-super-secret-token-9876';
    const fakeFetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => `Invalid key provided: ${secretKey}`,
    })) as unknown as typeof fetch;

    const customAdapter = new CustomProviderAdapter(
      {
        baseUrl: 'https://api.example.com',
        apiKey: secretKey,
        format: 'chat_completions',
      },
      fakeFetch,
      { maxRetries: 3, baseDelayMs: 1 },
    );

    await expect(async () => {
      for await (const _ of customAdapter.streamTurn(history, {
        model: 'custom-model',
        effort: 'medium',
        includeThoughts: true,
        subMode: 'agent',
      })) {
        // no-op
      }
    }).rejects.toThrow('sk-****9876');
  });
});
