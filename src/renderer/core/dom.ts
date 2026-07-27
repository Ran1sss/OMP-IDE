/** Tiny DOM builder — the renderer's only view helper. */

type Child = Node | string | null | undefined | false;

export interface ElProps {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  id?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  tabIndex?: number;
  draggable?: boolean;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  onClick?: (e: MouseEvent) => void;
  onDblClick?: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  onInput?: (e: Event) => void;
  onChange?: (e: Event) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  onMouseDown?: (e: MouseEvent) => void;
  onBlur?: (e: FocusEvent) => void;
  onDragStart?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onDragLeave?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
  onDragEnd?: (e: DragEvent) => void;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.html !== undefined) node.innerHTML = props.html;
  if (props.title) node.title = props.title;
  if (props.id) node.id = props.id;
  if (props.tabIndex !== undefined) node.tabIndex = props.tabIndex;
  if (props.draggable !== undefined) node.draggable = props.draggable;
  if (props.type !== undefined && "type" in node) (node as HTMLInputElement).type = props.type;
  if (props.value !== undefined && "value" in node) (node as HTMLInputElement).value = props.value;
  if (props.placeholder !== undefined && "placeholder" in node)
    (node as HTMLInputElement).placeholder = props.placeholder;
  if (props.style) Object.assign(node.style, props.style);
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;
  // A generic HTMLElementTagNameMap[K] loses typed addEventListener overloads;
  // an HTMLElement-typed alias restores them.
  const n: HTMLElement = node;
  if (props.onClick) n.addEventListener("click", props.onClick);
  if (props.onDblClick) n.addEventListener("dblclick", props.onDblClick);
  if (props.onContextMenu) n.addEventListener("contextmenu", props.onContextMenu);
  if (props.onInput) n.addEventListener("input", props.onInput);
  if (props.onChange) n.addEventListener("change", props.onChange);
  if (props.onKeyDown) n.addEventListener("keydown", props.onKeyDown);
  if (props.onMouseDown) n.addEventListener("mousedown", props.onMouseDown);
  if (props.onBlur) n.addEventListener("blur", props.onBlur);
  if (props.onDragStart) n.addEventListener("dragstart", props.onDragStart);
  if (props.onDragOver) n.addEventListener("dragover", props.onDragOver);
  if (props.onDragLeave) n.addEventListener("dragleave", props.onDragLeave);
  if (props.onDrop) n.addEventListener("drop", props.onDrop);
  if (props.onDragEnd) n.addEventListener("dragend", props.onDragEnd);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function svgIcon(pathData: string, viewBox = "0 0 16 16"): HTMLElement {
  const span = document.createElement("span");
  span.style.display = "inline-flex";
  span.innerHTML = `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${pathData}</svg>`;
  return span;
}
