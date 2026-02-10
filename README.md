# Online Status Update Portal

Professional status updates with sentiment labels, real-time feed, polls, and analytics.

## Stack & Architecture (PRN)
- **Frontend:** React + Vite SPA
- **Backend:** Node.js + Express + Socket.IO
- **Database:** SQLite

Why this stack: it is fast to iterate locally, easy to deploy, and fits the current codebase. SQLite keeps setup friction low while still supporting relational data needed for polls, reactions, and analytics.

See `docs/architecture.md` for the system flow diagram.

## Database Schema
See `docs/schema.md` for the ER diagram and table definitions.

## UI/UX Wireframes & Theme
See `docs/wireframes.md` for wireframes and color palette.

## Repo Structure
```
portal/
  backend/
  frontend/
  docs/
```

## Environment
Backend: `portal/backend/.env`
```
PORT=4000
DB_FILE=./data.db
FRONTEND_URL=http://localhost:5173
SESSION_SECRET=dev-secret-change-me
SESSION_TTL_DAYS=7
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com
```

Frontend: `portal/frontend/.env`
```
VITE_API_BASE=http://localhost:4000
```

## Run Locally
Backend:
```
cd portal/backend
npm install
npm run dev
```

Frontend:
```
cd portal/frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

## Branching Strategy
- `main`: stable, deployable
- `dev`: integration branch
- `feature/<name>`: short-lived feature work
- `fix/<name>`: bug fixes

Merge to `dev` via PR, then promote to `main` when verified.
