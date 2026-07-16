/** Trigger a client-side file download from in-memory content (no server round-trip). */
export function downloadBlob(filename: string, content: string, mime = 'text/markdown'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
