import { defineRule, type ESTree } from "@oxlint/plugins";

// Roots whose open popup inserts Base UI focus guards right after the trigger. Select and
// Combobox are safe: their hidden input always renders after the trigger, so it stays last.
const POPUP_MODULE = /(?:^|\/)ui\/(?:menu|popover)$/u;
const POPUP_ROOTS = new Set(["Menu", "Popover"]);
// Utilities that style every child except the last one.
const LAST_CHILD_UTILITY = /^-?space-[xy]-(?!0$)|^divide-[xy](?:$|-(?!0$|reverse$))/u;

type JsxChild = ESTree.JSXElement["children"][number];

const isNode = (value: unknown): value is ESTree.Node =>
  typeof value === "object" && value !== null && "type" in value;

function walk(node: unknown, visit: (node: ESTree.Node) => void) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key !== "parent") walk(value, visit);
  }
}

const elementName = (node: ESTree.Node) =>
  node.type === "JSXElement" && node.openingElement.name.type === "JSXIdentifier"
    ? node.openingElement.name.name
    : undefined;

/** Splits a class token into its variants and utility, ignoring colons inside brackets. */
function parseClass(token: string) {
  const variants: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    const character = token[index];
    if (character === "[" || character === "(") depth++;
    else if (character === "]" || character === ")") depth--;
    else if (character === ":" && depth === 0) {
      variants.push(token.slice(start, index));
      start = index + 1;
    }
  }
  return { variants, utility: token.slice(start).replace(/^!|!$/gu, "") };
}

// `*:`, `**:`, and arbitrary variants like `[&_ul]:` or `[&>li]:` style other elements.
const targetsOtherElements = (variant: string) =>
  variant === "*" || variant === "**" || /^\[.*&.*[\s_>+~]/u.test(variant);

const isLastChildUtility = (token: string) => {
  const { variants, utility } = parseClass(token);
  return LAST_CHILD_UTILITY.test(utility) && !variants.some(targetsOtherElements);
};

/** The first last-child utility anywhere in the element's className. */
function lastChildUtility(element: ESTree.JSXElement) {
  for (const attribute of element.openingElement.attributes) {
    if (attribute.type !== "JSXAttribute" || attribute.name.name !== "className") continue;
    const strings: string[] = [];
    walk(attribute.value, (node) => {
      if (node.type === "Literal" && typeof node.value === "string") strings.push(node.value);
      if (node.type === "TemplateElement") strings.push(node.value.cooked ?? node.value.raw);
    });
    return strings.join(" ").split(/\s+/u).find(isLastChildUtility);
  }
  return undefined;
}

/** JSX an expression can render: both branches of a ternary, the right of `&&`, a map callback's result. */
function renderedBy(expression: ESTree.Node | null | undefined): ESTree.Node[] {
  if (!expression) return [];
  switch (expression.type) {
    case "ParenthesizedExpression":
      return renderedBy(expression.expression);
    case "JSXElement":
      return [expression];
    case "JSXFragment":
      return possiblyLast(expression.children);
    case "ConditionalExpression":
      return [...renderedBy(expression.consequent), ...renderedBy(expression.alternate)];
    case "LogicalExpression":
      return renderedBy(expression.right);
    case "CallExpression": {
      const callback = expression.arguments[0];
      if (callback?.type !== "ArrowFunctionExpression" && callback?.type !== "FunctionExpression")
        return [];
      return callback.body ? returnedBy(callback.body) : [];
    }
    default:
      return [expression];
  }
}

/** JSX a function body returns, ignoring nested functions. */
function returnedBy(body: ESTree.Node): ESTree.Node[] {
  if (body.type !== "BlockStatement") return renderedBy(body);
  const found: ESTree.Node[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isNode(node)) return;
    if (node.type === "ReturnStatement") return found.push(...renderedBy(node.argument));
    if (/Function/u.test(node.type)) return;
    for (const [key, value] of Object.entries(node)) if (key !== "parent") visit(value);
  };
  visit(body.body);
  return found;
}

const rendersNothing = (branch: ESTree.Node) =>
  (branch.type === "Literal" && (branch.value === null || branch.value === false)) ||
  (branch.type === "Identifier" && branch.name === "undefined");

