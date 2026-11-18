export function guardMarkdownSelection(
  element: HTMLElement,
  initialText: string,
  render: (text: string) => void,
) {
  const document = element.ownerDocument;
  const window = document.defaultView;
  let displayedText = initialText;
  let pendingText: string | null = null;
  let pointerDown = false;

  const selectionIntersectsElement = (selection: Selection) => {
    const range = selection.getRangeAt(0);
    if (typeof range.intersectsNode === "function") return range.intersectsNode(element);
    const ancestor = range.commonAncestorContainer;
    return ancestor === element || element.contains(ancestor) || ancestor.contains(element);
  };

  const flush = () => {
    if (pendingText === null) return;
    const selection = document.getSelection();
    const intersectsSelection = selection && !selection.isCollapsed && selection.rangeCount > 0 &&
      selectionIntersectsElement(selection);
    if (pointerDown || intersectsSelection) {
      document.addEventListener("selectionchange", flush);
      return;
    }
    document.removeEventListener("selectionchange", flush);
    const text = pendingText;
    pendingText = null;
    if (text !== displayedText) {
      displayedText = text;
      render(text);
    }
  };

  const finishPointer = () => {
    pointerDown = false;
    window?.removeEventListener("pointerup", finishPointer);
    window?.removeEventListener("pointercancel", finishPointer);
    window?.removeEventListener("mouseup", finishPointer);
    window?.removeEventListener("blur", finishPointer);
    flush();
  };
  const startGesture = () => {
    pointerDown = true;
    window?.addEventListener("pointerup", finishPointer);
    window?.addEventListener("pointercancel", finishPointer);
    window?.addEventListener("mouseup", finishPointer);
    window?.addEventListener("blur", finishPointer);
  };
  const startPointer = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    startGesture();
  };
  const startMouse = (event: MouseEvent) => {
    if (event.button !== 0) return;
    startGesture();
  };
  element.addEventListener("pointerdown", startPointer);
  element.addEventListener("mousedown", startMouse);

  return {
    update(text: string) {
      pendingText = text;
      flush();
    },
    dispose() {
      pointerDown = false;
      element.removeEventListener("pointerdown", startPointer);
      element.removeEventListener("mousedown", startMouse);
      document.removeEventListener("selectionchange", flush);
      window?.removeEventListener("pointerup", finishPointer);
      window?.removeEventListener("pointercancel", finishPointer);
      window?.removeEventListener("blur", finishPointer);
    },
  };
}
