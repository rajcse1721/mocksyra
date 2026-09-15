# Mocksyra free deployment

Mocksyra uses Netlify for the static frontend, Render for the realtime schedule and shared workspace, and Supabase for login and durable state. Video calls open through an interviewer-provided Microsoft Teams or Zoom link, so no video API key is required. All three application services can start on their free plans.

## Updating an existing deployment

Deploy the backend before the frontend so the new schedule UI always talks to a compatible server.

1. In Supabase SQL Editor, export or safely copy the current state before migrating. Do not share the returned payload:

   ```sql
   select id, payload, updated_at
   from public.app_state
   where id = 'primary';
   ```

2. Run the complete current `supabase-schema.sql` file. It is safe to run again.
3. Temporarily lock or pause Netlify production publishing, then commit and push this version to the connected branch. This prevents Netlify from publishing the new frontend before Render is ready.
4. In Render, confirm `FRONTEND_ORIGIN`, `APP_URL`, and `SUPABASE_SECRET_KEY`, then deploy the latest commit. `FRONTEND_ORIGIN` must be `https://mocksyra.netlify.app` without a trailing slash. `DAILY_API_KEY` is no longer required and can be removed after any already-running legacy interview has finished.
5. Open `https://YOUR-RENDER-SERVICE.onrender.com/health`. For the intended hosted setup it should report all three values:

   ```json
   { "status": "ok", "persistence": "supabase", "video": "external-meeting-links" }
   ```

   Also check the Render logs. Do not continue if you see `Using local persistence` or `Supabase persistence failed`.
6. Unlock production publishing and deploy the latest commit in Netlify. Confirm that `runtime-config.js` still contains the Render HTTPS URL.
7. Sign out and back in once. Use two different accounts in separate browsers or incognito profiles to test Google login, publishing two different dates, cancelling only one offer, and booking a newly created session. From the interviewer account, paste a Teams or Zoom participant link. Confirm that the candidate sees the same link, that it opens in a new tab, and that the shared workspace remains connected on desktop and mobile.

The first backend start automatically migrates each future legacy availability time into an independent offer. Existing completed history is kept. Open offers and upcoming interviews are limited to four per account; cancelling one does not remove the others.

## 1. Prepare Supabase

1. Open Supabase Dashboard -> SQL Editor.
2. Run the complete `supabase-schema.sql` file.
   - For an existing deployment, run the complete file again. It is safe to rerun and updates the role constraint to Candidate or Interviewer only.
   - Existing profiles that used Peer Practice are moved to Candidate. Completed interview history is kept.
3. Open Project Settings -> API Keys and create or copy a server-side `sb_secret_...` key. A legacy `service_role` JWT also works, but the newer secret key is preferred.
4. Never place this secret in `supabase.js`, Git, Netlify, screenshots, or chat. It belongs only in Render's secret environment variables.
5. In Authentication -> URL Configuration, use the final Netlify origin as the Site URL and add the exact callback destination `https://YOUR-SITE.netlify.app/` as a redirect URL. Add a wildcard separately only for Netlify preview deployments.

### Enable Google sign-in

1. In Google Cloud Console, create an **OAuth client ID -> Web application**.
2. In Google Auth Platform -> **Data Access**, confirm the `openid`, email, and profile scopes are present. The profile scope supplies the account name and photo shown by Mocksyra.
3. Add your deployed site as an **Authorized JavaScript origin** (no trailing slash):

   ```text
   https://mocksyra.netlify.app
   ```

4. Add this exact Google **Authorized redirect URI**:

   ```text
   https://qjghjsapizkqktcbczgj.supabase.co/auth/v1/callback
   ```

5. If the Google consent screen is still in Testing, add every Google account that needs access as a test user. Otherwise publish the consent screen for production use.
6. In **Supabase Dashboard -> Authentication -> Providers -> Google**, enable Google and paste the Google client ID and client secret.
7. In **Supabase Dashboard -> Authentication -> URL Configuration**, set:
   - **Site URL:** `https://mocksyra.netlify.app`
   - **Redirect URLs:** add `https://mocksyra.netlify.app/`