/** Whether a child can render nothing, letting an earlier sibling end up last. */
function mayRenderNothing(child: JsxChild) {
  if (child.type !== "JSXExpressionContainer") return false;
  const { expression } = child;
  if (expression.type === "LogicalExpression" || expression.type === "CallExpression") return true;
  return (
    expression.type === "ConditionalExpression" &&
    [expression.consequent, expression.alternate].some(rendersNothing)
  );
}

/** Nodes that can end up as the last rendered child. */
function possiblyLast(children: ReadonlyArray<JsxChild>): ESTree.Node[] {
  const meaningful = children.filter(
    (child) =>
      !(child.type === "JSXText" && child.value.trim() === "") &&
      !(child.type === "JSXExpressionContainer" && child.expression.type === "JSXEmptyExpression"),
  );
  const found: ESTree.Node[] = [];
  for (let index = meaningful.length - 1; index >= 0; index--) {
    const child = meaningful[index]!;
    found.push(...renderedBy(child.type === "JSXExpressionContainer" ? child.expression : child));
    if (!mayRenderNothing(child)) break;
  }
  return found;
}

const isChildrenSlot = (node: ESTree.Node) =>
  (node.type === "Identifier" && node.name === "children") ||
  (node.type === "MemberExpression" &&
    node.property.type === "Identifier" &&
    node.property.name === "children");

/** Components declared in this file, by name, with the function each one renders from. */
function localComponents(program: ESTree.Program) {
  const components = new Map<string, ESTree.Node>();
  walk(program, (node) => {
    if (node.type === "FunctionDeclaration" && node.id && /^[A-Z]/u.test(node.id.name)) {
      components.set(node.id.name, node);
    }
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      // Unwrap memo(...) and forwardRef(...).
      let init: ESTree.Node | null = node.init;
      while (init?.type === "CallExpression" && init.arguments[0]) init = init.arguments[0];
      if (
        /^[A-Z]/u.test(node.id.name) &&
        (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression")
      ) {
        components.set(node.id.name, init);
      }
    }
  });
  return components;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a popup root as the last child of a space-*/divide-* container; its focus guards shift the layout while it is open.",
    },
  },
  create(context) {
    return {
      Program(program) {
        const popups = new Set<string>();
        for (const statement of program.body) {
          if (statement.type !== "ImportDeclaration") continue;
          if (!POPUP_MODULE.test(statement.source.value)) continue;
          for (const specifier of statement.specifiers) {
            if (
              specifier.type === "ImportSpecifier" &&
              specifier.imported.type === "Identifier" &&
              POPUP_ROOTS.has(specifier.imported.name)
            ) {
              popups.add(specifier.local.name);
            }
          }
        }
        if (popups.size === 0) return;

        // Local components that render a popup root, or that place children last in a spaced container.
        const components = localComponents(program);
        const spacedSlots = new Map<string, string>();
        for (const [name, fn] of components) {
          walk(fn, (node) => {
            if (node.type !== "JSXElement" || spacedSlots.has(name)) return;
            const utility = lastChildUtility(node);
            if (utility && possiblyLast(node.children).some(isChildrenSlot)) {
              spacedSlots.set(name, utility);
            }
          });
        }
        let grew = true;
        while (grew) {
          grew = false;
          for (const [name, fn] of components) {
            if (popups.has(name) || !("body" in fn) || !isNode(fn.body)) continue;
            const roots = returnedBy(fn.body);
            if (roots.some((root) => popups.has(elementName(root) ?? ""))) {
              popups.add(name);
              grew = true;
            }
          }
        }

        walk(program, (node) => {
          if (node.type !== "JSXElement") return;
          const name = elementName(node);
          const utility = (name && spacedSlots.get(name)) ?? lastChildUtility(node);
          if (!utility) return;
          for (const child of possiblyLast(node.children)) {
            const popup = elementName(child);
            if (!popup || !popups.has(popup)) continue;
            context.report({
              node: child,
              message: `<${popup}> can be the last child of a \`${utility}\` container. While its popup is open, Base UI inserts focus guards after the trigger, so \`${utility}\` starts spacing the trigger and the content below shifts. Use gap, or put the spacing on the siblings.`,
            });
          }
        });
      },
    };
  },
});
