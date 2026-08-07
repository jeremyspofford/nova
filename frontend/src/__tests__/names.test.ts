/** names.ts turns canonical ids into what the operator reads. Wrong output
 *  here is quietly wrong everywhere an agent, tool or automation is named. */
import { describe, expect, it } from 'vitest';
import { _setAssistantName, agentDisplayName, displayName } from '../names';

describe('displayName', () => {
  it('title-cases kebab and snake case', () => {
    expect(displayName('refresh-stale-knowledge')).toBe('Refresh Stale Knowledge');
    expect(displayName('list_agents')).toBe('List Agents');
  });

  it('upper-cases the acronyms the UI actually meets', () => {
    expect(displayName('mcp-server')).toBe('MCP Server');
    expect(displayName('check-url_http')).toBe('Check URL HTTP');
    expect(displayName('ai_db_id')).toBe('AI DB ID');
  });

  it('preserves interior casing so readable titles pass through', () => {
    expect(displayName('OpenRouter')).toBe('OpenRouter');
    expect(displayName('already Readable')).toBe('Already Readable');
  });

  it('survives separator runs and edge emptiness', () => {
    expect(displayName('a--b__c')).toBe('A B C');
    expect(displayName('')).toBe('');
    expect(displayName('-_-')).toBe('');
  });
});

describe('agentDisplayName', () => {
  it("'main' wears the assistant's configured name, not the internal id", () => {
    _setAssistantName('Nova');
    expect(agentDisplayName('main')).toBe('Nova');
    _setAssistantName('Iris');
    expect(agentDisplayName('main')).toBe('Iris');
    _setAssistantName('Nova'); // leave the module how we found it
  });

  it('everyone else is title-cased like any identifier', () => {
    expect(agentDisplayName('research-helper')).toBe('Research Helper');
  });
});
