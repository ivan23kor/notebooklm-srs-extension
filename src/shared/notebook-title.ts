export function getNotebookTitleKey(title: string): string {
  return title
    .normalize("NFKC")
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}
