import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { act } from '@testing-library/react';
import { AiSettings } from './AiSettings';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import type { AiConfig, AiRuntime, BootstrapData, BridgeCommand } from '../bindings/generated';
const config: AiConfig = { executionMode:'provider', provider:'openai', apiProtocol:'chat-completions', apiUrl:'', model:'audit', maxInputTokens:128000, maxOutputTokens:128000, cliProvider:'codex', cliModel:'', cliTimeoutSeconds:300, cliExecutablePaths:{} };
const data = (provider: string) => ({ state:{ settings:{ aiConfig:{ ...config, provider } } } } as BootstrapData);
afterEach(() => { cleanup(); useAppStore.setState({ bootstrap:undefined, bridge:undefined }); });
it('rejects old provider detection and keeps key drafts tied to their provider', async () => {
  const completions: Array<(value: AiRuntime) => void> = [];
  const bridge = new MockBridge(() => new Promise<AiRuntime>(resolve => completions.push(resolve)));
  useAppStore.setState({ bridge, bootstrap:data('openai') });
  render(<AiSettings />);
  await waitFor(() => expect(completions).toHaveLength(1));
  fireEvent.change(screen.getByPlaceholderText('Enter API key'), { target:{ value:'synthetic-key-draft' } });
  useAppStore.setState({ bootstrap:data('claude') });
  await waitFor(() => expect(completions).toHaveLength(2));
  expect(screen.getByPlaceholderText('Enter API key')).toHaveValue('');
  completions[1]({ available:true, configured:true, provider:'claude', keySaved:false, message:'current provider', version:null });
  expect(await screen.findByText('current provider')).toBeInTheDocument();
  completions[0]({ available:true, configured:true, provider:'openai', keySaved:true, message:'old provider', version:null });
  await Promise.resolve();
  expect(screen.queryByText('old provider')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name:'Remove key' })).toBeDisabled();
});

it('only retries secure storage when the user explicitly requests it', async () => {
  const commands: string[] = [];
  const bridge = new MockBridge(command => {
    commands.push(command.type);
    return { available:false, configured:false, provider:'openai', keySaved:false,
      message:'Unable to read AI API key from system secure storage. Retry access in AI settings.', version:null };
  });
  useAppStore.setState({ bridge, bootstrap:data('openai') });
  render(<AiSettings />);
  await screen.findByText('Unable to read AI API key from system secure storage. Retry access in AI settings.');
  expect(commands).toEqual(['aiRuntime']);
  const previous = useAppStore.getState().bootstrap!;
  act(() => useAppStore.setState({ bootstrap:{ ...previous, state:{ ...previous.state, settings:{ ...previous.state.settings!, aiConfig:{ ...previous.state.settings!.aiConfig!, model:'another-model' } } } } }));
  await waitFor(() => expect(commands).toEqual(['aiRuntime','aiRuntime']));
  fireEvent.click(screen.getByRole('button', { name:'Recheck key access' }));
  await waitFor(() => expect(commands).toEqual(['aiRuntime','aiRuntime','aiRefreshKey']));
});

it('uses the updated cached credential after saving without forcing another keychain read', async () => {
  const commands: string[] = [];
  let saved = false;
  const bridge = new MockBridge(command => {
    commands.push(command.type);
    if (command.type === 'aiSaveKey') { saved = true; return true; }
    return { available:saved, configured:saved, provider:'openai', keySaved:saved,
      message:saved ? 'AI provider configured' : 'Configure the API endpoint, model and API key', version:null };
  });
  useAppStore.setState({ bridge, bootstrap:data('openai') });
  render(<AiSettings />);
  await screen.findByText('Configure the API endpoint, model and API key');
  fireEvent.change(screen.getByPlaceholderText('Enter API key'), { target:{ value:'synthetic-key' } });
  fireEvent.click(screen.getByRole('button', { name:'Save key' }));
  await screen.findByText('AI provider configured');
  expect(commands).toEqual(['aiRuntime','aiSaveKey','aiRuntime']);
  expect(screen.getByPlaceholderText('Key saved in system secure storage')).toHaveValue('');
});

it('saves an input token budget above one million from the visible control', async () => {
  const commands: BridgeCommand[] = [];
  const bridge = new MockBridge(command => {
    commands.push(command);
    if (command.type === 'updateSettings') return { settings: command.payload.settings, effects: { rescanWorkspace:false, reloadHistory:false, restartAutoRefresh:false } };
    return { available:true, configured:true, provider:'openai', keySaved:true, message:'AI provider configured', version:null };
  });
  useAppStore.setState({ bridge, bootstrap:data('openai') }); render(<AiSettings />);
  const control = screen.getByRole('spinbutton', { name:'Maximum input tokens' });
  const visible = control.closest('.settings-row')!.querySelector<HTMLInputElement>('.settings-stepper-input')!;
  fireEvent.focus(visible); fireEvent.change(visible, { target:{ value:'2500000' } }); fireEvent.blur(visible);
  await waitFor(() => expect(useAppStore.getState().bootstrap!.state.settings!.aiConfig!.maxInputTokens).toBe(2500000));
  expect(commands.some(command => command.type === 'updateSettings' && command.payload.settings.aiConfig?.maxInputTokens === 2500000)).toBe(true);
});
