# Next prompts

Generates ADHD mode's suggested next prompts for finished and failed threads with the server's Codex text generator, then writes them out for review against each case's rubric.

## Run

```sh
cd evals
pnpm next-prompts --model <codex model> --out runs/next-prompts
pnpm next-prompts --model <codex model> --out runs/next-prompts-new --baseline runs/next-prompts/results.json
```

- It uses your local Codex login, like the server does.
- `--case <ids>` runs only the named cases, comma-separated.
- A run writes `results.json` (prompts and latency) and `review.json`. Without a baseline, mark each case's `pass` against its rubric. With `--baseline`, `review.json` sets the new and old prompts as A and B in random order; score it before you open `answer-key.json`.

## Add a case

Add an entry to `cases.ts` with an `id`, a `source`, the thread `title` and `messages`, whether the latest run `failed` (and its `failureMessage`), and a `rubric` that says what the first prompt should do.

## Cost

Each case is one text generation call on your Codex plan. A full run is four calls.
