export type WorkspaceRootCreateKind = "file" | "folder";

export function workspaceRootCreateKinds(root: string | null): WorkspaceRootCreateKind[] {
  return root ? ["file", "folder"] : [];
}
