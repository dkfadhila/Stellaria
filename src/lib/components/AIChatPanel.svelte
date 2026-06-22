<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { buildSystemPrompt, STELLARIA_TOOLS } from '$lib/ai/systemPrompt';
  import type { SkyContext } from '$lib/ai/systemPrompt';

  export let skyContext: SkyContext;
  export let anomalyData: any[] = [];

  const dispatch = createEventDispatcher();

  interface Message {
    role: 'user' | 'assistant' | 'system' | 'function';
    content: string;
    name?: string;
    tool_calls?: any[];
    tool_call_id?: string;
    timestamp: number;
  }

  let messages: Message[] = [];
  let input = '';
  let loading = false;
  let collapsed = false;
  let chatEl: HTMLDivElement;

  // Quick prompts
  const QUICK_PROMPTS = [
    '🔍 What anomalies are detected?',
    '🌌 Show me tonight\'s sky',
    '🔭 Where is the nearest black hole?',
    '⭐ What\'s the brightest star visible?',
    '🌀 Explain gravitational lensing'
  ];

  function scrollToBottom() {
    if (chatEl) {
      setTimeout(() => chatEl.scrollTop = chatEl.scrollHeight, 50);
    }
  }

  async function send(text?: string) {
    const msg = (text || input).trim();
    if (!msg || loading) return;
    input = '';

    // Add user message
    messages = [...messages, { role: 'user', content: msg, timestamp: Date.now() }];
    scrollToBottom();
    loading = true;

    try {
      // Build conversation for API
      const systemPrompt = buildSystemPrompt(skyContext);
      const apiMessages = [
        { role: 'system', content: systemPrompt },
        ...messages.filter(m => m.role !== 'system').map(m => {
          if (m.role === 'function') {
            return { role: 'function', name: m.name, content: m.content, tool_call_id: m.tool_call_id };
          }
          const base: any = { role: m.role, content: m.content };
          if (m.tool_calls) base.tool_calls = m.tool_calls;
          return base;
        })
      ];

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          tools: STELLARIA_TOOLS,
          stream: true
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        messages = [...messages, {
          role: 'assistant',
          content: `Error: ${res.status} — ${errText.slice(0, 200)}`,
          timestamp: Date.now()
        }];
        return;
      }

      // Handle SSE stream
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';
      let toolCalls: any[] = [];
      let buffer = '';

      if (!reader) throw new Error('No response body');

      // Add empty assistant message we'll update
      messages = [...messages, { role: 'assistant', content: '', timestamp: Date.now() }];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              assistantContent += delta.content;
              // Update the last message
              messages[messages.length - 1] = {
                ...messages[messages.length - 1],
                content: assistantContent
              };
              messages = messages; // trigger reactivity
              scrollToBottom();
            }

            // Handle tool calls in streaming
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCalls[idx]) {
                  toolCalls[idx] = { id: tc.id || '', function: { name: tc.function?.name || '', arguments: '' } };
                }
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          } catch {}
        }
      }

      // Process any tool calls
      if (toolCalls.length > 0) {
        // Update assistant message with tool calls
        messages[messages.length - 1] = {
          ...messages[messages.length - 1],
          tool_calls: toolCalls,
          content: assistantContent || '(calling tools...)'
        };
        messages = messages;

        // Execute each tool call
        for (const tc of toolCalls) {
          const result = await executeToolCall(tc.function.name, tc.function.arguments);
          messages = [...messages, {
            role: 'function',
            name: tc.function.name,
            content: JSON.stringify(result),
            tool_call_id: tc.id,
            timestamp: Date.now()
          }];
          scrollToBottom();
        }

        // Send follow-up request with function results
        await sendFollowUp();
      }
    } catch (err: any) {
      messages = [...messages, {
        role: 'assistant',
        content: `Connection error: ${err.message}`,
        timestamp: Date.now()
      }];
    } finally {
      loading = false;
      scrollToBottom();
    }
  }

  async function sendFollowUp() {
    const systemPrompt = buildSystemPrompt(skyContext);
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.filter(m => m.role !== 'system').map(m => {
        if (m.role === 'function') {
          return { role: 'function', name: m.name, content: m.content, tool_call_id: m.tool_call_id };
        }
        const base: any = { role: m.role, content: m.content };
        if (m.tool_calls) base.tool_calls = m.tool_calls;
        return base;
      })
    ];

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: apiMessages, tools: STELLARIA_TOOLS, stream: true })
    });

    if (!res.ok) return;

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let content = '';
    let buffer = '';
    let toolCalls: any[] = [];

    messages = [...messages, { role: 'assistant', content: '', timestamp: Date.now() }];

    if (!reader) return;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) {
            content += delta.content;
            messages[messages.length - 1] = { ...messages[messages.length - 1], content };
            messages = messages;
            scrollToBottom();
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || '', function: { name: tc.function?.name || '', arguments: '' } };
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
        } catch {}
      }
    }

    // If there are more tool calls, recurse
    if (toolCalls.length > 0) {
      messages[messages.length - 1] = { ...messages[messages.length - 1], tool_calls: toolCalls, content: content || '(calling tools...)' };
      messages = messages;
      for (const tc of toolCalls) {
        const result = await executeToolCall(tc.function.name, tc.function.arguments);
        messages = [...messages, { role: 'function', name: tc.function.name, content: JSON.stringify(result), tool_call_id: tc.id, timestamp: Date.now() }];
        scrollToBottom();
      }
      // One more follow-up (limit recursion to 3 levels)
      await sendFollowUp();
    }
  }

  async function executeToolCall(name: string, argsJson: string): Promise<any> {
    let args: any = {};
    try { args = JSON.parse(argsJson); } catch {}

    switch (name) {
      case 'lookAtRaDec':
        dispatch('lookAt', { ra: args.ra, dec: args.dec, name: args.name });
        return { success: true, message: `Camera pointed at RA ${args.ra}°, Dec ${args.dec}°${args.name ? ` (${args.name})` : ''}` };

      case 'searchObject':
        dispatch('search', { query: args.query });
        return { success: true, message: `Searching for "${args.query}"...` };

      case 'toggleLayer':
        dispatch('toggleLayer', { layer: args.layer });
        return { success: true, message: `Toggled layer: ${args.layer}` };

      case 'getAnomalies': {
        // Return cached anomaly data
        const summary = anomalyData.slice(0, 10).map(a => ({
          id: a.id,
          name: a.name,
          type: a.objectType,
          confidence: a.confidence,
          ra: a.ra,
          dec: a.dec,
          mass: a.estimatedMass,
          method: a.method
        }));
        return { total: anomalyData.length, candidates: summary };
      }

      case 'explainAnomaly': {
        const anomaly = anomalyData.find(a => a.id === args.id);
        if (!anomaly) return { error: `Anomaly "${args.id}" not found` };
        dispatch('lookAt', { ra: anomaly.ra, dec: anomaly.dec, name: anomaly.name });
        return anomaly;
      }

      case 'getTonightSky':
        return { message: 'Generating tonight\'s sky report...', context: skyContext };

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="ai-chat" class:collapsed>
  <button class="ai-toggle" on:click={() => collapsed = !collapsed} title="Stellaria AI Guide">
    <span class="ai-icon">✦</span>
    {#if !collapsed}
      <span class="ai-title">STELLARIA AI</span>
    {/if}
    {#if collapsed && messages.length > 0}
      <span class="ai-badge">{messages.filter(m => m.role === 'assistant' && m.content).length}</span>
    {/if}
  </button>

  {#if !collapsed}
    <div class="ai-body">
      <div class="ai-messages" bind:this={chatEl}>
        {#if messages.length === 0}
          <div class="ai-welcome">
            <div class="ai-welcome-icon">✦</div>
            <p>Welcome to <strong>Stellaria AI</strong></p>
            <p class="ai-welcome-sub">Your intelligent astronomy guide. Ask about stars, constellations, exoplanets, or gravitational anomalies.</p>
            <div class="ai-quick-prompts">
              {#each QUICK_PROMPTS as prompt}
                <button class="ai-quick-btn" on:click={() => send(prompt)}>{prompt}</button>
              {/each}
            </div>
          </div>
        {/if}

        {#each messages as msg}
          {#if msg.role === 'user'}
            <div class="msg msg-user">
              <div class="msg-content">{msg.content}</div>
            </div>
          {:else if msg.role === 'assistant'}
            <div class="msg msg-assistant">
              <div class="msg-label">✦ Stellaria AI</div>
              <div class="msg-content">{@html formatMarkdown(msg.content)}</div>
              {#if msg.tool_calls}
                <div class="msg-tools">
                  {#each msg.tool_calls as tc}
                    <div class="tool-call">
                      <span class="tool-icon">⚙</span>
                      <span class="tool-name">{tc.function.name}</span>
                      <span class="tool-args">{tc.function.arguments.slice(0, 60)}{tc.function.arguments.length > 60 ? '...' : ''}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {:else if msg.role === 'function'}
            <div class="msg msg-function">
              <div class="msg-label">⚙ {msg.name}</div>
              <div class="msg-content">{@html formatFunctionResult(msg.content)}</div>
            </div>
          {/if}
        {/each}

        {#if loading}
          <div class="msg msg-assistant msg-loading">
            <div class="msg-label">✦ Stellaria AI</div>
            <div class="msg-content">
              <span class="typing-dot"></span>
              <span class="typing-dot"></span>
              <span class="typing-dot"></span>
            </div>
          </div>
        {/if}
      </div>

      <div class="ai-input-wrap">
        <textarea
          bind:value={input}
          on:keydown={handleKeydown}
          placeholder="Ask about stars, anomalies, constellations..."
          rows="1"
          disabled={loading}
        ></textarea>
        <button class="ai-send" on:click={() => send()} disabled={loading || !input.trim()}>
          {loading ? '...' : '→'}
        </button>
      </div>
    </div>
  {/if}
</div>

<script context="module" lang="ts">
  function formatMarkdown(text: string): string {
    if (!text) return '';
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>')
      .replace(/^- (.*)/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
  }

  function formatFunctionResult(json: string): string {
    try {
      const data = JSON.parse(json);
      if (data.candidates) {
        return `<div class="fn-summary">${data.total} anomalies found. Showing top ${data.candidates.length}:</div>` +
          data.candidates.map((c: any) => `
            <div class="fn-anomaly">
              <strong>${c.name}</strong>
              <span class="fn-conf">${(c.confidence * 100).toFixed(0)}%</span>
              <span class="fn-type">${c.type.replace(/_/g, ' ')}</span>
            </div>
          `).join('');
      }
      if (data.success) return `<div class="fn-success">✓ ${data.message}</div>`;
      if (data.error) return `<div class="fn-error">✗ ${data.error}</div>`;
      // Generic JSON display
      return `<pre class="fn-json">${JSON.stringify(data, null, 2).slice(0, 500)}</pre>`;
    } catch {
      return `<div class="fn-raw">${json.slice(0, 300)}</div>`;
    }
  }
</script>

<style>
  .ai-chat {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 100;
    width: 520px;
    max-width: calc(100vw - 32px);
    font-family: var(--sans);
    transition: all 0.3s ease;
  }
  .ai-chat.collapsed {
    width: auto;
    bottom: 16px;
    left: 50%;
  }

  .ai-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: linear-gradient(135deg, rgba(138, 180, 255, 0.15), rgba(100, 140, 255, 0.08));
    border: 1px solid rgba(138, 180, 255, 0.3);
    border-radius: 12px 12px 0 0;
    color: var(--accent);
    cursor: pointer;
    width: 100%;
    text-align: left;
    backdrop-filter: blur(12px);
    transition: all 0.2s;
  }
  .collapsed .ai-toggle {
    border-radius: 24px;
    width: auto;
    justify-content: center;
  }
  .ai-toggle:hover {
    background: linear-gradient(135deg, rgba(138, 180, 255, 0.25), rgba(100, 140, 255, 0.15));
    border-color: rgba(138, 180, 255, 0.5);
  }
  .ai-icon {
    font-size: 18px;
    animation: pulse-glow 2s infinite;
  }
  @keyframes pulse-glow {
    0%, 100% { opacity: 0.7; }
    50% { opacity: 1; }
  }
  .ai-title {
    font-size: 11px;
    letter-spacing: 3px;
    font-family: var(--mono);
    font-weight: 500;
  }
  .ai-badge {
    background: var(--accent);
    color: var(--bg);
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 10px;
    font-weight: 700;
  }

  .ai-body {
    background: var(--panel);
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 12px 12px;
    backdrop-filter: blur(12px);
    overflow: hidden;
  }

  .ai-messages {
    height: 380px;
    overflow-y: auto;
    padding: 12px;
    scroll-behavior: smooth;
  }
  .ai-messages::-webkit-scrollbar {
    width: 4px;
  }
  .ai-messages::-webkit-scrollbar-thumb {
    background: rgba(138, 180, 255, 0.2);
    border-radius: 2px;
  }

  .ai-welcome {
    text-align: center;
    padding: 40px 20px;
    color: var(--fg);
  }
  .ai-welcome-icon {
    font-size: 36px;
    color: var(--accent);
    margin-bottom: 12px;
  }
  .ai-welcome p { margin: 4px 0; }
  .ai-welcome-sub {
    color: var(--muted);
    font-size: 12px;
    margin-bottom: 16px !important;
  }
  .ai-quick-prompts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: center;
    margin-top: 12px;
  }
  .ai-quick-btn {
    padding: 6px 12px;
    font-size: 11px;
    background: rgba(138, 180, 255, 0.08);
    border: 1px solid var(--border);
    border-radius: 16px;
    color: var(--fg);
    cursor: pointer;
    transition: all 0.2s;
  }
  .ai-quick-btn:hover {
    background: rgba(138, 180, 255, 0.18);
    border-color: var(--accent);
    color: var(--accent);
  }

  .msg {
    margin-bottom: 10px;
    max-width: 95%;
  }
  .msg-user {
    margin-left: auto;
    text-align: right;
  }
  .msg-user .msg-content {
    background: rgba(138, 180, 255, 0.15);
    border: 1px solid rgba(138, 180, 255, 0.25);
    border-radius: 12px 12px 2px 12px;
    padding: 8px 12px;
    color: var(--fg);
    font-size: 13px;
    display: inline-block;
    text-align: left;
  }
  .msg-assistant {
    margin-right: auto;
  }
  .msg-label {
    font-size: 10px;
    color: var(--muted);
    margin-bottom: 3px;
    letter-spacing: 1px;
  }
  .msg-assistant .msg-content {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--border);
    border-radius: 2px 12px 12px 12px;
    padding: 8px 12px;
    color: var(--fg);
    font-size: 13px;
    line-height: 1.5;
  }
  .msg-function {
    margin-left: 12px;
    border-left: 2px solid rgba(138, 180, 255, 0.2);
    padding-left: 10px;
  }
  .msg-function .msg-content {
    font-size: 12px;
    color: var(--muted);
  }

  .msg-tools {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tool-call {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--muted);
    padding: 3px 8px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 4px;
  }
  .tool-icon { font-size: 12px; }
  .tool-name { color: var(--accent); font-weight: 500; }
  .tool-args { color: var(--muted); font-family: var(--mono); font-size: 10px; }

  .msg-loading .msg-content {
    display: flex;
    gap: 4px;
    padding: 12px;
  }
  .typing-dot {
    width: 6px;
    height: 6px;
    background: var(--accent);
    border-radius: 50%;
    animation: typing 1.4s infinite;
  }
  .typing-dot:nth-child(2) { animation-delay: 0.2s; }
  .typing-dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes typing {
    0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-4px); }
  }

  /* Function result styles */
  :global(.fn-summary) { color: var(--accent); font-weight: 500; margin-bottom: 6px; }
  :global(.fn-anomaly) {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 11px;
  }
  :global(.fn-anomaly strong) { color: var(--fg); }
  :global(.fn-conf) {
    background: rgba(255, 180, 50, 0.15); color: #f4b732;
    padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 600;
  }
  :global(.fn-type) { color: var(--muted); font-size: 10px; }
  :global(.fn-success) { color: #4caf50; }
  :global(.fn-error) { color: #ff6b6b; }
  :global(.fn-json) {
    background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px;
    font-size: 10px; overflow-x: auto; white-space: pre; color: var(--muted);
  }

  .ai-input-wrap {
    display: flex;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid var(--border);
    background: rgba(0, 0, 0, 0.2);
  }
  .ai-input-wrap textarea {
    flex: 1;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--fg);
    padding: 8px 10px;
    font-size: 13px;
    font-family: var(--sans);
    resize: none;
    min-height: 36px;
    max-height: 80px;
    outline: none;
    transition: border-color 0.2s;
  }
  .ai-input-wrap textarea:focus {
    border-color: var(--accent);
  }
  .ai-input-wrap textarea::placeholder {
    color: var(--muted);
    opacity: 0.6;
  }
  .ai-send {
    padding: 8px 14px;
    background: rgba(138, 180, 255, 0.15);
    border: 1px solid rgba(138, 180, 255, 0.3);
    border-radius: 8px;
    color: var(--accent);
    font-size: 16px;
    cursor: pointer;
    transition: all 0.2s;
    align-self: flex-end;
  }
  .ai-send:hover:not(:disabled) {
    background: rgba(138, 180, 255, 0.25);
    border-color: var(--accent);
  }
  .ai-send:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  @media (max-width: 640px) {
    .ai-chat {
      width: calc(100vw - 16px);
      bottom: 8px;
    }
    .ai-messages { height: 300px; }
  }
</style>
