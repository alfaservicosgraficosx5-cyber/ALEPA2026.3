import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import { GoogleGenAI } from '@google/genai';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_MODEL = 'gemini-4-hydrogen';

const SPOTIFY_SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-recently-played',
].join(' ');

const pendingSpotifyStates = new Map<string, { createdAt: number; redirectUri: string }>();

function getSpotifyCredentials(): { clientId: string; clientSecret: string } {
  return {
    clientId: process.env.SPOTIFY_CLIENT_ID?.trim() || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET?.trim() || '',
  };
}

function getSpotifyRedirectUri(): string {
  const baseUrl = (process.env.APP_URL?.trim() || `http://localhost:${PORT}`).replace(/\/+$/, '');
  return `${baseUrl}/api/spotify/callback`;
}

function cleanupExpiredSpotifyStates(): void {
  const now = Date.now();
  for (const [stateKey, info] of pendingSpotifyStates.entries()) {
    if (now - info.createdAt > 15 * 60 * 1000) {
      pendingSpotifyStates.delete(stateKey);
    }
  }
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function extractSpotifyBearer(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  return token || null;
}

async function fetchSpotifyApi<T = unknown>(
  endpointPath: string,
  accessToken: string
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const url = endpointPath.startsWith('http')
    ? endpointPath
    : `https://api.spotify.com/v1${endpointPath}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (res.status === 401) {
    return { ok: false, status: 401, error: 'SPOTIFY_TOKEN_EXPIRED' };
  }

  if (!res.ok) {
    let errMessage = `Erro na API do Spotify (${res.status})`;
    try {
      const errJson = (await res.json()) as { error?: { message?: string } | string };
      if (typeof errJson.error === 'string') {
        errMessage = errJson.error;
      } else if (errJson.error?.message) {
        errMessage = errJson.error.message;
      }
    } catch {
      // ignore json parse failure
    }
    return { ok: false, status: res.status, error: errMessage };
  }

  const data = (await res.json()) as T;
  return { ok: true, status: res.status, data };
}

let cachedSpotifyAppToken: { token: string; expiresAt: number } | null = null;

async function getSpotifyAppToken(): Promise<string | null> {
  const { clientId, clientSecret } = getSpotifyCredentials();
  if (!clientId || !clientSecret) return null;

  if (cachedSpotifyAppToken && Date.now() < cachedSpotifyAppToken.expiresAt - 30_000) {
    return cachedSpotifyAppToken.token;
  }

  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;

    cachedSpotifyAppToken = {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
    };
    return cachedSpotifyAppToken.token;
  } catch {
    return null;
  }
}

function parseSpotifyTarget(raw: string): {
  kind: 'user' | 'episode' | 'show' | 'playlist' | 'track' | 'album' | 'home' | 'unknown';
  id: string | null;
  canonicalUrl: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'unknown', id: null, canonicalUrl: '' };

  const uriMatch = trimmed.match(/^spotify:(user|episode|show|playlist|track|album):([a-zA-Z0-9._-]+)$/i);
  if (uriMatch) {
    const kind = uriMatch[1].toLowerCase() as 'user' | 'episode' | 'show' | 'playlist' | 'track' | 'album';
    const id = uriMatch[2];
    return { kind, id, canonicalUrl: `https://open.spotify.com/${kind}/${id}` };
  }

  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const itemMatch = normalized.match(
    /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(user|episode|show|playlist|track|album)\/([a-zA-Z0-9._-]+)/i
  );
  if (itemMatch) {
    const kind = itemMatch[1].toLowerCase() as 'user' | 'episode' | 'show' | 'playlist' | 'track' | 'album';
    const id = itemMatch[2];
    return { kind, id, canonicalUrl: `https://open.spotify.com/${kind}/${id}` };
  }

  if (/open\.spotify\.com(?:\/intl-[a-z-]+)?\/?$/i.test(normalized)) {
    return { kind: 'home', id: null, canonicalUrl: normalized };
  }

  return { kind: 'unknown', id: null, canonicalUrl: normalized };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GEMINI_KEY_MISSING');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractYouTubeId(rawUrl: string): string | null {
  const url = rawUrl.trim();
  if (!url) return null;
  const watch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (watch) return watch[1];
  const short = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (short) return short[1];
  const pathMatch = url.match(/youtube\.com\/(?:shorts|live|embed)\/([a-zA-Z0-9_-]{11})/);
  if (pathMatch) return pathMatch[1];
  return null;
}

function normalizeUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function formatGeminiError(err: unknown): { status: number; message: string } {
  const rawMessage = err instanceof Error ? err.message : String(err);
  if (rawMessage === 'GEMINI_KEY_MISSING') {
    return {
      status: 503,
      message:
        'A chave da API Gemini ainda não está disponível neste ambiente. Verifique o painel Settings > Secrets.',
    };
  }
  const lower = rawMessage.toLowerCase();
  if (lower.includes('api_key_invalid') || lower.includes('api key not valid')) {
    return {
      status: 400,
      message: 'A chave da API Gemini configurada está inválida. Verifique no painel Settings > Secrets.',
    };
  }
  if (lower.includes('permission_denied') || lower.includes('403')) {
    return {
      status: 403,
      message: 'Permissão negada ao acessar o Gemini. Verifique a chave configurada em Settings > Secrets.',
    };
  }
  if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota')) {
    return {
      status: 429,
      message: 'Limite temporário de uso da API Gemini atingido. Aguarde alguns instantes e tente novamente.',
    };
  }
  if (lower.includes('not_found') || lower.includes('404')) {
    return {
      status: 404,
      message: 'Modelo ou recurso não encontrado no Gemini. Tente novamente em instantes.',
    };
  }
  return {
    status: 500,
    message: rawMessage || 'Não foi possível gerar o resumo com o Gemini agora.',
  };
}

function extractGroundingLinks(response: unknown): Array<{ title: string; uri: string }> {
  const res = response as {
    candidates?: Array<{
      groundingMetadata?: {
        groundingChunks?: Array<{
          web?: { uri?: string; title?: string };
        }>;
      };
    }>;
  };
  const chunks = res?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seen = new Set<string>();
  const links: Array<{ title: string; uri: string }> = [];
  for (const chunk of chunks) {
    const uri = chunk?.web?.uri;
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      links.push({
        uri,
        title: chunk.web?.title || uri,
      });
    }
  }
  return links;
}

const VIDEO_SYSTEM_INSTRUCTION = `Você é um tutor especialista em concursos públicos brasileiros (especialmente ALEPA 2026 · Banca Fundação CETAP).
Sua tarefa é resumir o conteúdo de videoaulas em português do Brasil claro, objetivo e didático para estudo rápido.

Formato recomendado (use quando os tempos e tópicos estiverem disponíveis no vídeo ou na transcrição):
1. Comece com um parágrafo curto de abertura explicando o tema central e eventuais mnemônicos (ex.: "O vídeo explica ... (0:00-0:37).").
2. Liste os principais tópicos em blocos claros no padrão:
   **Nome do Tópico (MM:SS-MM:SS):** Explicação direta, precisa e focada em o que cai em prova.
3. Finalize com uma seção curta **"Pontos de Atenção · Banca CETAP"** com 3 a 5 dicas objetivas de revisão/pegadinhas.

Regras:
- Nunca invente minutagens se elas não puderem ser observadas no vídeo ou no texto enviado; se não houver minutagens exatas disponíveis, organize por tópicos numerados sem inventar horários.
- Seja fiel ao conteúdo jurídico/técnico e destaque artigos constitucionais/legais citados.`;

const PDF_SYSTEM_INSTRUCTION = `Você é um tutor especialista em concursos públicos brasileiros (ALEPA 2026 · Banca Fundação CETAP).
Sua tarefa é resumir apostilas, editais, leis e materiais em PDF em português do Brasil claro e estruturado.

Formato da resposta:
1. **Visão Geral do Documento:** Síntese em 2 a 4 linhas do tema central e objetivo do material.
2. **Resumo Estruturado por Tópicos / Seções:** Organize os principais conceitos, regras, prazos, artigos e definições em tópicos claros com **títulos em negrito**.
3. **Artigos, Prazos e Exceções Importantes:** Liste números, quóruns, competências ou exceções legais relevantes para questões objetivas.
4. **Resumo Relâmpago para Revisão (CETAP):** 3 a 5 bullets curtos com o que mais costuma ser cobrado em prova.`;

