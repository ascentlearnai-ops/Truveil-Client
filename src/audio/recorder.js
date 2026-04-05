class MicRecorder {
  constructor(wsClient) {
    this.ws = wsClient;
    this.mediaRecorder = null;
    this.stream = null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm;codecs=opus' });

    const chunks = [];

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    this.mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      blob.arrayBuffer().then(buf => {
        // Mock sending audio
      });
      chunks.length = 0;
    };

    // 5-second chunks
    this.mediaRecorder.start();
    setInterval(() => {
      if (this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.stop();
        this.mediaRecorder.start();
      }
    }, 5000);
  }

  stop() {
    this.mediaRecorder?.stop();
    this.stream?.getTracks().forEach(t => t.stop());
  }
}

window.MicRecorder = MicRecorder;

