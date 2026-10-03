import { createTranslator, resolveLanguage } from '../i18n';
import { useAppStore } from '../store/appStore';
export function t(key: string, ...args: Array<string | number>) {
  return createTranslator(resolveLanguage(useAppStore.getState().bootstrap?.state.settings?.language ?? 'system'))(
    key,
    ...args,
  );
}
