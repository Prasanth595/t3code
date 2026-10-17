import { InputRule } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Paragraph from "@tiptap/extension-paragraph";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

const taskListTokenizer = TaskList.config.markdownTokenizer!;

const NoteParagraph = Paragraph.extend({
  parseMarkdown(token, helpers) {
    // The default parser unwraps standalone images as blocks. Note images
    // are inline, so even a standalone image needs its paragraph container.
    if (token.tokens?.length === 1 && token.tokens[0]?.type === "image") {
      return helpers.createNode("paragraph", {}, helpers.parseInline(token.tokens));
    }
    return Paragraph.config.parseMarkdown!(token, helpers);
  },
});

// Also accept shorthand tasks in stored notes and pasted Markdown. Keeping
// this in the block tokenizer leaves code fences and inline code untouched.
const NoteTaskList = TaskList.extend({
  markdownTokenizer: {
    ...taskListTokenizer,
    start(source) {
      // Marked asks about source.slice(1). Only interrupt a paragraph at a
      // newline, otherwise `[] code` could be split into a task mid-line.
      const index = source.search(/\n {0,3}(?:[-+*][ \t]+)?\[[ xX]?\](?:[ \t]|$)/);
      return index < 0 ? -1 : index + 1;
    },
    tokenize(source, tokens, lexer) {
      const standard = taskListTokenizer.tokenize(source, tokens, lexer);
      if (standard) return standard;

      const items = [];
      let raw = "";
      let match;
      while (
        (match = /^ {0,3}(?:[-+*][ \t]+)?\[([ xX]?)\](?:[ \t]+([^\n]*)|(?=\n|$))(?:\n|$)/.exec(
          source.slice(raw.length),
        ))
      ) {
        raw += match[0];
        const text = match[2] ?? "";
        items.push({
          type: "taskItem",
          raw: match[0],
          checked: match[1]?.toLowerCase() === "x",
          text,
          tokens: lexer.inlineTokens(text),
        });
      }
      return items.length > 0 ? { type: "taskList", raw, items } : undefined;
    },
  },
});

const NoteTaskItem = TaskItem.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /^\s*(?:[-+*]\s+)?\[([ xX]?)\]\s$/,
        handler: ({ range, match, chain }) => {
          // A typed "- " is already a bullet list by the time "[ ] " arrives.
          chain()
            .deleteRange(range)
            .toggleTaskList()
            .updateAttributes(this.name, { checked: match[1]?.toLowerCase() === "x" })
            .run();
        },
      }),
    ];
  },
}).configure({ nested: true });

export const NOTE_EDITOR_EXTENSIONS = [
  StarterKit.configure({
    paragraph: false,
    link: { openOnClick: false },
    underline: false,
  }),
  NoteParagraph,
  NoteTaskList,
  NoteTaskItem,
  TableKit,
  Image.configure({ inline: true }),
  Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
];
