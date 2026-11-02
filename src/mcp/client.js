// MCP client for the official HSP Agentic Payment server (Streamable HTTP).
// Two transports: InProcessTransport (tests, wired to the mock server) and
// HttpMcpTransport (real endpoint; NOT verified live - hashkeymerchant.com
// hard-blocks this sandbox's egress IP at Cloudflare, and QA additionally
// requires HSP-side IP allowlisting).

export class McpToolError extends Error {
  constructor(toolName, error) {
    super(`MCP tool ${name0(toolName)} failed: ${error?.code ?? ''} ${error?.message ?? String(error)}`.trim());
    this.toolName = toolName;
    this.code = error?.code;
    this.toolError = error;
  }
}
const name0 = (n) => String(n);

export class InProcessTransport {
  constructor(server) { this.server = server; }
  async request(method, params) { return this.server.handle(method, params); }
}

export class HttpMcpTransport {
  constructor(url, { fetchImpl } = {}) {
    this.url = url;
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.sessionId = null;
    this.nextId = 1;
  }

  async request(method, params) {
    const id = this.nextId++;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const res = await this.fetch(this.url, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const sid = res.headers?.get?.('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const ctype = res.headers?.get?.('content-type') ?? '';
    const text = await res.text();
    const messages = ctype.includes('text/event-stream')
      ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5).trim()))
      : [JSON.parse(text)];
    const match = messages.find((m) => m.id === id);
    if (!match) throw new Error('MCP: no response with matching id');
    if (match.error) throw new Error(`MCP RPC error ${match.error.code}: ${match.error.message}`);
    return match.result;
  }
}

export class McpClient {
  static REQUIRED_TOOLS = ['get_chain_config', 'create_order', 'get_order', 'prepare_payment', 'finalize_payment', 'estimate_fee', 'submit_payment', 'query_payment'];

  constructor(transport) { this.transport = transport; this.tools = null; }

  async connect() {
    await this.transport.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bountypilot-hsp', version: '0.4.0' } });
    const list = await this.transport.request('tools/list', {});
    this.tools = (list.tools ?? []).map((t) => t.name);
    const missing = McpClient.REQUIRED_TOOLS.filter((t) => !this.tools.includes(t));
    if (missing.length) throw new Error(`MCP server missing required tools: ${missing.join(', ')} - stop per the HSP guide (in particular, never proceed without finalize_payment)`);
    return this.tools;
  }

  async callTool(name, args) {
    if (!this.tools) await this.connect();
    const result = await this.transport.request('tools/call', { name, arguments: args });
    if (result?.isError) {
      let err;
      try { err = JSON.parse(result.content?.[0]?.text ?? '{}'); } catch { err = { message: result.content?.[0]?.text }; }
      throw new McpToolError(name, err);
    }
    const text = result?.content?.[0]?.text;
    return text ? JSON.parse(text) : result;
  }
}
