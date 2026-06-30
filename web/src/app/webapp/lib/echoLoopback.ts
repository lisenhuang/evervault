// Plays a MediaStream through a local WebRTC loopback so the browser's acoustic echo
// canceller treats it as the far-end reference and subtracts it from the mic.
//
// Why this exists: the model's voice is generated via the Web Audio API. On iOS/WebKit the
// system echo canceller only references audio that travels the WebRTC *playout* path, so
// Web Audio output is never cancelled — its sound leaks into the open mic, Gemini's VAD hears
// it as speech, and the model interrupts itself. Routing the same audio through a local
// RTCPeerConnection → RTCPeerConnection loop and playing the *remote* side puts it on that
// playout path, so the (hardware) echo canceller removes it. No DSP, and the mic stays fully
// open so real barge-in still works. Desktop browsers already cancel Web Audio output, so this
// is a harmless no-op there.
//
// iOS specifics (the reason this used to be silent on iPhone):
//   - A MediaStream element only autoplays with sound while the page is *already capturing*
//     (getUserMedia). The caller must therefore start the mic BEFORE calling start().
//   - iOS plays audio-only remote streams reliably through a <video> element, not <audio>.
//   - The element must stay in the render tree (no display:none), so it's parked off-screen.
// start() resolves only once playback has actually begun, and rejects otherwise, so the caller
// can fall back to plain speaker output instead of leaving the user in silence.

export class EchoLoopback {
  private pcLocal?: RTCPeerConnection;
  private pcRemote?: RTCPeerConnection;
  private el?: HTMLVideoElement;

  /** Begin playing `stream` through the loopback. Resolves once audio is playing; rejects if it can't start. */
  async start(stream: MediaStream): Promise<void> {
    const pcLocal = new RTCPeerConnection();
    const pcRemote = new RTCPeerConnection();
    this.pcLocal = pcLocal;
    this.pcRemote = pcRemote;

    pcLocal.onicecandidate = (e) => {
      if (e.candidate) void pcRemote.addIceCandidate(e.candidate);
    };
    pcRemote.onicecandidate = (e) => {
      if (e.candidate) void pcLocal.addIceCandidate(e.candidate);
    };

    // A <video> element plays the looped-back stream (more reliable than <audio> for audio-only
    // remote streams on iOS). Parked off-screen but kept in the render tree so iOS will play it.
    const el = document.createElement("video");
    el.autoplay = true;
    el.muted = false;
    el.setAttribute("playsinline", "");
    el.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0;";
    document.body.appendChild(el);
    this.el = el;

    const playing = new Promise<void>((resolve, reject) => {
      pcRemote.ontrack = (e) => {
        el.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        el.play().then(resolve, reject);
      };
      // Safety: a local loopback fires ontrack within a few ms, so anything past this is a failure.
      setTimeout(() => reject(new Error("loopback playback did not start")), 4000);
    });

    for (const track of stream.getAudioTracks()) pcLocal.addTrack(track, stream);

    const offer = await pcLocal.createOffer();
    await pcLocal.setLocalDescription(offer);
    await pcRemote.setRemoteDescription(offer);
    const answer = await pcRemote.createAnswer();
    await pcRemote.setLocalDescription(answer);
    await pcLocal.setRemoteDescription(answer);

    await playing;
  }

  stop(): void {
    if (this.el) {
      this.el.pause();
      this.el.srcObject = null;
      this.el.remove();
      this.el = undefined;
    }
    this.pcLocal?.close();
    this.pcRemote?.close();
    this.pcLocal = undefined;
    this.pcRemote = undefined;
  }
}
