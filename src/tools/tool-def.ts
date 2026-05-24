export interface ToolDefinition {
  description: string;
  parameters: unknown;
  execute: (args: any) => Promise<any> | any;
}

export function defineTool(definition: ToolDefinition): ToolDefinition {
  return definition;
}
