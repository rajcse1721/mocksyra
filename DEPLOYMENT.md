# Mocksyra free deployment

Mocksyra uses Netlify for the static frontend, Render for the Socket.IO/WebRTC signaling server, and Supabase for login and durable state. All three can start on their free plans.

## 1. Prepare Supabase

1. Open Supabase Dashboard -> SQL Editor.
2. Run the complete `supabase-schema.sql` file.
3. Open Project Settings -> API Keys and create or copy a server-side `sb_secret_...` key. A legacy `service_role` JWT also works, but the newer secret key is preferred.
4. Never place this secret in `supabase.js`, Git, Netlify, screenshots, or chat. It belongs only in Render's secret environment variables.
5. In Authentication -> URL Configuration, add the final Netlify URL as the Site URL and add `https://YOUR-SITE.netlify.app/**` as a redirect URL.

## 2. Deploy the Render backend

1. Push this directory to a private or public GitHub repository.
2. In Render, choose New -> Blueprint and select the repository. Render reads `render.yaml`.
3. Enter these environment values when prompted:
   - `FRONTEND_ORIGIN`: the Netlify origin, such as `https://mocksyra.netlify.app` (no trailing slash).
   - `APP_URL`: the same Netlify origin.
   - `SUPABASE_SECRET_KEY`: the `sb_secret_...` key copied directly from Supabase.
4. Keep the service on the Free plan and deploy.
5. Copy the Render HTTPS URL, such as `https://mocksyra-realtime.onrender.com`.

If the Netlify site does not exist yet, initially use its temporary/future name, then correct `FRONTEND_ORIGIN` and `APP_URL` in Render after Netlify assigns the final URL.

## 3. Connect and deploy Netlify

1. Put the Render HTTPS URL in `runtime-config.js`:

   ```js
   window.MOCKSYRA_SOCKET_URL = 'https://YOUR-RENDER-SERVICE.onrender.com';
   ```

2. Commit and push the change.
3. In Netlify choose Add new site -> Import an existing project.
4. Build command: leave empty.
5. Publish directory: `.`
6. Deploy, then update the Render and Supabase URLs if Netlify assigned a different origin.

## 4. Optional match email

The server includes optional email delivery through Resend. Without it, notifications appear in Mocksyra Activity and as browser notifications while the browser is running.

To enable email, create these secret environment variables manually in Render:

- `RESEND_API_KEY`: your Resend API key.
- `EMAIL_FROM`: a verified sender such as `Mocksyra <alerts@your-domain.com>`.

Do not add either value to repository files. Redeploy the Render service after setting them.

## Local development

Leave `window.MOCKSYRA_SOCKET_URL` empty, run `npm start`, then open `http://localhost:3000`. The backend uses `data/mocksyra.json` locally when no server secret key is configured.