async function createApp() {
  const app = express();
  app.use(express.json({ limit: '28mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, model: GEMINI_MODEL });
  });

  // ---------------------------------------------------------------------------
  // Spotify OAuth & Web API Proxy Routes
  // ---------------------------------------------------------------------------
  app.get('/api/spotify/status', (_req: Request, res: Response) => {
    const { clientId, clientSecret } = getSpotifyCredentials();
    const redirectUri = getSpotifyRedirectUri();
    res.json({
      configured: Boolean(clientId && clientSecret),
      redirectUri,
      scopes: SPOTIFY_SCOPES.split(' '),
    });
  });

  app.get('/api/spotify/auth/url', (_req: Request, res: Response) => {
    const { clientId, clientSecret } = getSpotifyCredentials();
    const redirectUri = getSpotifyRedirectUri();

    if (!clientId || !clientSecret) {
      res.status(503).json({
        configured: false,
        redirectUri,
        error:
          'Credenciais do Spotify (SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET) ainda não configuradas nas variáveis de ambiente.',
      });
      return;
    }

    cleanupExpiredSpotifyStates();
    const state = crypto.randomBytes(24).toString('hex');
    pendingSpotifyStates.set(state, { createdAt: Date.now(), redirectUri });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SPOTIFY_SCOPES,
      redirect_uri: redirectUri,
      state,
      show_dialog: 'true',
    });

    res.json({
      configured: true,
      redirectUri,
      url: `https://accounts.spotify.com/authorize?${params.toString()}`,
    });
  });

  const handleSpotifyCallback = async (req: Request, res: Response) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const oauthError = typeof req.query.error === 'string' ? req.query.error : '';

    const sendPopupHtml = (messagePayload: Record<string, unknown>, titleText: string, bodyText: string) => {
      const serialized = serializeForInlineScript(messagePayload);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${titleText}</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
      .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 24px; max-width: 420px; width: 100%; text-align: center; }
      h1 { font-size: 18px; margin: 0 0 8px; color: #0b3321; }
      p { font-size: 14px; color: #475569; margin: 0 0 16px; line-height: 1.5; }
      a { display: inline-block; padding: 10px 16px; background: #0b3321; color: #fff; text-decoration: none; border-radius: 10px; font-size: 13px; font-weight: 600; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${titleText}</h1>
      <p>${bodyText}</p>
      <a href="/">Voltar para o Concurso ALEPA 2026</a>
    </div>
    <script>
      (function () {
        var msg = ${serialized};
        try {
          if (window.opener) {
            window.opener.postMessage(msg, '*');
            window.close();
          }
        } catch (e) {}
      })();
    </script>
  </body>
</html>`);
    };

    if (oauthError) {
      sendPopupHtml(
        { type: 'SPOTIFY_OAUTH_ERROR', error: oauthError },
        'Conexão Spotify cancelada',
        'A autorização foi cancelada ou negada no Spotify. Você pode fechar esta janela e tentar novamente.'
      );
      return;
    }

    cleanupExpiredSpotifyStates();
    const stateRecord = state ? pendingSpotifyStates.get(state) : undefined;
    if (!code || !state || !stateRecord) {
      sendPopupHtml(
        {
          type: 'SPOTIFY_OAUTH_ERROR',
          error: 'Sessão de autenticação expirada ou inválida. Tente conectar novamente.',
        },
        'Sessão expirada',
        'Não foi possível validar o retorno do Spotify. Feche esta janela e clique em "Conectar com Spotify" novamente.'
      );
      return;
    }

    pendingSpotifyStates.delete(state);
    const { clientId, clientSecret } = getSpotifyCredentials();
    if (!clientId || !clientSecret) {
      sendPopupHtml(
        { type: 'SPOTIFY_OAUTH_ERROR', error: 'Credenciais do Spotify não configuradas no servidor.' },
        'Configuração pendente',
        'As credenciais SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET não foram encontradas no servidor.'
      );
      return;
    }

    try {
      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: stateRecord.redirectUri,
      });

      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: tokenBody.toString(),
      });

      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        error?: string;
        error_description?: string;
      };

      if (!tokenRes.ok || !tokenJson.access_token) {
        sendPopupHtml(
          {
            type: 'SPOTIFY_OAUTH_ERROR',
            error: tokenJson.error_description || tokenJson.error || 'Falha ao trocar código no Spotify.',
          },
          'Erro ao autenticar no Spotify',
          tokenJson.error_description || 'Não foi possível concluir a autenticação com o Spotify.'
        );
        return;
      }

      const meResult = await fetchSpotifyApi<{
        id: string;
        display_name?: string;
        email?: string;
        product?: string;
        country?: string;
        images?: Array<{ url: string }>;
        external_urls?: { spotify?: string };
      }>('/me', tokenJson.access_token);

      const expiresAt = Date.now() + Math.max(60, (tokenJson.expires_in || 3600) - 60) * 1000;

      sendPopupHtml(
        {
          type: 'SPOTIFY_OAUTH_SUCCESS',
          payload: {
            accessToken: tokenJson.access_token,
            refreshToken: tokenJson.refresh_token || '',
            expiresAt,
            scope: tokenJson.scope || SPOTIFY_SCOPES,
            user: meResult.ok && meResult.data
              ? {
                  id: meResult.data.id,
                  displayName: meResult.data.display_name || meResult.data.id,
                  email: meResult.data.email || '',
                  product: meResult.data.product || 'free',
                  avatarUrl: meResult.data.images?.[0]?.url || '',
                  profileUrl: meResult.data.external_urls?.spotify || 'https://open.spotify.com',
                }
              : null,
          },
        },
        'Spotify conectado!',
        'Sua conta Spotify foi conectada ao Concurso ALEPA 2026. Esta janela será fechada automaticamente.'
      );
    } catch (err) {
      sendPopupHtml(
        {
          type: 'SPOTIFY_OAUTH_ERROR',
          error: err instanceof Error ? err.message : 'Erro interno ao concluir OAuth do Spotify.',
        },
        'Erro na conexão',
        'Ocorreu um erro inesperado ao comunicar com o Spotify. Feche esta janela e tente novamente.'
      );
    }
  };

  app.get(['/api/spotify/callback', '/api/spotify/callback/'], handleSpotifyCallback);

  app.post('/api/spotify/refresh', async (req: Request, res: Response) => {
    try {
      const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : '';
      if (!refreshToken) {
        res.status(400).json({ error: 'Refresh token não informado.' });
        return;
      }

      const { clientId, clientSecret } = getSpotifyCredentials();
      if (!clientId || !clientSecret) {
        res.status(503).json({ error: 'Credenciais do Spotify não configuradas no servidor.' });
        return;
      }

      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const tokenBody = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });

      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: tokenBody.toString(),
      });

      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error_description?: string;
        error?: string;
      };

      if (!tokenRes.ok || !tokenJson.access_token) {
        res.status(401).json({
          error: tokenJson.error_description || tokenJson.error || 'Sessão Spotify expirada. Reconecte sua conta.',
        });
        return;
      }

      const expiresAt = Date.now() + Math.max(60, (tokenJson.expires_in || 3600) - 60) * 1000;
      res.json({
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token || refreshToken,
        expiresAt,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Erro ao renovar token do Spotify.',
      });
    }
  });

  app.get('/api/spotify/me', async (req: Request, res: Response) => {
    const token = extractSpotifyBearer(req);
    if (!token) {
      res.status(401).json({ error: 'Token do Spotify não enviado.' });
      return;
    }

    const result = await fetchSpotifyApi<{
      id: string;
      display_name?: string;
      email?: string;
      product?: string;
      images?: Array<{ url: string }>;
      external_urls?: { spotify?: string };
    }>('/me', token);

    if (!result.ok || !result.data) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json({
      id: result.data.id,
      displayName: result.data.display_name || result.data.id,
      email: result.data.email || '',
      product: result.data.product || 'free',
      avatarUrl: result.data.images?.[0]?.url || '',
      profileUrl: result.data.external_urls?.spotify || 'https://open.spotify.com',
    });
  });

  app.get('/api/spotify/search', async (req: Request, res: Response) => {
    const token = extractSpotifyBearer(req);
    if (!token) {
      res.status(401).json({ error: 'Conecte sua conta Spotify para pesquisar.' });
      return;
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const types = typeof req.query.type === 'string' && req.query.type.trim()
      ? req.query.type.trim()
      : 'episode,show,playlist,track';

    if (!q) {
      res.status(400).json({ error: 'Informe um termo para pesquisar no Spotify.' });
      return;
    }

    const params = new URLSearchParams({
      q,
      type: types,
      market: 'BR',
      limit: '10',
    });

    const result = await fetchSpotifyApi(`/search?${params.toString()}`, token);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json(result.data);
  });

  app.get('/api/spotify/library', async (req: Request, res: Response) => {
    const token = extractSpotifyBearer(req);
    if (!token) {
      res.status(401).json({ error: 'Conecte sua conta Spotify para carregar sua biblioteca.' });
      return;
    }

    const [showsRes, episodesRes, playlistsRes] = await Promise.all([
      fetchSpotifyApi<{ items?: unknown[] }>('/me/shows?limit=20', token),
      fetchSpotifyApi<{ items?: unknown[] }>('/me/episodes?market=BR&limit=20', token),
      fetchSpotifyApi<{ items?: unknown[] }>('/me/playlists?limit=20', token),
    ]);

    if (showsRes.status === 401 || episodesRes.status === 401 || playlistsRes.status === 401) {
      res.status(401).json({ error: 'SPOTIFY_TOKEN_EXPIRED' });
      return;
    }

    res.json({
      shows: showsRes.ok ? showsRes.data?.items || [] : [],
      episodes: episodesRes.ok ? episodesRes.data?.items || [] : [],
      playlists: playlistsRes.ok ? playlistsRes.data?.items || [] : [],
    });
  });

  app.get('/api/spotify/shows/:id/episodes', async (req: Request, res: Response) => {
    const token = extractSpotifyBearer(req);
    if (!token) {
      res.status(401).json({ error: 'Token do Spotify não enviado.' });
      return;
    }

    const showId = encodeURIComponent(String(req.params.id || '').trim());
    const result = await fetchSpotifyApi<{ items?: unknown[] }>(
      `/shows/${showId}/episodes?market=BR&limit=20`,
      token
    );

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json({ items: result.data?.items || [] });
  });

  app.get('/api/spotify/users/:userId/playlists', async (req: Request, res: Response) => {
    const userId = String(req.params.userId || '').trim();
    if (!userId) {
      res.status(400).json({ error: 'ID de usuário do Spotify não informado.' });
      return;
    }

    const token = extractSpotifyBearer(req) || (await getSpotifyAppToken());
    if (!token) {
      res.status(200).json({ items: [], requiresAuth: true });
      return;
    }

    const result = await fetchSpotifyApi<{ items?: unknown[] }>(
      `/users/${encodeURIComponent(userId)}/playlists?limit=20`,
      token
    );
    if (!result.ok) {
      res.status(result.status).json({ error: result.error, items: [] });
      return;
    }

    res.json({ items: result.data?.items || [], requiresAuth: false });
  });

  app.get('/api/spotify/resolve', async (req: Request, res: Response) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!rawUrl) {
      res.status(400).json({ error: 'Informe um link do Spotify para resolver.' });
      return;
    }

    const parsed = parseSpotifyTarget(rawUrl);
    if (parsed.kind === 'home') {
      res.json({
        kind: 'home',
        canonicalUrl: parsed.canonicalUrl,
        title: 'Spotify Web (Brasil / PT)',
      });
      return;
    }

    if (parsed.kind === 'unknown' || !parsed.id) {
      res.status(400).json({
        error:
          'Link do Spotify não reconhecido. Cole um link de perfil (open.spotify.com/user/...), episódio, podcast, playlist ou faixa.',
      });
      return;
    }

    const token = extractSpotifyBearer(req) || (await getSpotifyAppToken());

    if (parsed.kind === 'user') {
      let displayName = parsed.id;
      let avatarUrl = '';
      let playlists: unknown[] = [];

      if (token) {
        const [profileRes, playlistsRes] = await Promise.all([
          fetchSpotifyApi<{
            id: string;
            display_name?: string;
            images?: Array<{ url: string }>;
            external_urls?: { spotify?: string };
          }>(`/users/${encodeURIComponent(parsed.id)}`, token),
          fetchSpotifyApi<{ items?: unknown[] }>(
            `/users/${encodeURIComponent(parsed.id)}/playlists?limit=20`,
            token
          ),
        ]);

        if (profileRes.ok && profileRes.data) {
          displayName = profileRes.data.display_name || parsed.id;
          avatarUrl = profileRes.data.images?.[0]?.url || '';
        }
        if (playlistsRes.ok && playlistsRes.data?.items) {
          playlists = playlistsRes.data.items;
        }
      } else {
        try {
          const pageRes = await fetch(parsed.canonicalUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
          });
          if (pageRes.ok) {
            const html = await pageRes.text();
            const ogTitle = html.match(/<meta property="og:title" content="([^"]*)"/i)?.[1];
            const ogImage = html.match(/<meta property="og:image" content="([^"]*)"/i)?.[1];
            if (ogTitle) displayName = decodeHtmlEntities(ogTitle);
            if (ogImage) avatarUrl = ogImage;
          }
        } catch {
          // ignore public html fetch fallback failure
        }
      }

      res.json({
        kind: 'user',
        user: {
          id: parsed.id,
          displayName,
          profileUrl: parsed.canonicalUrl,
          avatarUrl,
        },
        playlists,
        hasApiPlaylists: Boolean(token),
      });
      return;
    }

    // Episode, Show, Playlist, Track, or Album: try Web API first if token available, else Spotify public oEmbed
    if (token) {
      const apiPathMap: Record<'episode' | 'show' | 'playlist' | 'track' | 'album', string> = {
        episode: `/episodes/${encodeURIComponent(parsed.id)}?market=BR`,
        show: `/shows/${encodeURIComponent(parsed.id)}?market=BR`,
        playlist: `/playlists/${encodeURIComponent(parsed.id)}?market=BR`,
        track: `/tracks/${encodeURIComponent(parsed.id)}?market=BR`,
        album: `/albums/${encodeURIComponent(parsed.id)}?market=BR`,
      };
      const apiRes = await fetchSpotifyApi<Record<string, unknown>>(apiPathMap[parsed.kind], token);
      if (apiRes.ok && apiRes.data) {
        const d = apiRes.data;
        const images = (d.images as Array<{ url?: string }> | undefined) ||
          ((d.show as { images?: Array<{ url?: string }> } | undefined)?.images) ||
          ((d.album as { images?: Array<{ url?: string }> } | undefined)?.images);
        const subtitle =
          (d.show as { name?: string } | undefined)?.name ||
          (d.publisher as string | undefined) ||
          ((d.owner as { display_name?: string } | undefined)?.display_name) ||
          ((d.artists as Array<{ name?: string }> | undefined)?.map((a) => a.name).filter(Boolean).join(', ')) ||
          'Spotify';

        res.json({
          kind: 'media',
          item: {
            id: parsed.id,
            kind: parsed.kind === 'album' ? 'playlist' : parsed.kind,
            title: String(d.name || 'Conteúdo Spotify'),
            subtitle: String(subtitle),
            description: typeof d.description === 'string' ? d.description : '',
            url: parsed.canonicalUrl,
            embedUrl: `https://open.spotify.com/embed/${parsed.kind}/${parsed.id}?utm_source=generator`,
            imageUrl: images?.[0]?.url || '',
            durationMs: typeof d.duration_ms === 'number' ? d.duration_ms : undefined,
            releaseDate: typeof d.release_date === 'string' ? d.release_date : undefined,
          },
        });
        return;
      }
    }

    try {
      const oembedRes = await fetch(
        `https://open.spotify.com/oembed?url=${encodeURIComponent(parsed.canonicalUrl)}`
      );
      if (oembedRes.ok) {
        const oembed = (await oembedRes.json()) as {
          title?: string;
          thumbnail_url?: string;
          provider_name?: string;
          iframe_url?: string;
        };
        res.json({
          kind: 'media',
          item: {
            id: parsed.id,
            kind: parsed.kind === 'album' ? 'playlist' : parsed.kind,
            title: oembed.title || `Spotify ${parsed.kind}`,
            subtitle: oembed.provider_name || 'Spotify',
            url: parsed.canonicalUrl,
            embedUrl:
              oembed.iframe_url ||
              `https://open.spotify.com/embed/${parsed.kind}/${parsed.id}?utm_source=generator`,
            imageUrl: oembed.thumbnail_url || '',
          },
        });
        return;
      }
    } catch {
      // fallback below
    }

    res.json({
      kind: 'media',
      item: {
        id: parsed.id,
        kind: parsed.kind === 'album' ? 'playlist' : parsed.kind,
        title: `Conteúdo Spotify (${parsed.kind})`,
        subtitle: 'Spotify',
        url: parsed.canonicalUrl,
        embedUrl: `https://open.spotify.com/embed/${parsed.kind}/${parsed.id}?utm_source=generator`,
      },
    });
  });

  app.post('/api/gemini/summarize-video', async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as {
        url?: string;
        title?: string;
        transcriptOrNotes?: string;
        disciplineName?: string;
        customFocus?: string;
      };

      const rawUrl = typeof body.url === 'string' ? normalizeUrlInput(body.url) : '';
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const transcriptOrNotes =
        typeof body.transcriptOrNotes === 'string' ? body.transcriptOrNotes.trim() : '';
      const disciplineName = typeof body.disciplineName === 'string' ? body.disciplineName.trim() : '';
      const customFocus = typeof body.customFocus === 'string' ? body.customFocus.trim() : '';

      if (!rawUrl && !transcriptOrNotes) {
        res.status(400).json({
          error: 'Informe o link do vídeo (YouTube, Instagram, TikTok) ou cole anotações/transcrição para resumir.',
        });
        return;
      }

      const ai = getGeminiClient();
      const ytId = rawUrl ? extractYouTubeId(rawUrl) : null;
      const canonicalYtUrl = ytId ? `https://www.youtube.com/watch?v=${ytId}` : null;

      const userPromptParts = [
        title ? `Título informado: ${title}` : '',
        disciplineName ? `Disciplina de estudo: ${disciplineName}` : '',
        rawUrl ? `Link do vídeo: ${canonicalYtUrl || rawUrl}` : '',
        customFocus ? `Foco pedido pelo estudante: ${customFocus}` : '',
        transcriptOrNotes
          ? `Anotações / transcrição fornecida pelo estudante:\n${transcriptOrNotes}`
          : 'Gere um resumo didático completo por tópicos (com intervalos de tempo MM:SS-MM:SS sempre que identificáveis no vídeo).',
      ].filter(Boolean);
      const userPrompt = userPromptParts.join('\n\n');

      // 1. Direct multimodal YouTube summarization when a YouTube video ID is present
      if (canonicalYtUrl) {
        try {
          const response = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    fileData: {
                      fileUri: canonicalYtUrl,
                      mimeType: 'video/mp4',
                    },
                  },
                  { text: userPrompt },
                ],
              },
            ],
            config: {
              systemInstruction: VIDEO_SYSTEM_INSTRUCTION,
            },
          });

          const text = response.text?.trim();
          if (text) {
            res.json({
              summary: text,
              model: GEMINI_MODEL,
              sourceMode: 'youtube_video',
              sources: [{ title: title || 'Vídeo no YouTube', uri: canonicalYtUrl }],
            });
            return;
          }
        } catch (ytErr) {
          console.warn('Fallback após análise direta do YouTube:', ytErr instanceof Error ? ytErr.message : ytErr);
        }
      }

      // 2. Fallback or non-YouTube URL: urlContext + googleSearch, or direct notes summarization
      if (rawUrl) {
        try {
          const response = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: `${userPrompt}\n\nSe não for possível ler diretamente o áudio/vídeo deste link externo, deixe claro o que pôde ser obtido pela página/pesquisa ou pelas anotações enviadas, e ajude o estudante com uma explicação completa do tema identificado.`,
            config: {
              systemInstruction: VIDEO_SYSTEM_INSTRUCTION,
              tools: [{ urlContext: {} }, { googleSearch: {} }],
            },
          });
          const text = response.text?.trim();
          if (text) {
            const links = extractGroundingLinks(response);
            res.json({
              summary: text,
              model: GEMINI_MODEL,
              sourceMode: 'url_context',
              sources: links.length > 0 ? links : [{ title: title || 'Link do vídeo', uri: rawUrl }],
            });
            return;
          }
        } catch (urlErr) {
          if (!transcriptOrNotes) {
            throw urlErr;
          }
        }
      }

      // 3. Direct summarization from pasted transcript / notes
      const fallbackResponse = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: userPrompt,
        config: {
          systemInstruction: VIDEO_SYSTEM_INSTRUCTION,
        },
      });

      res.json({
        summary: fallbackResponse.text?.trim() || 'Não foi possível gerar texto para este vídeo.',
        model: GEMINI_MODEL,
        sourceMode: 'notes_only',
        sources: rawUrl ? [{ title: title || 'Link informado', uri: rawUrl }] : [],
      });
    } catch (err) {
      const mapped = formatGeminiError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post('/api/gemini/summarize-pdf', async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as {
        fileBase64?: string;
        fileName?: string;
        pdfUrl?: string;
        title?: string;
        disciplineName?: string;
        customFocus?: string;
      };

      const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : 'documento.pdf';
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const disciplineName = typeof body.disciplineName === 'string' ? body.disciplineName.trim() : '';
      const customFocus = typeof body.customFocus === 'string' ? body.customFocus.trim() : '';
      const rawPdfUrl = typeof body.pdfUrl === 'string' ? normalizeUrlInput(body.pdfUrl) : '';
      let base64Data = typeof body.fileBase64 === 'string' ? body.fileBase64.trim() : '';

      if (base64Data.includes(',')) {
        base64Data = base64Data.split(',')[1] || '';
      }

      if (!base64Data && !rawPdfUrl) {
        res.status(400).json({
          error: 'Envie um arquivo PDF ou informe o link do PDF/material para resumir.',
        });
        return;
      }

      const ai = getGeminiClient();

      const promptLines = [
        title ? `Título do material: ${title}` : '',
        fileName ? `Arquivo: ${fileName}` : '',
        disciplineName ? `Disciplina: ${disciplineName}` : '',
        customFocus ? `Foco pedido pelo estudante: ${customFocus}` : '',
        'Faça um resumo completo, fiel e bem organizado deste PDF para revisão de concurso.',
      ].filter(Boolean);
      const promptText = promptLines.join('\n');

      // Try fetching remote PDF bytes if pdfUrl was supplied without inline base64
      let fetchedUrlMode: 'pdf_inline' | 'url_context' = 'pdf_inline';
      if (!base64Data && rawPdfUrl) {
        let fetchTarget = rawPdfUrl;
        const driveMatch = rawPdfUrl.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i);
        if (driveMatch) {
          fetchTarget = `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
        }

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);
          const remoteRes = await fetch(fetchTarget, { signal: controller.signal });
          clearTimeout(timer);

          if (remoteRes.ok) {
            const ctype = (remoteRes.headers.get('content-type') || '').toLowerCase();
            const arrBuf = await remoteRes.arrayBuffer();
            const buf = Buffer.from(arrBuf);
            const looksLikePdf =
              ctype.includes('application/pdf') || buf.subarray(0, 4).toString('utf8') === '%PDF';

            if (looksLikePdf && buf.byteLength <= 18 * 1024 * 1024) {
              base64Data = buf.toString('base64');
              fetchedUrlMode = 'pdf_inline';
            } else {
              fetchedUrlMode = 'url_context';
            }
          } else {
            fetchedUrlMode = 'url_context';
          }
        } catch {
          fetchedUrlMode = 'url_context';
        }
      }

      if (base64Data) {
        const approxBytes = Math.floor((base64Data.length * 3) / 4);
        if (approxBytes > 20 * 1024 * 1024) {
          res.status(413).json({
            error: 'O PDF excede o limite de 20 MB para envio direto. Divida o arquivo em partes menores.',
          });
          return;
        }

        const response = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: 'application/pdf',
                    data: base64Data,
                  },
                },
                { text: promptText },
              ],
            },
          ],
          config: {
            systemInstruction: PDF_SYSTEM_INSTRUCTION,
          },
        });

        res.json({
          summary: response.text?.trim() || 'Não foi possível extrair texto deste PDF.',
          model: GEMINI_MODEL,
          sourceMode: fetchedUrlMode,
          sources: rawPdfUrl ? [{ title: title || fileName, uri: rawPdfUrl }] : [],
        });
        return;
      }

      // Fallback to urlContext for web pages / legislation links / Drive preview links
      const urlResponse = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: `${promptText}\n\nLink do material: ${rawPdfUrl}`,
        config: {
          systemInstruction: PDF_SYSTEM_INSTRUCTION,
          tools: [{ urlContext: {} }],
        },
      });

      const links = extractGroundingLinks(urlResponse);
      res.json({
        summary: urlResponse.text?.trim() || 'Não foi possível ler o link informado.',
        model: GEMINI_MODEL,
        sourceMode: 'url_context',
        sources: links.length > 0 ? links : [{ title: title || rawPdfUrl, uri: rawPdfUrl }],
      });
    } catch (err) {
      const mapped = formatGeminiError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post('/api/gemini/chat', async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as {
        messages?: Array<{ role?: string; text?: string }>;
        contextTitle?: string;
        contextSummary?: string;
        campus?: string;
      };

      const rawMessages = Array.isArray(body.messages) ? body.messages : [];
      const contents = rawMessages
        .filter((m) => typeof m?.text === 'string' && m.text.trim().length > 0)
        .slice(-16)
        .map((m) => ({
          role: m.role === 'model' ? ('model' as const) : ('user' as const),
          parts: [{ text: (m.text || '').trim() }],
        }));

      if (contents.length === 0) {
        res.status(400).json({ error: 'Digite uma pergunta para conversar com o Gemini.' });
        return;
      }

      const ai = getGeminiClient();
      const campusLabel =
        body.campus === 'medio'
          ? 'Nível Médio (Cargo 04 – Assistência Administrativa · PL.AL.060)'
          : 'Nível Superior (Cargo 03 – Assessoramento Legislativo · PL.AL.102)';

      const systemParts = [
        `Você é o assistente de estudos Gemini para o Concurso ALEPA 2026 (Banca Fundação CETAP), foco em ${campusLabel}.`,
        'Responda sempre em português do Brasil de forma clara, estruturada e objetiva.',
        body.contextTitle ? `Material em foco: ${body.contextTitle}` : '',
        body.contextSummary
          ? `Use também como referência o resumo já gerado abaixo:\n---\n${body.contextSummary.slice(0, 8000)}\n---`
          : '',
      ].filter(Boolean);

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: {
          systemInstruction: systemParts.join('\n\n'),
        },
      });

      res.json({
        reply: response.text?.trim() || 'Não consegui gerar uma resposta agora.',
        model: GEMINI_MODEL,
      });
    } catch (err) {
      const mapped = formatGeminiError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      const indexPath = path.join(distDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('Build not found.');
      }
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

createApp().catch((err) => {
  console.error('Erro fatal ao iniciar servidor:', err);
  process.exit(1);
});
