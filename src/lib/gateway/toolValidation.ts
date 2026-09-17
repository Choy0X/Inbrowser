import type { ToolCallWire, ToolDef } from "./types";
import { GatewayError } from "./types";

export function argumentError(value: unknown, schema: Record<string, unknown>, path = "arguments", depth = 0): string | null {
  if (depth > 20) return `${path} is too deeply nested`;
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object`;
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === "string" && !Object.hasOwn(object, key)) return `${path}.${key} is required`;
    }
    for (const [key, item] of Object.entries(object)) {
      if (Object.hasOwn(properties, key)) {
        const error = argumentError(item, properties[key], `${path}.${key}`, depth + 1);
        if (error) return error;
      } else if (schema.additionalProperties === false) return `${path}.${key} is not allowed`;
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (schema.items && typeof schema.items === "object") {
      for (const item of value) {
        const error = argumentError(item, schema.items as Record<string, unknown>, `${path}[]`, depth + 1);
        if (error) return error;
      }
    }
  } else if (type === "integer" ? !Number.isInteger(value) : type === "null" ? value !== null :
    typeof type === "string" && ["string", "number", "boolean"].includes(type) && typeof value !== type) {
    return `${path} must be ${type}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return `${path} is not an allowed value`;
  return null;
}

/** Validate the complete batch before any call is emitted or executed. */
export function validateToolCalls(calls: ToolCallWire[], tools: ToolDef[] = [], choice?: string): void {
  const fail = (reason: string): never => { throw new GatewayError(502, `Invalid model tool call: ${reason}`, false, undefined, "invalid_tool_call"); };
  if (calls.length > 32) fail("too many calls in one response");
  const ids = new Set<string>();
  for (const call of calls) {
    if (!call.id || ids.has(call.id)) fail("missing or duplicate call ID");
    ids.add(call.id);
    const definition = tools.find(t => t.function.name === call.function?.name);
    if (choice === "none" || !definition) fail("the tool was not offered for this turn");
    if (typeof call.function.arguments !== "string" || call.function.arguments.length > 131072) fail("invalid argument payload size");
    let args: unknown;
    try { args = JSON.parse(call.function.arguments); } catch { fail("arguments are not valid JSON"); }
    if (!args || typeof args !== "object" || Array.isArray(args)) fail("arguments must be a JSON object");
    const error = argumentError(args, definition!.function.parameters);
    if (error) fail(error);
  }
}
