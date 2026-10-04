import { createContext, useContext } from 'react';
import type { DesktopSettings, LayoutState } from '../bindings/generated';
import { defaultSettingValue, isSettingModified, type SettingPath } from './defaults';
export type SettingsState = {
  settings: DesktopSettings;
  layout: LayoutState;
  restore: (path: SettingPath) => Promise<void>;
};
export const SettingsStateContext = createContext<SettingsState | null>(null);
export function useSettingState(path?: SettingPath) {
  const state = useContext(SettingsStateContext);
  if (!state || !path) return null;
  return { state, path, defaultValue: defaultSettingValue(path), modified: isSettingModified(path, state.settings, state.layout) };
}
