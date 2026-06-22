import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * SvelteKit API endpoint — proxies chat completion requests to the Mimo v2.5 pro
 * model via the local 9Router proxy (OpenAI-compatible format).
 *
 * Supports streaming (SSE) and non-streaming responses.
 * Supports function calling (tools) for Stellaria AI features.
 *
 * Environment variables:
 *   MIMOK_API_URL  — base URL (default: http://localhost:20128/v1)
 *   MIMOK_API_KEY  — bearer token (optional)
 *   MIMOK_MODEL    — model ID (default: xmtp/mimo-v2.5-pro)
 */

const API_URL = process.env.MIMOK_API_URL || 'http://localhost:20128/v1';
const API_KEY = process.env.MIMOK_API_KEY || '';
const MODEL = process.env.MIMOK_MODEL || 'xmtp/mimo-v2.5-pro';

export const POST: RequestHandler = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }

  // Inject model if not provided
  if (!body.model) body.model = MODEL;

  const wantsStream = body.stream === true;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }

  // Sanitize messages — ensure role/content are valid
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.filter((m: any) => {
      if (!m || typeof m !== 'object') return false;
      if (!['system', 'user', 'assistant', 'function', 'tool'].includes(m.role)) return false;
      // function/tool messages need content
      if (['function', 'tool'].includes(m.role) && !m.content && !m.tool_call_id) return false;
      return true;
    });
  }

  // Clean up tool_calls — ensure arguments are valid JSON strings
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        msg.tool_calls = msg.tool_calls.map((tc: any) => {
          if (tc.function?.arguments && typeof tc.function.arguments === 'object') {
            tc.function.arguments = JSON.stringify(tc.function.arguments);
          }
          return tc;
        });
      }
    }
  }

  // Ensure tools have the correct format for OpenAI-compatible API
  if (body.tools && Array.isArray(body.tools)) {
    body.tools = body.tools.map((t: any) => {
      // If already in correct format, pass through
      if (t.type === 'function' && t.function) return t;
      // Otherwise wrap
      return { type: 'function', function: t };
    });
  }

  // Set tool_choice to auto if tools are provided but no tool_choice is set
  if (body.tools?.length > 0 && !body.tool_choice) {
    body.tool_choice = 'auto';
  }

  try {
    const res = await fetch(`${API_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`Mimo API ${res.status}: ${txt.slice(0, 500)}`);
      throw error(res.status, `Mimo API error: ${res.statusText} — ${txt.slice(0, 500)}`);
    }

    if (wantsStream && res.body) {
      // Pass through SSE stream directly
      return new Response(res.body, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        }
      });
    }

    const data = await res.json();
    return json(data);
  } catch (err: any) {
    if (err.status) throw err; // re-throw SvelteKit errors
    console.error('Mimo API connection failed:', err.message);
    throw error(502, `Failed to reach Mimo API at ${API_URL}: ${err.message}`);
  }
};
