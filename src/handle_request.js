import { handleVerification } from './verify_keys.js';
import openai from './openai.mjs';

export async function handleRequest(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    return new Response('Proxy is Running!  More Details: https://github.com/tech-shrimp/gemini-balance-lite', {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
  }

  if (pathname === '/verify' && request.method === 'POST') {
    return handleVerification(request);
  }

  // 仅拦截非 Gemini 原生路径的 OpenAI 格式请求，避免误伤 /v1beta/models
  const isGeminiNative = pathname.startsWith('/v1beta') || pathname.startsWith('/v1alpha');
  if (!isGeminiNative && (
    pathname.endsWith('/chat/completions') ||
    pathname.endsWith('/completions') ||
    pathname.endsWith('/embeddings') ||
    pathname.endsWith('/models')
  )) {
    return openai.fetch(request);
  }

  // 兼容从 x-goog-api-key、Authorization 或 URL ?key= 提取密钥（支持逗号分隔多 Key 轮询）
  let rawKey = request.headers.get('x-goog-api-key') || '';
  if (!rawKey) {
    const authHeader = request.headers.get('authorization') || '';
    if (authHeader.toLowerCase().startsWith('bearer ')) {
      rawKey = authHeader.slice(7).trim();
    }
  }
  if (!rawKey && url.searchParams.has('key')) {
    rawKey = url.searchParams.get('key') || '';
  }

  let selectedKey = '';
  if (rawKey) {
    const apiKeys = rawKey.split(',').map(k => k.trim()).filter(Boolean);
    if (apiKeys.length > 0) {
      selectedKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];
    }
  }

  // 剔除 URL 中的 key 参数，统一改用请求头鉴权以兼容 AQ.Ab8... 新密钥
  const cleanSearchParams = new URLSearchParams(url.searchParams);
  cleanSearchParams.delete('key');
  const cleanSearch = cleanSearchParams.toString() ? `?${cleanSearchParams.toString()}` : '';

  // 若客户端漏填 /v1beta 前缀则自动补全
  const normalizedPath = isGeminiNative ? pathname : `/v1beta${pathname.startsWith('/') ? '' : '/'}${pathname}`;
  const targetUrl = `https://generativelanguage.googleapis.com${normalizedPath}${cleanSearch}`;

  try {
    const headers = new Headers();
    if (selectedKey) {
      headers.set('x-goog-api-key', selectedKey);
    }
    const contentType = request.headers.get('content-type');
    if (contentType) {
      headers.set('content-type', contentType);
    }

    let bodyBuffer = undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
      bodyBuffer = await request.arrayBuffer();
    }

    let response = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      body: bodyBuffer
    });

    // 若 AQ.Ab8... 属于 Vertex AI Express 密钥，自动回退至 Vertex 端点重试
    if ((response.status === 401 || response.status === 403) && selectedKey.startsWith('AQ.')) {
      const vertexPath = normalizedPath.replace(/^\/v1beta/, '');
      const vertexParams = new URLSearchParams(cleanSearchParams);
      vertexParams.set('key', selectedKey);
      const vertexUrl = `https://aiplatform.googleapis.com/v1/publishers/google${vertexPath}?${vertexParams.toString()}`;
      const vertexHeaders = new Headers();
      if (contentType) {
        vertexHeaders.set('content-type', contentType);
      }
      response = await fetch(vertexUrl, {
        method: request.method,
        headers: vertexHeaders,
        body: bodyBuffer
      });
    }

    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete('transfer-encoding');
    responseHeaders.delete('connection');
    responseHeaders.delete('keep-alive');
    responseHeaders.delete('content-encoding');
    responseHeaders.set('Referrer-Policy', 'no-referrer');

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders
    });

  } catch (error) {
    console.error('Failed to fetch:', error);
    return new Response('Internal Server Error\n' + error?.stack, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}
