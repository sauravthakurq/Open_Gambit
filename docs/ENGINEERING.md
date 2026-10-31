# Engineering notes

## Architecture

Open Gambit is a Next.js App Router application written in TypeScript.

- `src/components`: presentation components organised by product area.
- `src/store`: focused Zustand stores for game state, engine state, AI settings, multiplayer and UI state.
- `src/hooks`: lifecycle-sensitive integrations, including cloud AI turns, Stockfish, Firebase sync and chess clocks.
- `src/lib/StockfishEngine.ts`: browser Web Worker adapter for local engine evaluation and play.
- `src/app/api`: server routes for AI move selection and post-game analysis.
- Firebase provides auth and real-time multiplayer. Firebase Security Rules must restrict a game to its two participants.

## Security model

AI provider keys are user-supplied at runtime. They must never be persisted by the app, committed to Git, or logged by server routes.

The AI API routes now:

1. reject unknown request fields and invalid data with Zod;
2. limit request body size;
3. accept only known providers and reviewed provider base URLs; and
4. reject missing keys for cloud providers.

## Local development

1. Copy `.env.example` to `.env.local`.
2. Fill in Firebase's public web configuration.
3. Run `npm ci` and `npm run dev`.

## Verification

Run these before opening a pull request:

```sh
npm run lint
npx tsc --noEmit
npm run build
```

GitHub Actions runs the same checks on pull requests and pushes to `main`.

## Next quality milestone

Add unit tests for `useGameStore`, `StockfishEngine`, provider validation, and the Firebase game transaction boundary; then add a browser test covering a complete local game and a two-player online game.
