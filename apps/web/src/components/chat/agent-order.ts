export function reconcileAgentOrder(
  savedOrder: readonly string[],
  availableKeys: readonly string[],
  initialOrder: readonly string[],
) {
  const available = new Set(availableKeys);
  const seen = new Set<string>();
  const order: string[] = [];
  const preferredOrder = savedOrder.length ? savedOrder : initialOrder;

  for (const key of preferredOrder) {
    if (available.has(key) && !seen.has(key)) {
      seen.add(key);
      order.push(key);
    }
  }
  for (const key of availableKeys) {
    if (!seen.has(key)) {
      seen.add(key);
      order.push(key);
    }
  }
  return order;
}

export function moveAgentOrder(order: readonly string[], activeKey: string, targetKey: string) {
  const fromIndex = order.indexOf(activeKey);
  const targetIndex = order.indexOf(targetKey);
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return [...order];

  const result = [...order];
  result.splice(fromIndex, 1);
  result.splice(result.indexOf(targetKey), 0, activeKey);
  return result;
}

export function sameAgentOrder(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}
