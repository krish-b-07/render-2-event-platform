# RENDER 2.0

Full-stack event website for PAPNI School of Architecture.

## Run locally

```powershell
npm install
Copy-Item .env.example .env
npm start
```

Open http://localhost:3000.

Organizer login: username `organizer`; the password is `ADMIN_PASSWORD` from `.env` (the development default is `render-admin`).

## Host on Render

1. Push this folder to a GitHub repository.
2. In Render, choose **New > Blueprint** and select the repository.
3. Render detects `render.yaml`, creates the web service, and provisions a persistent disk for SQLite.
4. Enter a strong value for `ADMIN_PASSWORD` when Render prompts for the secret.
5. Open the generated Render URL.

The blueprint uses a Starter instance because persistent disks are not available on Render's free web service. For production traffic, replace the in-memory session store with a shared session store such as Redis.
