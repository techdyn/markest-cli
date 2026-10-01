/**
 * @module cli/mcp/json-rpc
 * @description A Model Context Protocol server's answers, whatever carries
 *              them: `initialize` (the protocol revision the client asks for
 *              when it is one this server speaks, else the newest), `ping`,
 *              `tools/list` and `tools/call` - a tool's answer as structured
 *              content and as text, its refusal as a result marked an error, as
 *              the protocol asks - and a JSON-RPC error for anything else. A
 *              notification gets no answer. A tool that throws something it did
 *              not mean is said as an internal error, without its stack.
 *
 * @input `{ name, version, instructions, tools: [{ definition, run(args) }], isRefusal }`; one message
 * @output The answer to send, or null for none
 * @dependencies None
 */

/** The revisions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const failure = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const success = (id, result) => ({ jsonrpc: '2.0', id, result });

// Stryker disable next-line ArrowFunction: equivalent - a rule that says nothing takes no failure for a refusal, as false does
export function createRpc({ name, version, instructions, tools, isRefusal = () => false }) {
    const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));

    async function callTool(id, params) {
        const tool = byName.get(params?.name);
        if (!tool) return failure(id, INVALID_PARAMS, 'Unknown tool: ' + String(params?.name));
        const args = params.arguments ?? {};
        if (typeof args !== 'object' || Array.isArray(args)) return failure(id, INVALID_PARAMS, 'A tool\'s arguments are one object.');
        try {
            const result = await tool.run(args);
            return success(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
        } catch (error) {
            if (!isRefusal(error)) return failure(id, INTERNAL_ERROR, 'The tool failed unexpectedly: ' + (error && error.message ? error.message : String(error)));
            return success(id, { content: [{ type: 'text', text: error.message }], isError: true });
        }
    }

    /** The answer to one message, or null for a notification. */
    async function handle(message) {
        // Anything but an object with jsonrpc "2.0" - null, a number, a string, a list - has no such member
        if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            return failure(message?.id, INVALID_REQUEST, 'Not a JSON-RPC 2.0 request.');
        }
        const { id, method, params } = message;
        if (id === undefined) return null;
        switch (method) {
            case 'initialize': {
                const asked = params?.protocolVersion;
                return success(id, {
                    protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name, version },
                    instructions,
                });
            }
            case 'ping':
                return success(id, {});
            case 'tools/list':
                return success(id, { tools: tools.map((tool) => tool.definition) });
            case 'tools/call':
                return callTool(id, params);
            default:
                return failure(id, METHOD_NOT_FOUND, 'No method ' + method + '.');
        }
    }

    /** A line as it arrives: parsed and answered, or a parse error. */
    async function handleLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            return failure(null, PARSE_ERROR, 'Not JSON.');
        }
        return handle(message);
    }

    return { handle, handleLine };
}
