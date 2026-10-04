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
