import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthorAvatar } from './AuthorAvatar';
import { useAppStore } from '../store/appStore';

const requested: string[] = [];
class SuccessfulImage { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(value: string) { requested.push(value); queueMicrotask(() => this.onload?.()); } }
afterEach(() => { cleanup(); requested.length = 0; useAppStore.setState({ bootstrap: undefined }); });

describe('AuthorAvatar privacy', () => {
  it('uses only the GitHub noreply username when enabled', async () => {
    Object.defineProperty(globalThis, 'Image', { configurable: true, value: SuccessfulImage });
    useAppStore.setState({ bootstrap: { state: { settings: { onlineAvatarsEnabled: true, gravatarEnabled: false } } } as never });
    render(<AuthorAvatar name="Ada" email="123+octocat@users.noreply.github.com" />);
    await waitFor(() => expect(requested[0]).toContain('avatars.githubusercontent.com/octocat'));
    expect(requested[0]).not.toContain('123+');
  });
  it('hashes ordinary email before requesting Gravatar', async () => {
    Object.defineProperty(globalThis, 'Image', { configurable: true, value: SuccessfulImage });
    useAppStore.setState({ bootstrap: { state: { settings: { onlineAvatarsEnabled: true, gravatarEnabled: true } } } as never });
    render(<AuthorAvatar name="Ada" email="Ada@Example.Test" />);
    await waitFor(() => expect(requested[0]).toContain('www.gravatar.com/avatar/'));
    expect(requested[0]).not.toContain('ada@example.test');
  });
});
