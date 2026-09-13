window.renderAuthPage = function () {
  const app = document.querySelector('#app');
  app.innerHTML = '<div class="app-shell"><main class="app-main"><div class="shell"><button class="back" id="auth-back">← BACK TO HOME</button><div class="progress"><i class="done"></i><i></i><i></i><i></i></div><section class="panel" style="max-width:560px;margin:20px auto"><div class="eyebrow"><span></span> YOUR MOCKSYRA ACCOUNT</div><h1 class="page-title">Practice follows you.</h1><p class="page-subtitle">Create an account to save your preferences, receive match notifications, and return from any device.</p><div class="choices" style="margin-top:28px"><button class="choice selected" id="sign-in-tab">Sign in</button><button class="choice" id="sign-up-tab">Create account</button></div><label class="field-label">EMAIL</label><input class="textarea" style="height:45px" id="auth-email" type="email" autocomplete="email" placeholder="you@example.com"><label class="field-label">PASSWORD</label><input class="textarea" style="height:45px" id="auth-password" type="password" autocomplete="current-password" placeholder="At least 6 characters"><p class="hint" id="auth-message" style="margin-top:17px"></p><div class="form-actions"><span class="hint">Your email is used for match alerts.</span><button class="button" id="auth-submit">Sign in <b>→</b></button></div></section></div></main></div>';
  let mode = 'signin';
  const message = text => app.querySelector('#auth-message').textContent = text;
  const setMode = next => { mode = next; app.querySelector('#sign-in-tab').classList.toggle('selected', next === 'signin'); app.querySelector('#sign-up-tab').classList.toggle('selected', next === 'signup'); app.querySelector('#auth-submit').innerHTML = (next === 'signup' ? 'Create account' : 'Sign in') + ' <b>→</b>'; };
  app.querySelector('#sign-in-tab').onclick = () => setMode('signin');
  app.querySelector('#sign-up-tab').onclick = () => setMode('signup');
  app.querySelector('#auth-back').onclick = () => location.hash = 'home';
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
      setTimeout(() => location.hash = 'onboarding', 400);
    }
  };
};
