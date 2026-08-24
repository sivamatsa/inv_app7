/* Pre-login "Need Help?" modal (Login/Sign-Up screen). Deliberately a small,
   separate module from the logged-in "Get Help" tab in support.js - only a
   handful of categories make sense before anyone has signed in (there's no
   "my portfolio"/"my suggestions" yet), and submissions here go through
   fn_submit_guest_ticket (034_help_support_suggestions.sql) rather than the
   normal authenticated ticket-creation path, since there's no auth.uid() to
   own the row. See that migration's own header comment for why this is a
   guarded SECURITY DEFINER function rather than a raw anon table insert. */
window.App = window.App || {};

(function () {
  function openGuestTicketForm(category, prefillAccountEmail) {
    const needsAccountEmail = category === 'Forgot Password';
    const fields = [
      { key: 'guest_name', label: 'Your Name', required: true },
      { key: 'guest_email', label: 'Your Email (we will reply here)', required: true, type: 'email' },
      ...(needsAccountEmail ? [{ key: 'account_email', label: 'Account Email (the one you are locked out of, if different)', type: 'email', value: prefillAccountEmail || '' }] : []),
      { key: 'guest_message', label: 'Describe the problem', type: 'textarea', rows: 5, required: true, span: 2 },
    ];
    App.ui.open({
      title: category,
      bodyHtml: App.ui.renderForm(fields) + '<div class="auth-error" id="guestTicketError"></div>',
      actions: [
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        { label: 'Submit Request', className: 'btn-gold', onClick: async () => {
          const { values, errors } = App.ui.readForm(fields);
          if (errors.length) { App.utils.qs('#guestTicketError').textContent = 'Name, email, and a description are all required.'; return; }
          try {
            const ticketNumber = await App.api.submitGuestTicket(category, values.guest_name, values.guest_email, values.guest_message, values.account_email || null);
            App.ui.close();
            App.ui.open({
              title: 'Request Submitted',
              bodyHtml: `<div class="hint">Your request has been sent to our team. Reference number:</div>
                <div style="font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:700;color:var(--gold);margin:10px 0">${App.utils.escapeHtml(ticketNumber)}</div>
                <div class="hint">We'll reply to ${App.utils.escapeHtml(values.guest_email)} directly - this request isn't tied to an account, so there's nowhere to log back in and check on it.</div>`,
              actions: [{ label: 'Close', className: 'btn-gold', onClick: App.ui.close }],
            });
          } catch (e) { App.utils.qs('#guestTicketError').textContent = e.message || String(e); }
        } },
      ],
    });
  }

  function openForgotPasswordFlow() {
    const fields = [{ key: 'email', label: 'Your Account Email', required: true, type: 'email', span: 2 }];
    App.ui.open({
      title: 'Forgot Password',
      bodyHtml: App.ui.renderForm(fields)
        + '<div class="hint" style="margin-top:6px">We\'ll send a secure reset link to this email - the preferred, fastest way back in.</div>'
        + '<div class="auth-error" id="forgotPwError"></div>',
      actions: [
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        { label: 'Send Password Reset Link', className: 'btn-gold', onClick: async () => {
          const { values, errors } = App.ui.readForm(fields);
          if (errors.length) { App.utils.qs('#forgotPwError').textContent = 'Enter your account email.'; return; }
          try {
            await App.auth.requestPasswordReset(values.email);
            App.ui.close();
            App.ui.open({
              title: 'Check Your Email',
              bodyHtml: `<div class="hint">If an account exists for ${App.utils.escapeHtml(values.email)}, a password reset link is on its way. Click the link in that email to set a new password.</div>
                <div class="hint" style="margin-top:10px">Didn't get it, or still can't get back in?</div>`,
              actions: [
                { label: "I still can't get in", className: 'btn-outline', onClick: () => { App.ui.close(); openGuestTicketForm('Forgot Password', values.email); } },
                { label: 'Close', className: 'btn-gold', onClick: App.ui.close },
              ],
            });
          } catch (e) { App.utils.qs('#forgotPwError').textContent = e.message || String(e); }
        } },
      ],
    });
  }

  function openNeedHelpModal() {
    const options = [
      { key: 'account-creation', icon: '🆕', label: 'Cannot create account', action: () => openGuestTicketForm('Cannot Create Account') },
      { key: 'forgot-password', icon: '🔐', label: 'Forgot password', action: openForgotPasswordFlow },
      { key: 'email-verify', icon: '📧', label: 'Email verification issue', action: () => openGuestTicketForm('Cannot Create Account') },
      { key: 'contact-admin', icon: '📩', label: 'Contact administrator', action: () => openGuestTicketForm('Contact Administrator') },
      { key: 'demo', icon: '▶', label: 'Just want to explore? Try Demo Mode - no signup needed', action: () => { App.ui.close(); App.utils.qs('#tryDemoBtn').click(); } },
    ];
    App.ui.open({
      title: '🤖 Need Help?',
      bodyHtml: `<div class="card-row" style="flex-direction:column;gap:8px">
        ${options.map((o) => `<div class="integration-card" data-help-option="${o.key}" style="cursor:pointer;text-align:left;display:flex;align-items:center;gap:10px">
          <span style="font-size:18px">${o.icon}</span><span class="name" style="font-size:13px">${o.label}</span>
        </div>`).join('')}
      </div>`,
      actions: [{ label: 'Close', className: 'btn-outline', onClick: App.ui.close }],
      onMount: (body) => {
        App.utils.qsa('[data-help-option]', body).forEach((el) => el.addEventListener('click', () => {
          const opt = options.find((o) => o.key === el.dataset.helpOption);
          App.ui.close();
          opt.action();
        }));
      },
    });
  }

  App.needHelp = { openNeedHelpModal };
})();
