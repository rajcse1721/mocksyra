# Mocksyra free deployment

Mocksyra uses Netlify for the static frontend, Render for the Socket.IO/WebRTC signaling server, and Supabase for login and durable state. All three can start on their free plans.

## 1. Prepare Supabase

1. Open Supabase Dashboard -> SQL Editor.
2. Run the complete `supabase-schema.sql` file.
   - For an existing deployment, run the complete file again. It is safe to rerun and updates the role constraint to Candidate or Interviewer only.
   - Existing profiles that used Peer Practice are moved to Candidate. Completed interview history is kept.
3. Open Project Settings -> API Keys and create or copy a server-side `sb_secret_...` key. A legacy `service_role` JWT also works, but the newer secret key is preferred.
4. Never place this secret in `supabase.js`, Git, Netlify, screenshots, or chat. It belongs only in Render's secret environment variables.
5. In Authentication -> URL Configuration, add the final Netlify URL as the Site URL and add `https://YOUR-SITE.netlify.app/**` as a redirect URL.

### Enable Google sign-in

1. In Google Cloud Console, create an **OAuth client ID -> Web application**.
2. Add your deployed site as an **Authorized JavaScript origin** (no trailing slash):

   ```text
   https://mocksyra.netlify.app
   ```

3. Add this exact Google **Authorized redirect URI**:

   ```text
   https://qjghjsapizkqktcbczgj.supabase.co/auth/v1/callback
   ```

4. If the Google consent screen is still in Testing, add every Google account that needs access as a test user. Otherwise publish the consent screen for production use.
5. In **Supabase Dashboard -> Authentication -> Providers -> Google**, enable Google and paste the Google client ID and client secret.
6. In **Supabase Dashboard -> Authentication -> URL Configuration**, set:
   - **Site URL:** `https://mocksyra.netlify.app`
   - **Redirect URLs:** add `https://mocksyra.netlify.app/`
7. If the Netlify site uses a different production domain, replace `https://mocksyra.netlify.app` in the Google JavaScript origin and both Supabase URL fields with that exact HTTPS origin. Add any Netlify preview domain separately before testing it.

Use the Supabase callback only as Google’s redirect URI. Use the Netlify origin as Google’s JavaScript origin and in Supabase URL Configuration. Keep the Google client secret only in Supabase; never add it to this repository or Netlify.

## 2. Deploy the Render backend

1. Push this directory to a private or public GitHub repository.
2. In Render, choose New -> Blueprint and select the repository. Render reads `render.yaml`.
3. Enter these environment values when prompted:
   - `FRONTEND_ORIGIN`: the Netlify origin, such as `https://mocksyra.netlify.app` (no trailing slash).
   - `APP_URL`: the same Netlify origin.
   - `SUPABASE_SECRET_KEY`: the `sb_secret_...` key copied directly from Supabase.
4. Keep the service on the Free plan and deploy.
5. Copy the Render HTTPS URL, such as `https://mocksyra-realtime.onrender.com`.

When an existing backend starts with this version, legacy Peer Practice listings are removed and unfinished legacy peer sessions are closed. Completed history remains available.

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

## 5. Hosted Daily video

Mocksyra automatically uses Daily Prebuilt for newly booked sessions when `DAILY_API_KEY` is configured. Create an API key in the Daily dashboard, add it to Render as a secret environment variable named `DAILY_API_KEY`, and redeploy the backend. Never add this key to Netlify, `runtime-config.js`, Git, screenshots, or client-side code.

The backend creates private two-person rooms only when an authenticated participant enters the join window. Rooms and participant tokens expire automatically. Existing matches keep the video provider selected when they were created; local development without a Daily key uses the direct WebRTC fallback.

## Local development

Leave `window.MOCKSYRA_SOCKET_URL` empty, run `npm start`, then open `http://localhost:3000`. The backend uses `data/mocksyra.json` locally when no server secret key is configured.
