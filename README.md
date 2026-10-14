# Gridiron Legends

A pixel-art arcade American football game with deep franchise simulation, featuring gameplay, team management, AI opponents, player development, statistics, save/load, and configurable settings.

## Features
- Pixel-art rendered graphics using an HTML5 canvas with crisp, retro styling
- Authentic American football rules including scoring, downs, possessions, kicks, and turnovers
- Franchise mode: manage rosters, draft players, negotiate contracts, set salaries, and oversee team finances
- AI-controlled opponents for offense, defense, and special teams with varied strategies
- Player development system tracking attributes, injuries, personality, and fatigue
- Comprehensive statistics: play-by-play logging, expected points added (EPA), leaderboards, and aggregate reports
- Persistent save system for game settings and franchise progress
- Adjustable audio, visual, accessibility, and gameplay preferences via an in-game settings menu
- Support for keyboard, gamepad, and touch input
- Procedural audio effects including crowd noise, sound effects, and dynamic music
- Editable data files (JSON) for teams, plays, formations, colleges, names, and weather
- Unit and integration test suite using Vitest

## Getting started
Requires Node.js and npm. Install dependencies and start the development server:
```bash
npm install
npm run dev
```
Build the production version:
```bash
npm run build
```
Preview the built application:
```bash
npm run preview
```
Run the test suite:
```bash
npm test
```

## Project structure
- src/ – Core source code (gameplay, franchise, UI, AI, physics, audio, etc.)
- public/ – Static assets such as audio files and the favicon
- index.html – Entry HTML file loading the game canvas
- package.json – npm scripts and project dependencies
- tsconfig.json – TypeScript compiler configuration
- vite.config.ts – Vite build tool configuration
- scripts/ – Utility scripts (e.g., file size checker)
- tests/ – Test files for unit and integration testing

## License
Released under the MIT License (see LICENSE).
