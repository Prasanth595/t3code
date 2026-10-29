const selectionFieldByTool: Readonly<Record<string, string>> = {
  t3_project_create: "defaultModelSelection",
  t3_project_update: "defaultModelSelection",
  t3_thread_launch: "modelSelection",
  t3_thread_configure: "modelSelection",
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ModelSelection accepts legacy untyped data, but Google requires typed function parameters.
export const modelSelectionToolSchema = (name: string, schema: Record<string, unknown>) => {
  const field = selectionFieldByTool[name];
  if (field === undefined || !object(schema.properties)) return schema;
  const selection = schema.properties[field];
  if (!object(selection)) return schema;
  const copy = structuredClone(schema);
  const properties = copy.properties;
  if (!object(properties)) return schema;
  const patch = (node: unknown): void => {
    if (!object(node)) return;
    if (object(node.properties) && "instanceId" in node.properties && "model" in node.properties) {
      node.properties.provider = { type: "string" };
      node.properties.instanceId = { type: "string" };
      node.properties.model = { type: "string" };
      node.properties.options = {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            value: { anyOf: [{ type: "string" }, { type: "boolean" }] },
          },
          required: ["id", "value"],
        },
      };
    }
    if (Array.isArray(node.anyOf)) node.anyOf.forEach(patch);
  };
  patch(properties[field]);
  return copy;
};
