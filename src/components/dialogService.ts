export type DialogRequest = {
  kind: 'confirm' | 'prompt' | 'choice' | 'multiChoice' | 'editor';
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  inputLabel?: string;
  inputType?: 'text' | 'password';
  allowEmpty?: boolean;
  validateInput?: (value: string) => string | undefined;
  initialValue?: string;
  initialSelected?: string[];
  choices?: Array<{ id: string; label: string; description?: string; icon?: string; danger?: boolean }>;
  items?: Array<{ id: string; label: string; description?: string }>;
  submit?: (value: string) => Promise<boolean>;
  resolve: (value: boolean | string | string[] | null) => void;
};

let current: DialogRequest | undefined;
export const dialogListeners = new Set<(request: DialogRequest | undefined) => void>();

export function currentDialog() { return current; }

export function publishDialog(request: DialogRequest | undefined) {
  current = request;
  dialogListeners.forEach((listener) => listener(request));
}

export function confirmDialog(options: Omit<DialogRequest, 'kind' | 'resolve' | 'inputLabel' | 'initialValue' | 'choices'>): Promise<boolean> {
  return new Promise((resolve) => publishDialog({ ...options, kind: 'confirm', resolve: (value) => resolve(value === true) }));
}

export function promptDialog(options: Omit<DialogRequest, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => publishDialog({ ...options, kind: 'prompt', resolve: (value) => resolve(typeof value === 'string' ? value : null) }));
}

export function choiceDialog(options: Omit<DialogRequest, 'kind' | 'resolve' | 'inputLabel' | 'initialValue' | 'confirmLabel'> & { choices: NonNullable<DialogRequest['choices']> }): Promise<string | null> {
  return new Promise((resolve) => publishDialog({ ...options, kind: 'choice', resolve: (value) => resolve(typeof value === 'string' ? value : null) }));
}

export function multiChoiceDialog(options: Omit<DialogRequest, 'kind' | 'resolve' | 'inputLabel' | 'initialValue'> & { choices: NonNullable<DialogRequest['choices']>; initialSelected?: string[] }): Promise<string[] | null> {
  return new Promise((resolve) => publishDialog({ ...options, kind: 'multiChoice', resolve: (value) => resolve(Array.isArray(value) ? value : null) }));
}

export function editorDialog(options: Omit<DialogRequest, 'kind' | 'resolve' | 'choices'> & { submit: NonNullable<DialogRequest['submit']> }): Promise<void> {
  return new Promise((resolve) => publishDialog({ ...options, kind: 'editor', resolve: () => resolve() }));
}
