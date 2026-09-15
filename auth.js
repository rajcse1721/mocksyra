(() => {
  const EMAIL_KEY = 'mocksyra-email';
  const initialUrl = new URL(window.location.href);
  const initialHash = initialUrl.hash;
  const initialHashParams = new URLSearchParams(initialHash.replace(/^#/, ''));
  const returnedFromAuth = initialUrl.searchParams.has('code') || /(?:^#|[&#])(?:access_token|refresh_token)=/.test(initialHash);
  const callbackError = initialUrl.searchParams.get('error_description') || initialHashParams.get('error_description') || initialUrl.searchParams.get('error') || initialHashParams.get('error');
  let pendingError = callbackError ? 'Google sign-in was cancelled or could not be completed. Please try again.' : '';

  const authReturnUrl = () => `${window.location.origin}${window.location.pathname}`;

  function openMarketplace() {
    window.history.replaceState({}, '', `${window.location.pathname}#marketplace`);
    if (typeof window.navigateMocksyra === 'function') window.navigateMocksyra('marketplace');
  }

  function storeSession(session, source) {
    const email = session?.user?.email;
    if (!email) {
      if (source === 'SIGNED_OUT' || source === 'RESTORED') localStorage.removeItem(EMAIL_KEY);
      return;
    }
    localStorage.setItem(EMAIL_KEY, email);
    const entryRoute = ['', '#home', '#auth'].includes(window.location.hash);
    if (returnedFromAuth || ((source === 'INITIAL_SESSION' || source === 'RESTORED') && entryRoute)) openMarketplace();
  }

  if (pendingError) window.history.replaceState({}, '', `${window.location.pathname}#auth`);

  window.peerSupabase.auth.onAuthStateChange((event, session) => {
    storeSession(session, event);
  });

  window.peerSupabase.auth.getSession()
    .then(({ data, error }) => {
      if (error) throw error;
      storeSession(data.session, 'RESTORED');
    })
    .catch(() => {
      if (returnedFromAuth) pendingError = 'We could not finish signing you in. Please try again.';
    });

  function friendlyError(error, action) {
    const value = String(error?.message || error || '').toLowerCase();
    if (value.includes('invalid login credentials')) return 'Email or password is incorrect.';
    if (value.includes('email not confirmed')) return 'Confirm your email first, then sign in.';
    if (value.includes('already registered') || value.includes('already exists')) return 'An account already exists for this email. Sign in instead.';
    if (value.includes('password')) return 'Use a password with at least 6 characters.';
    if (value.includes('rate') || value.includes('too many')) return 'Too many attempts. Wait a moment and try again.';
    if (value.includes('provider') && value.includes('enabled')) return 'Google sign-in is not configured yet.';
    if (value.includes('fetch') || value.includes('network')) return 'We could not connect. Check your internet and try again.';
    return action === 'google' ? 'Google sign-in could not start. Please try again.' : 'We could not sign you in. Please try again.';
  }

  window.renderAuthPage = function () {
    const app = document.querySelector('#app');
    app.innerHTML = `<div class="app-shell"><main class="app-main"><div class="shell auth-shell">
      <button class="back" id="auth-back" type="button">Back</button>
      <section class="panel auth-panel" aria-labelledby="auth-title">
        <h1 class="page-title" id="auth-title">Sign in</h1>
        <p class="page-subtitle" id="auth-subtitle">Continue with Google or use your email.</p>
        <button class="google-button" id="google-sign-in" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.35 12.18c0-.72-.06-1.25-.19-1.8H12v3.38h5.37c-.11.84-.72 2.1-2.08 2.95l-.02.11 3.02 2.29.21.02c1.92-1.73 2.85-4.28 2.85-6.95Z"/><path fill="#34A853" d="M12 21.5c2.63 0 4.84-.85 6.45-2.32l-3.07-2.42c-.82.56-1.92.95-3.38.95a5.84 5.84 0 0 1-5.53-3.94l-.1.01-3.14 2.38-.03.1A9.7 9.7 0 0 0 12 21.5Z"/><path fill="#FBBC05" d="M6.47 13.77A5.78 5.78 0 0 1 6.16 12c0-.62.11-1.22.3-1.77v-.12L3.29 7.69l-.1.05A9.35 9.35 0 0 0 2.5 12c0 1.53.37 2.98.69 4.26l3.28-2.49Z"/><path fill="#EA4335" d="M12 6.29c1.84 0 3.08.78 3.79 1.43l2.77-2.66C16.83 3.47 14.63 2.5 12 2.5a9.7 9.7 0 0 0-8.81 5.24l3.27 2.49A5.86 5.86 0 0 1 12 6.29Z"/></svg>
          Continue with Google
        </button>
        <div class="auth-divider"><span>or</span></div>
        <form id="auth-form" novalidate>
          <label class="field-label" for="auth-email">Email</label>
          <input class="textarea auth-input" id="auth-email" type="email" autocomplete="email" inputmode="email" required placeholder="you@example.com">
          <label class="field-label" for="auth-password">Password</label>
          <input class="textarea auth-input" id="auth-password" type="password" autocomplete="current-password" minlength="6" required placeholder="At least 6 characters">
          <p class="hint auth-message" id="auth-message" role="status" aria-live="polite"></p>
          <button class="button full" id="auth-submit" type="submit">Sign in</button>
          <p class="auth-switch">New to Mocksyra? <button class="text-button" id="sign-up-tab" type="button">Create an account</button></p>
        </form>
      </section>
    </div></main></div>`;

    let mode = 'signin';
    const form = app.querySelector('#auth-form');
    const title = app.querySelector('#auth-title');
    const subtitle = app.querySelector('#auth-subtitle');
    const password = app.querySelector('#auth-password');
    const submit = app.querySelector('#auth-submit');
    const toggle = app.querySelector('#sign-up-tab');
    const google = app.querySelector('#google-sign-in');
    const message = text => {
      const element = app.querySelector('#auth-message');
      if (element) element.textContent = text;
    };

    const setMode = next => {
      mode = next;
      const signingUp = mode === 'signup';
      title.textContent = signingUp ? 'Create your account' : 'Sign in';
      subtitle.textContent = signingUp ? 'Use Google or create an account with email.' : 'Continue with Google or use your email.';
      password.autocomplete = signingUp ? 'new-password' : 'current-password';
      submit.textContent = signingUp ? 'Create account' : 'Sign in';
      toggle.id = signingUp ? 'sign-in-tab' : 'sign-up-tab';
      toggle.textContent = signingUp ? 'Sign in instead' : 'Create an account';
      toggle.parentElement.firstChild.textContent = signingUp ? 'Already have an account? ' : 'New to Mocksyra? ';
      message('');
    };

    toggle.onclick = () => setMode(mode === 'signin' ? 'signup' : 'signin');
    app.querySelector('#auth-back').onclick = () => { window.location.hash = 'home'; };

    google.onclick = async () => {
      google.disabled = true;
      message('Opening Google…');
      try {
        const { error } = await window.peerSupabase.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo: authReturnUrl() }
        });
        if (error) throw error;
      } catch (error) {
        google.disabled = false;
        message(friendlyError(error, 'google'));
      }
    };

    form.onsubmit = async event => {
      event.preventDefault();
      const emailField = app.querySelector('#auth-email');
      const email = emailField.value.trim().toLowerCase();
      const passwordValue = password.value;
      if (!email || !emailField.validity.valid) return message('Enter a valid email address.');
      if (passwordValue.length < 6) return message('Use a password with at least 6 characters.');

      submit.disabled = true;
      toggle.disabled = true;
      message(mode === 'signup' ? 'Creating your account…' : 'Signing you in…');
      try {
        const result = mode === 'signup'
          ? await window.peerSupabase.auth.signUp({ email, password: passwordValue, options: { emailRedirectTo: authReturnUrl() } })
          : await window.peerSupabase.auth.signInWithPassword({ email, password: passwordValue });
        if (result.error) throw result.error;
        if (mode === 'signup' && !result.data.session) {
          setMode('signin');
          message('Check your email and confirm your account. Then you can sign in.');
          return;
        }
        localStorage.setItem(EMAIL_KEY, result.data.session.user.email || email);
        message('Signed in. Opening sessions…');
        window.connectMocksyraSocket?.();
        openMarketplace();
      } catch (error) {
        message(friendlyError(error, mode));
      } finally {
        if (document.body.contains(submit)) {
          submit.disabled = false;
          toggle.disabled = false;
        }
      }
    };

    if (pendingError) {
      message(pendingError);
      pendingError = '';
    }
  };
})();
