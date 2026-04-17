export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

export function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function errResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ success: false, error: message }, null, 2),
      },
    ],
    isError: true,
  };
}
