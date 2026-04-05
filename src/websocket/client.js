class WSClient {
  constructor(sessionId) {
    this.sessionId = sessionId;
    // Hardcoded URL since process.env is unavailable in renderer
    this.url = `ws://localhost:3001?session=${sessionId}&role=candidate`;
    this.ws = null;
    this.connect();
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('Connected to Truveil backend');
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'session_ended') {
          if (window.truveil) window.truveil.endSession();
        }
      } catch (err) {}
    };

    this.ws.onclose = () => {
      console.log('Disconnected from backend');
      setTimeout(() => this.connect(), 3000);
    };
  }

  sendFlag(flagData) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'flag',
        data: flagData,
        timestamp: Date.now()
      }));
    }
  }

  sendAudio(buffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Mock sending audio
    }
  }
}

window.WSClient = WSClient;

