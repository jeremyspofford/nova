// ESLint plugin `nova-i18n` (D9) with one rule, `no-literal-ui-text`: in folders converted to
// defineMessages, UI text must come from messages. It flags JSX text with letters, and literal
// strings (plain, template, or either branch of a condition) given to text props such as
// `aria-label`, `title`, `placeholder` or `label`, as JSX attributes or as object properties
// (menu items, tabs, options). Text made only of punctuation and symbols, `{expressions}`, and the
// product name are allowed; so is everything inside a defineMessages call. Node-only: loaded by
// eslint.config.js.
import type { Rule } from 'eslint';

/** Props and object keys whose string values are user-facing text. Keep sorted. */
export const TEXT_PROPS: readonly string[] = [
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'cancelLabel',
  'caption',
  'confirmLabel',
  'description',
  'empty',
  'emptyText',
  'heading',
  'hint',
  'label',
  'legend',
  'placeholder',
  'subtitle',
  'summary',
  'title',
  'tooltip',
  'what',
];

/**
 * Text props not checked as object keys: `alt` is also the Alt key in key maps
 * (`{ ctrl: 'Ctrl', alt: 'Alt' }`), and key caps are not UI text.
 */
const NOT_OBJECT_KEYS: readonly string[] = ['alt'];

/** Text that may stay literal: the product name. */
export const ALLOWED_TEXT: readonly string[] = ['Nova'];

const LETTER = /\p{L}/u;

interface AnyNode {
  type: string;
  parent?: AnyNode;
  [key: string]: unknown;
}

function texts(node: AnyNode | null | undefined): string[] {
  if (!node) return [];
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? [node.value] : [];
    case 'TemplateLiteral':
      return [
        (node.quasis as Array<{ value: { cooked?: string | null; raw: string } }>)
          .map((q) => q.value.cooked ?? q.value.raw)
          .join(' '),
      ];
    case 'ConditionalExpression':
      return [...texts(node.consequent as AnyNode), ...texts(node.alternate as AnyNode)];
    case 'LogicalExpression':
      return texts(node.right as AnyNode);
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'ParenthesizedExpression':
      return texts(node.expression as AnyNode);
    default:
      return [];
  }
}

function insideDefineMessages(node: AnyNode): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type !== 'CallExpression') continue;
    const callee = p.callee as AnyNode;
    const name =
      callee.type === 'Identifier'
        ? callee.name
        : callee.type === 'MemberExpression'
          ? (callee.property as AnyNode).name
          : null;
    if (name === 'defineMessages') return true;
  }
  return false;
}

function keyName(key: AnyNode): string | null {
  if (key.type === 'Identifier') return key.name as string;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

export const noLiteralUiText: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'UI text comes from defineMessages (FR-016), never a literal in the component',
    },
    schema: [
      {
        type: 'object',
        properties: { allow: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: {
      text: 'UI text "{{text}}" must come from defineMessages (see packages/i18n/README.md)',
      prop: 'The {{prop}} text "{{text}}" must come from defineMessages (see packages/i18n/README.md)',
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as { allow?: string[] };
    const allow = new Set([...ALLOWED_TEXT, ...(options.allow ?? [])]);
    const props = new Set(TEXT_PROPS);
    const objectKeys = new Set(TEXT_PROPS.filter((p) => !NOT_OBJECT_KEYS.includes(p)));
    const shown = (s: string) => {
      const t = s.replace(/\s+/g, ' ').trim();
      return t.length > 40 ? `${t.slice(0, 40)}…` : t;
    };
    const isText = (s: string) => {
      const t = s.trim();
      return LETTER.test(t) && !allow.has(t);
    };
    const report = (node: AnyNode, values: string[], prop?: string) => {
      const hit = values.find(isText);
      if (hit === undefined) return;
      context.report({
        node: node as unknown as Rule.Node,
        messageId: prop ? 'prop' : 'text',
        data: { text: shown(hit), prop: prop ?? '' },
      });
    };
    return {
      JSXText(n: Rule.Node) {
        const node = n as unknown as AnyNode;
        report(node, [node.value as string]);
      },
      JSXExpressionContainer(n: Rule.Node) {
        const node = n as unknown as AnyNode;
        const parent = node.parent?.type;
        if (parent !== 'JSXElement' && parent !== 'JSXFragment') return;
        report(node, texts(node.expression as AnyNode));
      },
      JSXAttribute(n: Rule.Node) {
        const node = n as unknown as AnyNode;
        const name = node.name as AnyNode;
        const prop = name.type === 'JSXIdentifier' ? (name.name as string) : null;
        if (!prop || !props.has(prop)) return;
        const value = node.value as AnyNode | null;
        if (!value) return;
        if (value.type === 'Literal') report(value, texts(value), prop);
        else if (value.type === 'JSXExpressionContainer')
          report(value, texts(value.expression as AnyNode), prop);
      },
      Property(n: Rule.Node) {
        const node = n as unknown as AnyNode;
        if (node.computed) return;
        const key = keyName(node.key as AnyNode);
        if (!key || !objectKeys.has(key)) return;
        const values = texts(node.value as AnyNode);
        if (!values.some(isText) || insideDefineMessages(node)) return;
        report(node.value as AnyNode, values, key);
      },
    };
  },
};

/** The `nova-i18n` plugin for eslint.config.js. */
const plugin = {
  meta: { name: 'nova-i18n' },
  rules: { 'no-literal-ui-text': noLiteralUiText },
};

export default plugin;
