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

export class EchoLoopback {
  private pcLocal?: RTCPeerConnection;
  private pcRemote?: RTCPeerConnection;
  private audio?: HTMLAudioElement;

  /** Begin playing `stream` through the loopback. Safe to call once per session. */
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

    // A hidden <audio> element plays the looped-back stream. iOS is happier when the element
    // is in the DOM, and MediaStream (call-like) playback is exempt from autoplay gating.
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    audio.style.display = "none";
    document.body.appendChild(audio);
    this.audio = audio;

    pcRemote.ontrack = (e) => {
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void audio.play().catch(() => {
        /* autoplay may need a gesture; the call is started from a tap so this normally succeeds */
      });
    };

    for (const track of stream.getAudioTracks()) pcLocal.addTrack(track, stream);

    const offer = await pcLocal.createOffer();
    await pcLocal.setLocalDescription(offer);
    await pcRemote.setRemoteDescription(offer);
    const answer = await pcRemote.createAnswer();
    await pcRemote.setLocalDescription(answer);
    await pcLocal.setRemoteDescription(answer);
  }

  stop(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio.remove();
      this.audio = undefined;
    }
    this.pcLocal?.close();
    this.pcRemote?.close();
    this.pcLocal = undefined;
    this.pcRemote = undefined;
  }
}
