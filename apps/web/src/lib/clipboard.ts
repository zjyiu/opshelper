function copyTextFallback(text: string) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.top = "0";
  textArea.style.left = "0";
  textArea.style.width = "1px";
  textArea.style.height = "1px";
  textArea.style.opacity = "0";

  document.body.appendChild(textArea);
  try {
    textArea.focus();
    textArea.select();
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textArea);
  }
}

export async function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for browsers that expose the Clipboard API but deny writes.
    }
  }

  if (!copyTextFallback(text)) {
    throw new Error("浏览器拒绝复制，请手动复制");
  }
}
