/* Voice/video calling (spec addendum Sections 17-19) - best-effort WebRTC,
   STUN-only signaling over Supabase Realtime broadcast (no TURN relay
   server exists in this stack, so a call between two networks that can't
   reach each other peer-to-peer will fail to connect; the failure state
   below surfaces the phone/WhatsApp fallback directly rather than leaving
   the user stuck). Microphone/camera are only ever requested via
   getUserMedia after the user explicitly starts or accepts a call - never
   activated silently.

   Signaling is entirely ephemeral broadcast messages on a channel named
   for the call's row id (`call:<id>`); nothing about the SDP/ICE exchange
   is ever persisted to the database, only the call's lifecycle
   (calling/ringing/answered/ended/...) is, via the `calls` table. */
window.App = window.App || {};

App.callingView = (function () {
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

  let pc = null;
  let localStream = null;
  let signalChannel = null;
  let callUpdatesChannel = null;
  let incomingCallsChannel = null;
  let currentCall = null; // the calls row
  let overlayEl = null;
  let micEnabled = true;
  let camEnabled = true;

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = App.utils.el(`
      <div id="callOverlay" style="display:none;position:fixed;inset:0;z-index:500;background:rgba(4,8,18,0.92);align-items:center;justify-content:center;flex-direction:column;color:var(--text)">
        <div id="callOverlayBody" style="text-align:center;max-width:360px"></div>
      </div>`);
    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  function showOverlay(html) {
    const el = ensureOverlay();
    App.utils.qs('#callOverlayBody', el).innerHTML = html;
    el.style.display = 'flex';
  }
  function hideOverlay() {
    if (overlayEl) overlayEl.style.display = 'none';
  }

  async function getMedia(callType) {
    return navigator.mediaDevices.getUserMedia({ audio: true, video: callType === 'VIDEO' });
  }

  function newPeerConnection(onIceCandidate) {
    const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    conn.onicecandidate = (e) => { if (e.candidate) onIceCandidate(e.candidate); };
    conn.ontrack = (e) => {
      let remoteAudio = App.utils.qs('#callRemoteAudio');
      if (!remoteAudio) {
        remoteAudio = document.createElement(e.track.kind === 'video' ? 'video' : 'audio');
        remoteAudio.id = 'callRemoteAudio';
        remoteAudio.autoplay = true;
        if (e.track.kind === 'video') { remoteAudio.style.cssText = 'width:100%;border-radius:10px;margin-top:10px'; App.utils.qs('#callOverlayBody')?.appendChild(remoteAudio); }
        document.body.appendChild(remoteAudio);
      }
      remoteAudio.srcObject = e.streams[0];
    };
    return conn;
  }

  function teardown(finalStatusLabel) {
    if (pc) { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    if (signalChannel) { App.api.unsubscribe(signalChannel); signalChannel = null; }
    if (callUpdatesChannel) { App.api.unsubscribe(callUpdatesChannel); callUpdatesChannel = null; }
    const remoteEl = App.utils.qs('#callRemoteAudio');
    if (remoteEl) remoteEl.remove();
    currentCall = null;
    if (finalStatusLabel) {
      showOverlay(`<div class="section-title" style="justify-content:center">${finalStatusLabel}</div><button class="btn btn-outline" id="callOverlayDismiss" style="margin-top:14px">Close</button>`);
      const btn = App.utils.qs('#callOverlayDismiss');
      if (btn) btn.addEventListener('click', hideOverlay);
    } else {
      hideOverlay();
    }
  }

  function fallbackHtml(contact, reason) {
    const phone = contact && contact._callPhone;
    return `
      <div class="section-title" style="justify-content:center">${reason}</div>
      <div class="hint">In-app calling needs both sides to reach each other directly over the internet - this can fail on some mobile networks or office firewalls (there's no relay server in this deployment). Try one of these instead:</div>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:12px">
        ${phone ? `<button class="btn btn-outline" onclick="window.location.href='tel:${phone}'">&#128222; Call</button>` : ''}
        ${phone ? `<button class="btn btn-outline" onclick="window.open('https://wa.me/${phone.replace('+', '')}','_blank')">&#128241; WhatsApp</button>` : ''}
      </div>
      <button class="btn btn-gold" id="callOverlayDismiss" style="margin-top:14px">Close</button>`;
  }

  // ---- Caller side ----
  async function startCall(receiverId, callType, conversationId, contact) {
    try {
      localStream = await getMedia(callType);
    } catch (e) {
      App.utils.toast('Microphone/camera permission is needed to place a call.', 'err');
      return;
    }
    let callRow;
    try {
      callRow = await App.api.initiateCall(receiverId, callType, conversationId);
    } catch (e) {
      localStream.getTracks().forEach((t) => t.stop());
      App.utils.toast('Could not start call: ' + (e.message || e), 'err');
      return;
    }
    currentCall = callRow;
    if (contact) currentCall._callPhone = contact._callPhone;

    showOverlay(`<div class="section-title" style="justify-content:center">Calling&hellip;</div><div class="hint">${callType === 'VIDEO' ? 'Video' : 'Voice'} call</div><button class="btn btn-danger" id="callCancelBtn" style="margin-top:14px">Cancel</button>`);
    App.utils.qs('#callCancelBtn').addEventListener('click', async () => {
      await App.api.updateCall(callRow.id, { status: 'ENDED', ended_at: new Date().toISOString() }).catch(() => {});
      teardown();
    });

    pc = newPeerConnection((candidate) => sendSignal({ kind: 'ice', candidate }));
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    signalChannel = App.api.callSignalChannel(callRow.id);
    signalChannel.on('broadcast', { event: 'signal' }, async (msg) => {
      const payload = msg.payload;
      if (payload.kind === 'ready') {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal({ kind: 'offer', sdp: offer });
      } else if (payload.kind === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      } else if (payload.kind === 'ice') {
        try { await pc.addIceCandidate(payload.candidate); } catch (e) { /* ignore late/duplicate candidates */ }
      }
    }).subscribe();

    function sendSignal(payload) {
      signalChannel.send({ type: 'broadcast', event: 'signal', payload });
    }

    callUpdatesChannel = App.api.subscribeToCallUpdates(callRow.id, (row) => {
      if (row.status === 'ANSWERED') {
        showOverlay(`<div class="section-title" style="justify-content:center">Connected</div><div class="hint">${callType === 'VIDEO' ? 'Video' : 'Voice'} call in progress</div>
          <div style="display:flex;gap:8px;justify-content:center;margin-top:14px">
            <button class="btn btn-outline" id="callMuteBtn">Mute</button>
            ${callType === 'VIDEO' ? '<button class="btn btn-outline" id="callCamBtn">Camera Off</button>' : ''}
            <button class="btn btn-danger" id="callEndBtn">End Call</button>
          </div>`);
        wireInCallButtons(row.id);
      } else if (['DECLINED', 'FAILED', 'MISSED', 'ENDED'].includes(row.status)) {
        teardown(row.status === 'DECLINED' ? 'Call declined' : row.status === 'ENDED' ? 'Call ended' : 'Call could not connect');
      }
    });

    // Failure fallback: if never connected within 25s, treat as failed.
    setTimeout(() => {
      if (currentCall && currentCall.id === callRow.id && (!pc || pc.connectionState !== 'connected')) {
        App.api.updateCall(callRow.id, { status: 'FAILED', ended_at: new Date().toISOString() }).catch(() => {});
        teardown(null);
        showOverlay(fallbackHtml(contact, 'No answer / could not connect'));
        wireDismiss();
      }
    }, 25000);
  }

  function wireDismiss() {
    const btn = App.utils.qs('#callOverlayDismiss');
    if (btn) btn.addEventListener('click', hideOverlay);
  }

  function wireInCallButtons(callId) {
    const muteBtn = App.utils.qs('#callMuteBtn');
    if (muteBtn) muteBtn.addEventListener('click', () => {
      micEnabled = !micEnabled;
      if (localStream) localStream.getAudioTracks().forEach((t) => { t.enabled = micEnabled; });
      muteBtn.textContent = micEnabled ? 'Mute' : 'Unmute';
    });
    const camBtn = App.utils.qs('#callCamBtn');
    if (camBtn) camBtn.addEventListener('click', () => {
      camEnabled = !camEnabled;
      if (localStream) localStream.getVideoTracks().forEach((t) => { t.enabled = camEnabled; });
      camBtn.textContent = camEnabled ? 'Camera Off' : 'Camera On';
    });
    App.utils.qs('#callEndBtn').addEventListener('click', async () => {
      const startedAt = currentCall ? new Date(currentCall.started_at) : new Date();
      const duration = Math.round((Date.now() - startedAt.getTime()) / 1000);
      await App.api.updateCall(callId, { status: 'ENDED', ended_at: new Date().toISOString(), duration }).catch(() => {});
      teardown();
    });
  }

  // ---- Receiver side ----
  async function showIncomingCallUI(callRow) {
    const callerName = (await App.api.getDisplayNames([callRow.caller_id]).catch(() => ({})))[callRow.caller_id] || 'Someone';
    showOverlay(`
      <div class="section-title" style="justify-content:center">Incoming ${callRow.call_type === 'VIDEO' ? 'video' : 'voice'} call</div>
      <div class="hint">${App.utils.escapeHtml(callerName)}</div>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:14px">
        <button class="btn btn-danger" id="callDeclineBtn">Decline</button>
        <button class="btn btn-teal" id="callAcceptBtn">Accept</button>
      </div>`);

    App.utils.qs('#callDeclineBtn').addEventListener('click', async () => {
      await App.api.updateCall(callRow.id, { status: 'DECLINED', ended_at: new Date().toISOString() }).catch(() => {});
      hideOverlay();
    });
    App.utils.qs('#callAcceptBtn').addEventListener('click', () => acceptCall(callRow));
  }

  async function acceptCall(callRow) {
    try {
      localStream = await getMedia(callRow.call_type);
    } catch (e) {
      App.utils.toast('Microphone/camera permission is needed to answer.', 'err');
      await App.api.updateCall(callRow.id, { status: 'DECLINED', ended_at: new Date().toISOString() }).catch(() => {});
      hideOverlay();
      return;
    }
    currentCall = callRow;
    showOverlay(`<div class="section-title" style="justify-content:center">Connecting&hellip;</div>`);

    pc = newPeerConnection((candidate) => sendSignal({ kind: 'ice', candidate }));
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    signalChannel = App.api.callSignalChannel(callRow.id);
    signalChannel.on('broadcast', { event: 'signal' }, async (msg) => {
      const payload = msg.payload;
      if (payload.kind === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({ kind: 'answer', sdp: answer });
        await App.api.updateCall(callRow.id, { status: 'ANSWERED', answered_at: new Date().toISOString() });
        showOverlay(`<div class="section-title" style="justify-content:center">Connected</div>
          <div style="display:flex;gap:8px;justify-content:center;margin-top:14px">
            <button class="btn btn-outline" id="callMuteBtn">Mute</button>
            ${callRow.call_type === 'VIDEO' ? '<button class="btn btn-outline" id="callCamBtn">Camera Off</button>' : ''}
            <button class="btn btn-danger" id="callEndBtn">End Call</button>
          </div>`);
        wireInCallButtons(callRow.id);
      } else if (payload.kind === 'ice') {
        try { await pc.addIceCandidate(payload.candidate); } catch (e) { /* ignore late/duplicate candidates */ }
      }
    }).subscribe();

    function sendSignal(payload) {
      signalChannel.send({ type: 'broadcast', event: 'signal', payload });
    }
    // Tell the caller we're ready so it (re)sends its offer - covers the
    // case where our subscription completed after the caller's first send.
    sendSignal({ kind: 'ready' });

    callUpdatesChannel = App.api.subscribeToCallUpdates(callRow.id, (row) => {
      if (['ENDED', 'FAILED'].includes(row.status)) teardown(row.status === 'ENDED' ? 'Call ended' : 'Call failed');
    });
  }

  // Called once at app startup (enterApp) - listens for calls where I'm the
  // receiver, same realtime-on-INSERT idiom as notifications.
  function listenForIncomingCalls() {
    if (incomingCallsChannel) App.api.unsubscribe(incomingCallsChannel);
    incomingCallsChannel = App.api.subscribeToIncomingCalls((row) => showIncomingCallUI(row));
    return incomingCallsChannel;
  }
  function stopListening() {
    if (incomingCallsChannel) { App.api.unsubscribe(incomingCallsChannel); incomingCallsChannel = null; }
  }

  return { startCall, listenForIncomingCalls, stopListening };
})();
