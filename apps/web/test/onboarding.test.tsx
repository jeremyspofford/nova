import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { SAMPLE_NAME, SAMPLE_PROMPT } from '../src/onboarding/sample.ts';
import { createHub } from './fakes.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

const fresh = (step = 'provider') =>
  createHub({
    settings: { 'onboarding.state': { step, completed: false, skipped: false } },
    models: [],
  });

const heading = (name: string) => screen.findByRole('heading', { name, level: 1 });

describe('onboarding (FR-014)', () => {
  it('runs the happy path from provider to a running sample chat', async () => {
    const hub = fresh();
    await renderApp({ hub, path: '/chat' });
    await waitFor(() => expect(window.location.pathname).toBe('/onboarding'));
    expect(await heading('Connect a model provider')).toBeTruthy();
    expect(screen.getByText('Step 1 of 5')).toBeTruthy();

    // Step 1: Mock needs no key; connecting refreshes the model list.
    hub.state.models = (await import('./fakes.ts')).MODELS;
    await userEvent.click(await screen.findByRole('radio', { name: 'Mock' }));
    await userEvent.click(screen.getByRole('button', { name: 'Connect and test' }));
    await waitFor(() =>
      expect(hub.api.createProvider).toHaveBeenCalledWith({ provider: 'mock', label: 'Mock' }),
    );
    expect(hub.api.testProvider).toHaveBeenCalled();

    // Step 2: default model.
    expect(await heading('Pick a default model')).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Pick a default model'));
    expect(hub.state.settings['onboarding.state']).toEqual({
      step: 'model',
      completed: false,
      skipped: false,
    });
    await userEvent.click(await screen.findByRole('radio', { name: 'Mock smart' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(hub.state.settings['chat.defaultModel']).toBe('pa1/mock-smart'));

    // Step 3: name.
    expect(await heading('Choose your name')).toBeTruthy();
    const name = screen.getByRole('textbox', { name: 'Display name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Alex');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(hub.api.updateAccount).toHaveBeenCalledWith({ displayName: 'Alex' }),
    );

    // Step 4: add an MCP server with the same form as Settings → Tools & MCP.
    expect(await heading('Connect a tool')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add an MCP server' }));
    const toolForm = screen.getByRole('form', { name: 'Add an MCP server' });
    await userEvent.type(within(toolForm).getByRole('textbox', { name: 'Name' }), 'files');
    await userEvent.type(within(toolForm).getByRole('textbox', { name: 'Command' }), 'npx');
    await userEvent.click(within(toolForm).getByRole('button', { name: 'Add server' }));
    expect(await screen.findByText('Added files. It connects in the background.')).toBeTruthy();
    expect(hub.api.createMcpServer).toHaveBeenCalledWith({
      name: 'files',
      transport: 'stdio',
      command: 'npx',
    });
    expect(screen.getByRole('button', { name: 'Add another server' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Step 5: safety primer and the sample task.
    expect(await heading('Run a first task')).toBeTruthy();
    const primer = screen.getByRole('complementary', { name: 'You stay in control' });
    expect(within(primer).getByLabelText('Esc')).toBeTruthy();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }).value).toBe(
      SAMPLE_PROMPT,
    );
    expect(screen.getByText(SAMPLE_NAME)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Run this' }));

    await waitFor(() => expect(hub.api.createThread).toHaveBeenCalled());
    const created = hub.state.threads[0]!;
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${created.id}`));
    await waitFor(() => expect(hub.api.sendMessage).toHaveBeenCalled());
    const [, body] = hub.api.sendMessage.mock.calls[0] as unknown as [
      string,
      { text: string; attachments: { name: string; mime: string; data: string }[] },
    ];
    expect(body.text).toBe(SAMPLE_PROMPT);
    expect(body.attachments[0]).toMatchObject({ name: SAMPLE_NAME, mime: 'text/markdown' });
    expect(atob(body.attachments[0]!.data)).toContain('Riverside Community Garden');
    expect(hub.state.settings['onboarding.state']).toEqual({
      step: 'done',
      completed: true,
      skipped: false,
    });
    expect(await screen.findByText('Setup complete. Your sample task is running.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Account: Alex' })).toBeTruthy();
  });

  it('resumes at the saved step after a reload', async () => {
    const hub = fresh('profile');
    await renderApp({ hub, path: '/' });
    expect(await heading('Choose your name')).toBeTruthy();
    expect(screen.getByText('Step 3 of 5')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Skip this step' }));
    expect(await heading('Connect a tool')).toBeTruthy();
    expect(hub.state.settings['onboarding.state']).toEqual({
      step: 'tool',
      completed: false,
      skipped: false,
    });
    resetDom();
    await renderApp({ hub, path: '/chat' });
    expect(await heading('Connect a tool')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await heading('Choose your name')).toBeTruthy();
  });

  it('can skip every step, skip setup entirely, and is not shown again', async () => {
    const hub = fresh();
    await renderApp({ hub, path: '/chat' });
    expect(await heading('Connect a model provider')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Skip this step' }));
    expect(await heading('Pick a default model')).toBeTruthy();
    expect(screen.getByText(/No models are available yet/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Skip setup' }));
    expect(window.location.pathname).toBe('/chat');
    await waitFor(() =>
      expect(hub.state.settings['onboarding.state']).toEqual({
        step: 'model',
        completed: false,
        skipped: true,
      }),
    );
    resetDom();
    await renderApp({ hub, path: '/chat' });
    expect(window.location.pathname).toBe('/chat');
  });

  it('reports a failed connection test and lets the user retry or remove it', async () => {
    const hub = fresh();
    hub.state.testResult = { ok: false, detail: 'Connection refused' };
    await renderApp({ hub, path: '/onboarding' });
    await userEvent.click(await screen.findByRole('radio', { name: 'OpenAI-compatible' }));
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Connect and test' });
    expect(save.disabled).toBe(true);
    const url = screen.getByRole('textbox', { name: 'Base URL' });
    await userEvent.type(url, 'not a url');
    expect(screen.getByText(/Enter a full URL/)).toBeTruthy();
    await userEvent.clear(url);
    await userEvent.type(url, 'http://127.0.0.1:8000/v1');
    await userEvent.click(save);
    expect(await screen.findByText(/could not connect: Connection refused/)).toBeTruthy();
    hub.state.testResult = { ok: true, models: 1 };
    await userEvent.click(screen.getByRole('button', { name: /Test again/ }));
    expect(await heading('Pick a default model')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Already connected:')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add another' }));
    hub.state.failNext.createProvider = new ApiError(400, {
      code: 'validation',
      message: 'Label taken',
      retryable: false,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Connect and test' }));
    expect(await screen.findByText('Label taken')).toBeTruthy();
  });

  it('removes a provider that failed its test so it can be re-entered', async () => {
    const hub = fresh();
    hub.state.testResult = { ok: false };
    await renderApp({ hub, path: '/onboarding' });
    await userEvent.click(await screen.findByRole('radio', { name: 'Ollama (local)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Connect and test' }));
    await waitFor(() =>
      expect(hub.api.createProvider).toHaveBeenCalledWith({
        provider: 'ollama',
        label: 'Ollama (local)',
        baseUrl: 'http://127.0.0.1:11434',
      }),
    );
    expect(await screen.findByText(/did not accept the connection/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove and edit' }));
    expect(hub.state.providers).toEqual([]);
    expect(screen.getByRole('button', { name: 'Connect and test' })).toBeTruthy();
  });

  it('finishes without the sample and reports a failed sample start', async () => {
    const hub = fresh('sample');
    hub.state.models = (await import('./fakes.ts')).MODELS;
    await renderApp({ hub, path: '/onboarding' });
    expect(await heading('Run a first task')).toBeTruthy();
    hub.state.failNext.createThread = new ApiError(500, {
      code: 'x',
      message: 'Hub busy',
      retryable: true,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Run this' }));
    expect(await screen.findByText('Hub busy')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Finish without the sample' }));
    await waitFor(() => expect(window.location.pathname).toBe('/chat'));
    expect(hub.state.settings['onboarding.state']).toEqual({
      step: 'done',
      completed: true,
      skipped: false,
    });
  });

  it('skips the tool step, cancels the form, and keeps a failed add in the form', async () => {
    const hub = fresh('tool');
    await renderApp({ hub, path: '/onboarding' });
    expect(await heading('Connect a tool')).toBeTruthy();
    expect(screen.getByText(/connect tools later in Settings/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add an MCP server' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Add an MCP server' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add an MCP server' }));
    const form = screen.getByRole('form', { name: 'Add an MCP server' });
    hub.state.failNext.createMcpServer = new ApiError(400, {
      code: 'validation',
      message: 'Command not found on the Hub',
      retryable: false,
    });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Name' }), 'files');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Command' }), 'nope');
    await userEvent.click(within(form).getByRole('button', { name: 'Add server' }));
    expect(await within(form).findByText('Command not found on the Hub')).toBeTruthy();
    expect(hub.state.m3.mcpServers).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Skip this step' }));
    expect(await heading('Run a first task')).toBeTruthy();
    expect(hub.state.settings['onboarding.state']).toEqual({
      step: 'sample',
      completed: false,
      skipped: false,
    });
  });

  it('keeps the name step usable when saving fails', async () => {
    const hub = fresh('profile');
    hub.state.failNext.updateAccount = new ApiError(500, {
      code: 'x',
      message: 'Try later',
      retryable: true,
    });
    await renderApp({ hub, path: '/onboarding' });
    const name = await screen.findByRole('textbox', { name: 'Display name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Kim');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Try later')).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Display name' }).value).toBe(
      'Kim',
    );
  });

  it('offers local llama.cpp with its default address', async () => {
    const hub = fresh();
    await renderApp({ hub, path: '/onboarding' });
    for (const name of ['Anthropic', 'OpenRouter', 'OpenAI', 'Ollama (local)'])
      expect(await screen.findByRole('radio', { name })).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'llama.cpp (local)' }));
    expect(screen.getByRole('textbox', { name: 'Base URL' }).getAttribute('placeholder')).toBe(
      'http://127.0.0.1:8080',
    );
    expect(screen.getByLabelText('API key').getAttribute('aria-describedby')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Connect and test' }));
    await waitFor(() =>
      expect(hub.api.createProvider).toHaveBeenCalledWith({
        provider: 'llamacpp',
        label: 'llama.cpp (local)',
        baseUrl: 'http://127.0.0.1:8080',
      }),
    );
  });
});
