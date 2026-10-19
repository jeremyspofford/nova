// @ts-check
// Word count (a third-party sample extension, FR-117): one tool and one command that count the
// words, sentences and reading time of a text. It declares no network, files or secrets.

/** @param {string} text */
function count(text) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const sentences = (text.match(/[.!?]+(\s|$)/g) ?? []).length;
  return { words, sentences, readingMinutes: Math.max(1, Math.round(words / 230)) };
}

/** @param {import('@nova/sdk').Nova} nova */
export function activate(nova) {
  nova.tools.register({
    name: 'count_words',
    title: 'Count words',
    description: 'Count the words and sentences of a text and estimate its reading time.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 200000 } },
      required: ['text'],
    },
    annotations: { readOnly: true },
    handler: (args) => count(/** @type {{text: string}} */ (args).text),
  });

  nova.commands.register({
    id: 'word-count.count',
    title: 'Word count: count a text',
    run: (args) =>
      count(args && typeof args === 'object' && 'text' in args ? String(args.text) : ''),
  });
}
