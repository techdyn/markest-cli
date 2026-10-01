/**
 * @module cli/tests/support/fake-agent
 * @description A stand-in for the site's agent tools at `/mcp`, inside the fake
 *              site: JSON-RPC 2.0, `tools/list` paged as the site may page it
 *              and `tools/call` answered by the handler a test gives for each
 *              tool - its structured content, or a refusal as the tool's error -
 *              and a whole plan without agent access refused as the site refuses
 *              one. Every call is recorded with its arguments.
 *
 * @input `{ tools: { name: (args) => result | { refuse: text } }, agentAccess }`
 * @output `answerAgent(req, res, body, send)`; the calls made
 * @dependencies None
 */

export function fakeAgent({ tools = {}, agentAccess = true, pageSize = 0 } = {}) {
    const calls = [];

    function answerAgent(req, res, body, send) {
        if (req.headers['mcp-protocol-version'] !== '2025-06-18') return send(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Unsupported protocol version.' } });
        if (!String(req.headers.accept ?? '').includes('text/event-stream')) return send(406, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Accept both JSON and an event stream.' } });
        if (!agentAccess) return send(403, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32001, message: 'Agent access is not included in your plan.' } });
        const id = body?.id ?? null;
        if (body?.method === 'tools/list') {
            const names = Object.keys(tools);
            const start = Number(body.params?.cursor ?? 0);
            const page = pageSize > 0 ? names.slice(start, start + pageSize) : names;
            const next = pageSize > 0 && start + pageSize < names.length ? String(start + pageSize) : undefined;
            return send(200, {
                jsonrpc: '2.0', id,
                result: { tools: page.map((name) => ({ name, title: name, description: 'Does ' + name + '. More words.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: name.startsWith('markest_list') || name === 'search' } })), ...(next ? { nextCursor: next } : {}) },
            });
        }
        if (body?.method !== 'tools/call') return send(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'No method ' + body?.method } });
        const { name, arguments: args } = body.params ?? {};
        calls.push({ name, args });
        const handler = tools[name];
        if (!handler) return send(200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: ' + name } });
        const result = handler(args ?? {});
        if (result && typeof result.refuse === 'string') return send(200, { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: result.refuse }] } });
        if (result && result.textOnly !== undefined) return send(200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.textOnly }] } });
        return send(200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } });
    }

    return { answerAgent, calls };
}
