window.renderAuthPage = function () {
  const app = document.querySelector('#app');
  app.innerHTML = '<div class="app-shell"><main class="app-main"><div class="shell auth-shell"><button class="back" id="auth-back">← BACK TO HOME</button><section class="panel auth-panel"><div class="eyebrow"><span></span> YOUR MOCKSYRA ACCOUNT</div><h1 class="page-title">Practice follows you.</h1><p class="page-subtitle">Create an account to save your preferences, receive match notifications, and return from any device.</p><button class="google-button" id="google-sign-in" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.35 12.18c0-.72-.06-1.25-.19-1.8H12v3.38h5.37c-.11.84-.72 2.1-2.08 2.95l-.02.11 3.02 2.29.21.02c1.92-1.73 2.85-4.28 2.85-6.95Z"/><path fill="#34A853" d="M12 21.5c2.63 0 4.84-.85 6.45-2.32l-3.07-2.42c-.82.56-1.92.95-3.38.95a5.84 5.84 0 0 1-5.53-3.94l-.1.01-3.14 2.38-.03.1A9.7 9.7 0 0 0 12 21.5Z"/><path fill="#FBBC05" d="M6.47 13.77A5.78 5.78 0 0 1 6.16 12c0-.62.11-1.22.3-1.77v-.12L3.29 7.69l-.1.05A9.35 9.35 0 0 0 2.5 12c0 1.53.37 2.98.69 4.26l3.28-2.49Z"/><path fill="#EA4335" d="M12 6.29c1.84 0 3.08.78 3.79 1.43l2.77-2.66C16.83 3.47 14.63 2.5 12 2.5a9.7 9.7 0 0 0-8.81 5.24l3.27 2.49A5.86 5.86 0 0 1 12 6.29Z"/></svg>Continue with Google</button><div class="auth-divider"><span>or continue with email</span></div><div class="choices auth-tabs"><button class="choice selected" id="sign-in-tab">Sign in</button><button class="choice" id="sign-up-tab">Create account</button></div><label class="field-label">EMAIL</label><input class="textarea auth-input" id="auth-email" type="email" autocomplete="email" placeholder="you@example.com"><label class="field-label">PASSWORD</label><input class="textarea auth-input" id="auth-password" type="password" autocomplete="current-password" placeholder="At least 6 characters"><p class="hint auth-message" id="auth-message" role="status"></p><div class="form-actions"><span class="hint">Your email is used for match alerts.</span><button class="button" id="auth-submit">Sign in <b>→</b></button></div></section></div></main></div>';
  let mode = 'signin';
  const message = text => app.querySelector('#auth-message').textContent = text;
  const setMode = next => { mode = next; app.querySelector('#sign-in-tab').classList.toggle('selected', next === 'signin'); app.querySelector('#sign-up-tab').classList.toggle('selected', next === 'signup'); app.querySelector('#auth-submit').innerHTML = (next === 'signup' ? 'Create account' : 'Sign in') + ' <b>→</b>'; };
  app.querySelector('#sign-in-tab').onclick = () => setMode('signin');
  app.querySelector('#sign-up-tab').onclick = () => setMode('signup');
  app.querySelector('#auth-back').onclick = () => location.hash = 'home';
  app.querySelector('#google-sign-in').onclick = async () => {
    const button = app.querySelector('#google-sign-in');
    button.disabled = true; message('Opening Google…');
    const { error } = await window.peerSupabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${location.origin}${location.pathname}#onboarding` } });
    if (error) { button.disabled = false; message(error.message); }
  };
  app.querySelector('#auth-submit').onclick = async () => {
    const email = app.querySelector('#auth-email').value.trim().toLowerCase(), password = app.querySelector('#auth-password').value;
    if (!email || password.length < 6) return message('Enter a valid email and a password of at least 6 characters.');
    const action = mode === 'signup' ? window.peerSupabase.auth.signUp({ email, password }) : window.peerSupabase.auth.signInWithPassword({ email, password });
    const result = await action;
    if (result.error) return message(result.error.message);
    message(mode === 'signup' && !result.data.session ? 'Check your email to confirm your account, then sign in.' : 'Signed in. Redirecting…');
    if (result.data.session) {
      localStorage.setItem('mocksyra-email', email);
      window.connectMocksyraSocket?.();
      setTimeout(() => window.navigateMocksyra?.('onboarding'), 400);
    }
  };
};
