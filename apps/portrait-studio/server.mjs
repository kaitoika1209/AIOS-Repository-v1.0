#!/usr/bin/env node
/**
 * Portrait Studio local server.
 *
 * Serves the static UI and proxies image requests to the OpenAI API so the
 * API key stays on the machine running this process instead of in the browser.
 *
 *   OPENAI_API_KEY=sk-... node server.mjs        # http://localhost:5173
 *
 * Requires Node 18+ (global fetch / FormData passthrough).
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const API_KEY = process.env.OPENAI_API_KEY || '';
const UPSTREAM = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

// Only the image endpoints are reachable through the proxy.
const ALLOWED_PATHS = new Set(['/images/generations', '/images/edits']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 64 * 1024 * 1024; // reference images are sent inline

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('リクエストが大きすぎます'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function handleProxy(req, res, apiPath) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST のみ対応しています' } });
  if (!ALLOWED_PATHS.has(apiPath)) return sendJson(res, 404, { error: { message: `未対応のエンドポイント: ${apiPath}` } });
  if (!API_KEY) return sendJson(res, 500, { error: { message: 'OPENAI_API_KEY が設定されていません' } });

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return sendJson(res, 413, { error: { message: error.message } });
  }

  try {
    // The body (JSON or multipart) is forwarded untouched; only auth is added.
    const upstream = await fetch(UPSTREAM + apiPath, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': req.headers['content-type'] || 'application/json',
      },
      body,
    });

    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    });
    res.end(text);
  } catch (error) {
    sendJson(res, 502, { error: { message: `OpenAI API への接続に失敗しました: ${error.message}` } });
  }
}

async function handleStatic(req, res, pathname) {
  const relative = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, relative);
  if (!file.startsWith(ROOT)) return sendJson(res, 403, { error: { message: 'forbidden' } });

  try {
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
  if (pathname.startsWith('/api/')) {
    await handleProxy(req, res, pathname.slice('/api'.length));
  } else {
    await handleStatic(req, res, pathname);
  }
}).listen(PORT, () => {
  console.log(`Portrait Studio → http://localhost:${PORT}`);
  if (!API_KEY) console.warn('警告: OPENAI_API_KEY が未設定です。生成リクエストは失敗します。');
});