8. If the Netlify site uses a different production domain, replace `https://mocksyra.netlify.app` in the Google JavaScript origin and both Supabase URL fields with that exact HTTPS origin. Add any Netlify preview domain separately before testing it.

Use the Supabase callback only as Google’s redirect URI. Use the Netlify origin as Google’s JavaScript origin and in Supabase URL Configuration. Keep the Google client secret only in Supabase; never add it to this repository or Netlify.

## 2. Deploy the Render backend

1. Push this directory to a private or public GitHub repository.
2. In Render, choose New -> Blueprint and select the repository. Render reads `render.yaml`.
3. Enter these environment values when prompted:
   - `FRONTEND_ORIGIN`: every exact frontend origin users will open, such as `https://mocksyra.netlify.app` (no trailing slash). Separate multiple origins with commas.
   - `APP_URL`: the same Netlify origin.
   - `SUPABASE_SECRET_KEY`: the `sb_secret_...` key copied directly from the same Supabase project configured in `supabase.js`.
4. Keep the service on the Free plan and deploy.
5. Copy the Render HTTPS URL, such as `https://mocksyra-realtime.onrender.com`.

When an existing backend starts with this version, legacy Peer Practice listings are removed and unfinished legacy peer sessions are closed. Completed history remains available.

Render's free web service can sleep after inactivity, so the first connection can take roughly a minute to wake. Active Socket.IO traffic keeps the schedule and shared interview workspace connected. Zoom or Teams carries the camera and microphone traffic separately.

If the Netlify site does not exist yet, initially use its temporary/future name, then correct `FRONTEND_ORIGIN` and `APP_URL` in Render after Netlify assigns the final URL.

## 3. Connect and deploy Netlify

1. Put the Render HTTPS URL in `runtime-config.js`:

   ```js
   window.MOCKSYRA_SOCKET_URL = 'https://YOUR-RENDER-SERVICE.onrender.com';
   ```

2. Commit and push the change.
3. In Netlify choose Add new site -> Import an existing project.
4. Build command: `npm run build:static` (also configured in `netlify.toml`).
5. Publish directory: `dist` (also configured in `netlify.toml`). This publishes only browser assets and keeps server source, tests, schema files, and deployment notes private.
6. Deploy. If Netlify assigned a different origin, update Render's `FRONTEND_ORIGIN` and `APP_URL`, Supabase Auth's Site URL and Redirect URLs, and Google's Authorized JavaScript origin. The Supabase project API URL itself does not change with the Netlify domain.

## 4. Optional match email

The server includes optional email delivery through Resend. Without it, notifications appear in Mocksyra Activity and as browser notifications while the browser is running.

To enable email, create these secret environment variables manually in Render:

- `RESEND_API_KEY`: your Resend API key.
- `EMAIL_FROM`: a verified sender such as `Mocksyra <alerts@your-domain.com>`.

Do not add either value to repository files. Redeploy the Render service after setting them.

## 5. Zoom and Microsoft Teams meetings

After an interview is booked, the interviewer opens the booking, creates a meeting in Zoom or Microsoft Teams, and pastes the participant join link into Mocksyra. The server accepts only secure links on official Zoom and Teams domains. The candidate cannot edit the link, and it never appears on the public sessions board.

Microsoft Teams Free is the recommended option for a 45-minute Mocksyra interview because its free meeting limit is 60 minutes. Zoom Basic is also supported, but its free meetings normally end after 40 minutes. Mocksyra intentionally does not create meetings automatically: Teams Free personal accounts do not support Graph-based meeting creation, while Zoom automation would require an additional Zoom authorization flow and would still keep the Basic plan's duration and concurrency limits.

At interview time, each participant selects **Join Zoom** or **Join Microsoft Teams**. The call opens in a new tab; keep Mocksyra open in the original tab for the timer, question, shared workspace, and feedback. Camera and microphone permissions are handled by Zoom or Teams rather than by Mocksyra.

## Local development

Leave `window.MOCKSYRA_SOCKET_URL` empty, run `npm start`, then open `http://localhost:3000`. The backend uses `data/mocksyra.json` locally when no server secret key is configured.
