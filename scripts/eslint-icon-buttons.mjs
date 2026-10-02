function iconName(node) {
  const name = node.openingElement?.name?.name;
  return name === 'Codicon' || name === 'FileIcon' || name === 'svg' || name?.endsWith('Icon');
}

function isIconContent(node) {
  if (node.type === 'JSXText') return !node.value.trim();
  if (node.type === 'JSXExpressionContainer') return node.expression.type === 'JSXEmptyExpression' || isIconContent(node.expression);
  if (node.type === 'Literal') return node.value == null || typeof node.value === 'boolean';
  if (node.type === 'ConditionalExpression') return isIconContent(node.consequent) && isIconContent(node.alternate);
  if (node.type === 'LogicalExpression' && node.operator === '&&') return isIconContent(node.right);
  if (node.type === 'JSXFragment') return node.children.every(isIconContent);
  if (node.type !== 'JSXElement') return false;
  if (iconName(node)) return true;
  if (!['span', 'i'].includes(node.openingElement.name.name)) return false;
  return node.children.every(isIconContent) && (
    node.children.some((child) => child.type !== 'JSXText')
    || node.openingElement.attributes.some((attribute) => attribute.type === 'JSXAttribute'
      && attribute.name.name === 'className' && attribute.value?.type === 'Literal'
      && String(attribute.value.value).includes('codicon'))
  );
}

// UI actions share hover/pressed/disabled behavior; native window chrome stays platform-specific.
export default {
  meta: { type: 'suggestion', schema: [], messages: { useIconButton: '图标操作按钮请使用 IconButton，共享灰色交互反馈。' } },
  create(context) {
    const source = context.sourceCode;
    return {
      JSXElement(node) {
        if (node.openingElement.name.name !== 'button' || !node.children.length) return;
        if (context.filename.endsWith('/TitleBar.tsx') && source.getText(node).includes('bridge.window.')) return;
        if (node.children.every(isIconContent) && node.children.some((child) => child.type !== 'JSXText')) {
          context.report({ node: node.openingElement, messageId: 'useIconButton' });
        }
      },
    };
  },
};
