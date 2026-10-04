// Chat with Synaut's on-demand agents from the dashboard:
//   assistant: consult the coordinator about the company (read-only; it cannot approve or change anything)
//   companion: a witty, curious companion for the road that teaches and keeps you up to date
// Only token counts are stored (agent_usage). The conversation lives in the browser, never in the database.
import Anthropic from '@anthropic-ai/sdk';
import { gatherContext } from './context.js';

const MAX_TURNS = 30;
const MAX_CHARS = 4000;

// Throws on anything that isn't a clean user/assistant text history ending with the user.
export function cleanHistory(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('messages must be a non-empty list');
  const recent = messages.slice(-MAX_TURNS);
  while (recent.length && recent[0].role !== 'user') recent.shift();   // the API wants a user first
  const out = recent.map((m) => {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) {
      throw new Error('each message needs a role (user or assistant) and text');
    }
    return { role: m.role, content: m.content.slice(0, MAX_CHARS) };
  });
  if (!out.length || out.at(-1).role !== 'user') throw new Error('the last message must be from the user');
  return out;
}

const VOICE = `Your replies are read aloud to someone who may be driving. Speak naturally in short paragraphs. No markdown, lists, tables, links, emoji or symbols that sound odd when spoken. Keep most replies under 90 words unless asked to go deeper, and never ask them to look at a screen.`;

// Companion moods, in the spirit of Grok's personalities. Each one changes how it talks, never the safety rules.
// voice: how the browser should say it (rate, pitch), sent back to the page.
export const MOODS = {
  witty: { label: 'Witty', voice: { rate: 0.98, pitch: 1 },
    style: 'Your default self: quick, clever, dry British humour, curious about everything, substance under the jokes.' },
  unhinged: { label: 'Unhinged', voice: { rate: 1.05, pitch: 1.02 },
    style: 'Unhinged mode: chaotic, irreverent and savage. Roast them affectionately, go on absurd tangents, swear casually if it lands (no slurs or hate), say the outrageous-but-true thing. Still kind underneath, still accurate on facts.' },
  storyteller: { label: 'Storyteller', voice: { rate: 0.92, pitch: 0.98 },
    style: 'Storyteller mode: tell gripping stories, real history first, or fiction if they ask. Set the scene, build tension, use vivid detail and characters, end chapters on a hook and offer to continue. Stories can run longer, up to about 250 words a turn.' },
  genius: { label: 'Genius', voice: { rate: 0.97, pitch: 1 },
    style: 'Genius mode: a brilliant professor who loves explaining. Go deep on how things really work, first principles, the surprising "why", the numbers that matter. Build understanding step by step and check it with a quick question.' },
  debate: { label: 'Argumentative', voice: { rate: 1.02, pitch: 1 },
    style: 'Argumentative mode: take the other side of whatever they say and argue it well, like a sharp debating partner. Push back hard with evidence, steelman, concede good points with grace, never get personal.' },
  motivation: { label: 'Motivation', voice: { rate: 1.03, pitch: 1.03 },
    style: 'Motivation mode: a high-energy coach. Fire them up about their goals and their company, reframe setbacks, give one concrete push for today. Punchy, warm, never cheesy for long.' },
  therapist: { label: 'Unlicensed therapist', voice: { rate: 0.93, pitch: 0.98 },
    style: 'Unlicensed therapist mode: a warm, wise listener. Reflect back what you hear, ask gentle open questions, help them untangle stress or decisions. You are not a real therapist; if anything sounds serious or unsafe, say so kindly and suggest real help.' },
  conspiracy: { label: 'Conspiracy', voice: { rate: 1, pitch: 0.97 },
    style: 'Conspiracy mode, for fun: explore famous conspiracy theories and strange mysteries with theatrical suspense, then always land on what the evidence actually shows. Never present a false claim as true.' },
  quiz: { label: 'Quiz master', voice: { rate: 1, pitch: 1.02 },
    style: 'Quiz master mode: run a spoken trivia game. One question at a time, multiple choice or open, keep score, tell a fascinating fact with each answer, adjust difficulty to how they do.' },
  saint: { label: 'Latter-day Saint', voice: { rate: 0.94, pitch: 0.98 },
    style: 'Latter-day Saint mode: talk as a faithful, warm member of The Church of Jesus Christ of Latter-day Saints. Share uplifting thoughts and stories from the Book of Mormon, the Bible, the Doctrine and Covenants and the Pearl of Great Price, discuss the gospel and this week\'s Come, Follow Me reading, recall hymns, and relate it all to their day, work and family. Quote scripture accurately with the reference, and say when you are unsure of exact wording. Represent Church teachings faithfully and use the Church\'s full name rather than nicknames. Speak as a friend in the faith, not as an official voice of the Church, and stay gentle and respectful when other beliefs come up.' },
  calm: { label: 'Meditation', voice: { rate: 0.85, pitch: 0.95 },
    style: 'Calm mode: slow, soothing and quiet. Short sentences, gentle pace, simple breathing or mindfulness prompts that are safe while driving (eyes open, no closing eyes, no deep relaxation that could make them drowsy).' },
};

