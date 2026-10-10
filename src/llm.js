// The "brain": one call to the Claude API that must answer through the brief tool.
// Swappable: tests pass a fake with the same think() signature.
import Anthropic from '@anthropic-ai/sdk';

// The newer web search (with dynamic filtering) runs on Sonnet and Opus only; Haiku uses the basic one.
export function webSearchTool(model, maxUses) {
  const type = /haiku/.test(model) ? 'web_search_20250305' : 'web_search_20260209';
  return { type, name: 'web_search', max_uses: maxUses };
}

// The newest Sonnet, Opus and Fable models refuse a forced tool call (tool_choice "tool"/"any" is a 400).
// For them the tool is offered with "auto" and the prompt says to use it; one retry if the model only talks.
export const forcesTools = (model) => !/sonnet-5-5|opus-5-5|fable-5-1|mythos-5-1/.test(model);
export const toolChoice = (model, name) => (forcesTools(model) ? { type: 'tool', name } : { type: 'auto' });

export function claudeBrain({
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.JARVIS_MODEL || 'claude-sonnet-5-5',
  fetch,                       // optional; tests use it to intercept the HTTP call
} = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  const client = new Anthropic({ apiKey, ...(fetch ? { fetch } : {}) });

  return {
    model,
    async think({ system, user, tool }) {
      const usage = { input: 0, output: 0 };
      let messages = [{ role: 'user', content: forcesTools(model) ? user : `${user}\n\nAnswer only by calling ${tool.name}.` }];
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await client.messages.create({
          model,
          max_tokens: forcesTools(model) ? 4096 : 16000,      // thinking can't be switched off on these, so leave it room
          system,
          tools: [tool],
          tool_choice: toolChoice(model, tool.name),
          messages,
        });
        usage.input += res.usage?.input_tokens || 0;
        usage.output += res.usage?.output_tokens || 0;
        const call = res.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
        if (call) return { output: call.input, model: res.model, usage };
        if (forcesTools(model) || attempt) throw new Error(`Model did not call ${tool.name} (stop_reason: ${res.stop_reason}).`);
        messages = [...messages, { role: 'assistant', content: res.content }, { role: 'user', content: `Now call ${tool.name} with your answer.` }];
      }
    },
  };
}

// A brain that may search the web before answering through the tool. Used by the leads agent.
// The model searches (Anthropic runs the searches), then calls the tool; if it stops without calling it,
// one last request forces the call. maxSearches caps the cost of a run.
export function claudeResearcher({
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.SYNAUT_LEADS_MODEL || process.env.JARVIS_MODEL || 'claude-sonnet-5-5',
  maxSearches = Number(process.env.SYNAUT_LEADS_SEARCHES) || 8,
  fetch,
} = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  const client = new Anthropic({ apiKey, ...(fetch ? { fetch } : {}) });

  return {
    model,
    async research({ system, user, tool }) {
      const search = webSearchTool(model, maxSearches);
      const usage = { input: 0, output: 0, searches: 0 };
      let messages = [{ role: 'user', content: user }];
      let served = model;
      for (let round = 0; round < 6; round++) {
        const last = round === 5;
        if (last && messages.at(-1).role === 'assistant') messages.push({ role: 'user', content: `Now record what you found with ${tool.name}.` });
        const res = await client.messages.create({
          model, max_tokens: 8000, system, messages,
          // Each round re-sends everything found so far; caching makes those repeats about 10x cheaper.
          cache_control: { type: 'ephemeral' },
          tools: last ? [tool] : [search, tool],
          tool_choice: last ? toolChoice(model, tool.name) : { type: 'auto' },
        });
        served = res.model || served;
        usage.input += (res.usage?.input_tokens || 0) + (res.usage?.cache_read_input_tokens || 0) + (res.usage?.cache_creation_input_tokens || 0);
        usage.output += res.usage?.output_tokens || 0;
        usage.searches += res.usage?.server_tool_use?.web_search_requests || 0;
        const call = res.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
        if (call) return { output: call.input, model: served, usage };
        messages = [...messages, { role: 'assistant', content: res.content }];
        if (res.stop_reason === 'pause_turn') continue;           // a long search turn; let it carry on
        messages.push({ role: 'user', content: `Now record what you found with ${tool.name}.` });
        round = 4;                                                 // next round forces the tool
      }
      throw new Error(`Model did not call ${tool.name}.`);
    },
  };
}
