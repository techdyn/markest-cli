/**
 * @module cli/core/agent-client
 * @description The site's agent tools - its MCP server at `/mcp` - called as
 *              any of the tool's requests is: JSON-RPC 2.0, one `tools/call` a
 *              request, the key as its credential, over the same client, so the
 *              same waiting, the same refusal of a redirect and the same
 *              redaction apply. They reach only what the account's plan gives
 *              agents, which is the site's to say, and its refusal is passed on
 *              as it is. A tool's answer is its structured content when it has
 *              one, else its text; a tool that refuses says why, and that is the
 *              error. Only a tool that only reads is tried again after a lost
 *              connection.
 *
 * @input A client from cli/core/api-client
 * @output `{ call(name, args, { reads }), tools() }`; AgentError
 * @dependencies cli/core/api-client
 */

import { ApiError } from './api-client.mjs';

/** The protocol revision the site speaks (McpController::SUPPORTED_PROTOCOL_VERSIONS). */
export const PROTOCOL_VERSION = '2025-06-18';

/** At most this many pages of tools are read, against a site that never stops paging. */
const MAX_PAGES = 20;

export class AgentError extends Error {
    constructor(message, { status = 0, code = null, tool = null } = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.tool = tool;
    }
}

/** A tool's text, as JSON where it is JSON. */
function fromText(text) {
    try {
        return JSON.parse(text);
    } catch {
        return { text };
    }
}

export function createAgent(client) {
    let serial = 0;

    async function rpc(method, params, idempotent) {
        let answer;
        try {
            answer = await client.request('POST', '/mcp', {
                json: { jsonrpc: '2.0', id: ++serial, method, params },
                accept: 'application/json, text/event-stream',
                headers: { 'MCP-Protocol-Version': PROTOCOL_VERSION },
                idempotent,
            });
        } catch (error) {
            if (error instanceof ApiError) throw new AgentError(error.message, { status: error.status, code: error.body?.error?.code ?? null });
            throw error;
        }
        const body = answer.body;
        if (body && body.error) {
            throw new AgentError(typeof body.error.message === 'string' ? body.error.message : 'The site refused the request.', { status: answer.status, code: body.error.code ?? null });
        }
        if (!body || typeof body.result !== 'object' || body.result === null) throw new AgentError('The site gave no answer the tool can read.', { status: answer.status });
        return body.result;
    }

    return {
        /** Run one tool. */
        async call(name, args = {}, { reads = false } = {}) {
            const result = await rpc('tools/call', { name, arguments: args }, reads);
            // Stryker disable next-line ArrayDeclaration: equivalent - a part that is no text part is dropped by the filter either way
            const text = (Array.isArray(result.content) ? result.content : []).filter((part) => part && part.type === 'text').map((part) => part.text).join('\n');
            if (result.isError) throw new AgentError(text || 'The tool ' + name + ' refused.', { tool: name });
            return result.structuredContent ?? fromText(text);
        },

        /** Every tool this key may use, as the site lists them. */
        async tools() {
            const tools = [];
            let cursor;
            for (let page = 0; page < MAX_PAGES; page++) {
                // Stryker disable next-line ConditionalExpression: equivalent - JSON leaves out a cursor that is undefined, so the first request is the same
                const result = await rpc('tools/list', cursor === undefined ? {} : { cursor }, true);
                tools.push(...(Array.isArray(result.tools) ? result.tools : []));
                if (typeof result.nextCursor !== 'string' || result.nextCursor === '') return tools;
                cursor = result.nextCursor;
            }
            return tools;
        },
    };
}
