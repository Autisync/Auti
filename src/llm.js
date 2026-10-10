// The "brain": one call to the Claude API that must answer through the brief tool.
// Swappable: tests pass a fake with the same think() signature.
import Anthropic from '@anthropic-ai/sdk';

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
      const res = await client.messages.create({
        model,
        max_tokens: 4096,
        system,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: user }],
      });
      const call = res.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
      if (!call) throw new Error(`Model did not call ${tool.name} (stop_reason: ${res.stop_reason}).`);
      return {
        output: call.input,
        model: res.model,
        usage: { input: res.usage?.input_tokens, output: res.usage?.output_tokens },
      };
    },
  };
}

// A brain that may search the web before answering through the tool. Used by the leads agent.
// The model searches (Anthropic runs the searches), then calls the tool; if it stops without calling it,
// one last request forces the call. maxSearches caps the cost of a run.
export function claudeResearcher({
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.JARVIS_MODEL || 'claude-sonnet-5-5',
  maxSearches = Number(process.env.SYNAUT_LEADS_SEARCHES) || 8,
  fetch,
} = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  const client = new Anthropic({ apiKey, ...(fetch ? { fetch } : {}) });

  return {
    model,
    async research({ system, user, tool }) {
      const search = { type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches };
      const usage = { input: 0, output: 0, searches: 0 };
      let messages = [{ role: 'user', content: user }];
      let served = model;
      for (let round = 0; round < 6; round++) {
        const last = round === 5;
        if (last && messages.at(-1).role === 'assistant') messages.push({ role: 'user', content: `Now record what you found with ${tool.name}.` });
        const res = await client.messages.create({
          model, max_tokens: 8000, system, messages,
          tools: last ? [tool] : [search, tool],
          tool_choice: last ? { type: 'tool', name: tool.name } : { type: 'auto' },
        });
        served = res.model || served;
        usage.input += res.usage?.input_tokens || 0;
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
