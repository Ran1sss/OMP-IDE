export interface DialogFocusTarget {
  isConnected: boolean;
  focus(): void;
}

export function restoreDialogFocus(
  invoker: DialogFocusTarget | null,
  preferred?: () => void,
): void {
  if (preferred) {
    preferred();
    return;
  }
  if (invoker?.isConnected) invoker.focus();
}
