import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";
import { getPropertyName, unwrapExpression } from "../utils.ts";

const MESSAGE =
  "Create runs with SwarmExecutionPolicy.runFromPrepared(fields, prepared). Derive the branded execution through prepareWork; raw run.created payloads omit the authority boundary.";

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require prepared execution for new orchestration runs." },
  },
  create(context) {
    if (
      /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:Fixture|\.integration)\.ts$|[\\/]testkit[\\/]/u.test(
        context.filename,
      )
    )
      return {};
    const definition = (identifier: ESTree.IdentifierReference) => {
      let scope = context.sourceCode.getScope(identifier);
      while (true) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) return variable.defs[0];
        if (scope.upper === null) return undefined;
        scope = scope.upper;
      }
    };
    const isPolicyImport = (identifier: ESTree.IdentifierReference, namespace: boolean) => {
      const def = definition(identifier);
      return (
        def?.type === "ImportBinding" &&
        def.parent?.type === "ImportDeclaration" &&
        /(?:^|\/)SwarmExecutionPolicy\.ts$/u.test(def.parent.source.value) &&
        (namespace
          ? def.node.type === "ImportNamespaceSpecifier"
          : def.node.type === "ImportSpecifier" &&
            Option.getOrUndefined(getPropertyName(def.node.imported)) === "runFromPrepared")
      );
    };
    const constructed = (value: ESTree.Node, visited = new Set<ESTree.Node>()): boolean => {
      if (visited.has(value)) return false;
      visited.add(value);
      const expression = Option.getOrUndefined(unwrapExpression(value));
      if (expression?.type === "Identifier") {
        const def = definition(expression);
        return (
          def?.type === "Variable" && def.node.init !== null && constructed(def.node.init, visited)
        );
      }
      if (expression?.type !== "CallExpression") return false;
      const callee = expression.callee;
      return callee.type === "Identifier"
        ? isPolicyImport(callee, false)
        : callee.type === "MemberExpression" &&
            callee.object.type === "Identifier" &&
            Option.getOrUndefined(getPropertyName(callee.property)) === "runFromPrepared" &&
            isPolicyImport(callee.object, true);
    };
    return {
      ObjectExpression(node) {
        const type = node.properties.find(
          (property) =>
            property.type === "Property" &&
            Option.getOrUndefined(getPropertyName(property.key)) === "type",
        );
        if (
          type?.type !== "Property" ||
          type.value.type !== "Literal" ||
          type.value.value !== "run.created"
        )
          return;
        const payload = node.properties.find(
          (property) =>
            property.type === "Property" &&
            Option.getOrUndefined(getPropertyName(property.key)) === "payload",
        );
        if (payload?.type !== "Property" || !constructed(payload.value))
          context.report({ node, message: MESSAGE });
      },
    };
  },
});
