const indent = "  ";

export function insertEditorIndent(value: string, start: number, end: number) {
  return {
    value: `${value.slice(0, start)}${indent}${value.slice(end)}`,
    selectionStart: start + indent.length,
    selectionEnd: start + indent.length,
  };
}
