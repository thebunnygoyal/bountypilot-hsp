import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HttpMcpTransport, McpClient } from '../src/mcp/client.js';
import { MockHspMcpServer } from '../src/mcp/mockServer.js';

// The HTTP transport against a LOCAL SSE-speaking server: verifies our
// Streamable-HTTP request/response handling (JSON-RPC over SSE data: lines,
// session-id echo). This is NOT a live test against mcp-qa.hashkeymerchant.com.

test('HttpMcpTransport handles SSE responses and session ids', async () => {
  const server = new MockHspMcpServer();
  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rpc = JSON.parse(body);
      const result = server.handle(rpc.method, rpc.params);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'mcp-session-id': 'sess-test-1' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`);
    });
  });
  await new Promise((r) => httpServer.listen(0, r));
  const url = `http://127.0.0.1:${httpServer.address().port}/mcp`;
  try {
    const transport = new HttpMcpTransport(url);
    const mcp = new McpClient(transport);
    const tools = await mcp.connect();
    assert.ok(tools.includes('finalize_payment'));
    assert.equal(transport.sessionId, 'sess-test-1');
    const cfg = await mcp.callTool('get_chain_config', {});
    assert.equal(cfg.networks[0].network, 'hashkey-testnet');
  } finally {
    httpServer.close();
  }
});