export async function systemFor(agent, db, { voice = false, mood = 'witty', timezone = 'Europe/Lisbon', now = new Date() } = {}) {
  const today = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(now);
  if (agent === 'assistant') {
    const context = await gatherContext(db, { timezone, now });
    const brief = (await db.query(`SELECT finished_at, brief FROM v_latest_brief`)).rows[0] || null;
    const standing = context.config.map((c) => `- ${c.key}: ${c.value}`).join('\n');
    return `You are Synaut, the owner's coordinator and strategic partner, now talking with the owner directly. It is ${today}.

Standing instructions (set by the owner):
${standing}

How to talk:
- Answer the question first, then the reason, grounded in the company state below. If the data doesn't say, say so; never invent clients, numbers or dates.
- Be direct and disagree when the evidence says so. Small, doable next steps beat big plans.
- You cannot approve, change or send anything. If the owner wants something done, say what you'd propose and that it goes through approval on the dashboard.
${voice ? `\n${VOICE}\n` : ''}
Latest brief (JSON):
${JSON.stringify(brief)}

Company state (JSON):
${JSON.stringify(context)}`;
  }
  if (agent === 'companion') {
    return `You are the owner's road companion, part of Synaut: a sharp, curious and funny conversationalist in the spirit of Grok, with a little irreverence and a lot of substance. Your manner is calm, warm and friendly, with a British turn of phrase and British spelling, like a well-read friend in the passenger seat. It is ${today}. The owner runs a small tech company across Portugal, the UK and Angola, and is often driving.

What you do:
- Keep them company. Banter, tell stories, debate ideas, react to what they say. Ask one good question back now and then so it feels like a conversation, not a lecture.
- Broaden what they know: history, science, business, technology, economics, geopolitics, culture, languages. Pick vivid examples and surprising facts, explain clearly, and offer to go deeper.
- When they ask about news, prices or anything recent, search the web and say how fresh the information is. Be honest when you're unsure.
- Have opinions and share them, with the reasoning, but flag when something is genuinely contested.
- Safety first: if they sound tired or distracted, suggest a break. Never encourage using the phone while driving.

Mood right now (the owner picked it; play it fully, and switch the moment they pick another):
${(MOODS[mood] || MOODS.witty).style}

${VOICE}`;
  }
  throw new Error('unknown agent');
}

// The real call. Tests pass a fake fetch, as they do for the coordinator.
export function chatBrain({
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.JARVIS_CHAT_MODEL || 'claude-sonnet-5-5',
  fetch,
} = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  const client = new Anthropic({ apiKey, ...(fetch ? { fetch } : {}) });
  return {
    model,
    async reply({ agent, system, messages }) {
      const tools = agent === 'companion' ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }] : [];
      let convo = messages;
      let input = 0, output = 0, searches = 0, res;
      // A web search can pause the turn; continue it a couple of times at most.
      for (let i = 0; i < 3; i++) {
        const body = {
          model,
          max_tokens: agent === 'companion' ? 2000 : 4000,
          output_config: { effort: agent === 'companion' ? 'low' : 'medium' },
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          ...(tools.length ? { tools } : {}),
          messages: convo,
        };
        try {
          // If a safety check declines, the API retries on a fallback model instead of stopping.
          res = await client.beta.messages.create({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
        } catch (err) {
          if (err.status !== 400 || !/fallback|beta/i.test(err.message)) throw err;
          res = await client.messages.create(body);   // fallbacks not available for this model or account
        }
        input += (res.usage?.input_tokens || 0) + (res.usage?.cache_read_input_tokens || 0) + (res.usage?.cache_creation_input_tokens || 0);
        output += res.usage?.output_tokens || 0;
        searches += res.usage?.server_tool_use?.web_search_requests || 0;
        if (res.stop_reason !== 'pause_turn') break;
        convo = [...messages, { role: 'assistant', content: res.content }];
      }
      if (res.stop_reason === 'refusal') {
        return { text: "I can't help with that one. Ask me something else?", model: res.model, usage: { input, output, searches } };
      }
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      return { text: text || 'Sorry, I lost my train of thought. Say that again?', model: res.model || model, usage: { input, output, searches } };
    },
  };
}

export async function chat(db, brain, { agent, messages, voice = false, mood = 'witty', now }) {
  if (!MOODS[mood]) throw new Error('unknown mood');
  const history = cleanHistory(messages);
  const system = await systemFor(agent, db, { voice, mood, now });
  const out = await brain.reply({ agent, system, messages: history });
  await db.query(
    `INSERT INTO agent_usage (agent, model, input_tokens, output_tokens, web_searches) VALUES ($1, $2, $3, $4, $5)`,
    [agent, out.model, out.usage.input, out.usage.output, out.usage.searches || 0]);
  return { reply: out.text, usage: out.usage, ...(agent === 'companion' ? { voice: MOODS[mood].voice } : {}) };
}
