import { useEffect, useRef, useState } from 'react';

function App() {
  const [isRunning, setIsRunning] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [audioContext, setAudioContext] = useState(null);
  const [analyser, setAnalyser] = useState(null);
  const wsRef = useRef(null);
  const canvasRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const mediaSourceRef = useRef(null);
  const sourceBufferRef = useRef(null);
  const audioElementRef = useRef(null);
  const audioDataRef = useRef([]);
  const messagesEndRef = useRef(null);
  const animationRef = useRef(null);
  const width = 400;
  const height = 400;

  // Store audio context and related variables in a ref to persist across renders
  const audioRef = useRef({
    audioContext: null,
    analyser: null,
    dataArray: null,
    baseRadius: 100,
    lastFrame: 0,
    fps: 30,
    hue1: 0,
    hue2: 180,
  });

  const getAverageVolume = () => {
    const { analyser, dataArray } = audioRef.current;
    if (!analyser || !dataArray) return 0;
    
    analyser.getByteFrequencyData(dataArray);
    
    const start = Math.floor(dataArray.length * 0.1);
    const end = Math.floor(dataArray.length * 0.7);
    
    let sum = 0;
    for (let i = start; i < end; i++) {
      sum += dataArray[i];
    }
    
    const average = sum / (end - start);
    setDebug(`Volume: ${average.toFixed(2)}`);
    return average;
  };

  const animate = (timestamp) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const { baseRadius, lastFrame, fps, hue1, hue2 } = audioRef.current;
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const twoPi = Math.PI * 2;
    const maxRadius = baseRadius + 100;

    if (timestamp - lastFrame > 1000/fps) {
      ctx.clearRect(
        centerX - maxRadius,
        centerY - maxRadius,
        maxRadius * 2,
        maxRadius * 2
      );
      
      const gradient = ctx.createLinearGradient(0, 0, 400, 300);
      gradient.addColorStop(0, `hsl(${audioRef.current.hue1}, 100%, 65%)`);
      gradient.addColorStop(0.5, `hsl(${(audioRef.current.hue1 + 90) % 360}, 100%, 60%)`);
      gradient.addColorStop(1, `hsl(${audioRef.current.hue2}, 100%, 65%)`);
      
      audioRef.current.hue1 = (audioRef.current.hue1 + 2) % 360;
      audioRef.current.hue2 = (audioRef.current.hue2 + 2) % 360;
      
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 400, 300);
      
      ctx.globalCompositeOperation = 'destination-in';
      
      let radius = baseRadius;
      if (audioRef.current.analyser) {
        const volume = getAverageVolume();
        radius = baseRadius + (volume / 128) * 100;
      }
      
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, twoPi);
      ctx.fill();
      
      ctx.globalCompositeOperation = 'source-over';
      
      audioRef.current.lastFrame = timestamp;
    }
    
    requestAnimationFrame(animate);
  };

  const initAudio = async () => {
    try {
      setIsInitializing(true);
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        } 
      });
      
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.3;
      
      source.connect(analyser);
      
      audioRef.current = {
        ...audioRef.current,
        audioContext,
        analyser,
        dataArray: new Uint8Array(analyser.frequencyBinCount),
      };
      
      setIsStarted(true);
      setDebug('Microphone active');
    } catch (err) {
      console.error('Error accessing microphone:', err);
      setDebug('Microphone error: ' + err.message);
      setIsInitializing(false);
    }
  };

  useEffect(() => {
    requestAnimationFrame(animate);
    return () => {
      // Cleanup audio context on unmount
      if (audioRef.current.audioContext) {
        audioRef.current.audioContext.close();
      }
    };
  }, []);

  function openWebSocketConnection() {
    const ws_url = 'ws://localhost:8000/listen';
    wsRef.current = new WebSocket(ws_url);
    wsRef.current.binaryType = 'arraybuffer';

    function handleAudioStream(streamData) {
      audioDataRef.current.push(new Uint8Array(streamData));
      if (sourceBufferRef.current && !sourceBufferRef.current.updating) {
        sourceBufferRef.current.appendBuffer(audioDataRef.current.shift());
      }
    }

    function handleJsonMessage(jsonData) {
      const message = JSON.parse(jsonData);
      console.log('Received message:', message);
      if (message.type === 'finish') {
        endConversation();
      } else {
        // If user interrupts while audio is playing, skip the audio currently playing
        if (message.type === 'transcript_final' && isAudioPlaying()) {
          skipCurrentAudio();
        }
        dispatch(message);
      }
    }
    
    wsRef.current.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        handleAudioStream(event.data);
      } else {
        handleJsonMessage(event.data);
      }
    };

    wsRef.current.onclose = () => {
      endConversation();
    }
  }

  function closeWebSocketConnection() {
    if (wsRef.current) {
      wsRef.current.close();
    }
  }

  async function startMicrophone() {

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      mediaRecorderRef.current.addEventListener('dataavailable', e => {
        if (e.data.size > 0 && wsRef.current.readyState == WebSocket.OPEN) {
          wsRef.current.send(e.data);
        }
      });
      mediaRecorderRef.current.start(250);
    } catch (err) {
      console.error("Error accessing the microphone", err);
    }
  }

  function stopMicrophone() {
    if (audioContext) {
      audioContext.close()
    }    

    if (mediaRecorderRef.current && mediaRecorderRef.current.stream) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
    }
  }

  function stopAudioPlayer() {
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      URL.revokeObjectURL(audioElementRef.current.src);
      audioElementRef.current = null;
    }

    if (mediaSourceRef.current) {
      if (sourceBufferRef.current) {
        mediaSourceRef.current.removeSourceBuffer(sourceBufferRef.current);
        sourceBufferRef.current = null;
      }
      mediaSourceRef.current = null;
    }

    audioDataRef.current = [];
  }

  async function startConversation() {
    // dispatch({ type: 'reset' });
    try {
      openWebSocketConnection();
      await startMicrophone();
      // startAudioPlayer();
      setIsRunning(true);
      setIsListening(true);
    } catch (err) {
      console.log('Error starting conversation:', err);
      endConversation();
    }
  }

  function endConversation() {
    closeWebSocketConnection();
    stopMicrophone();
    stopAudioPlayer();
    setIsRunning(false);
    setIsListening(false);
  }

  return (
    <div className="flex flex-col min-h-screen m-0">
      {/* Fixed Header */}
      <header className="fixed top-0 w-full z-50 p-4">
        <h1 className="text-3xl font-bold text-center text-gray-800">Voice Assistant with Deepgram</h1>
      </header>

      {/* Main Content */}
      <main className="flex-grow flex flex-col justify-center items-center mt-20 mb-16">
        <canvas ref={canvasRef} width="300" height="300" />
      </main>

      {/* Fixed Footer */}
      <footer className="fixed bottom-0 w-full z-50 p-4">
        <button
          className="w-full py-3 px-6 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors text-lg font-semibold"
          onClick={isRunning ? endConversation : startConversation}
        >
          {isRunning ? 'End conversation' : 'Start conversation'}
        </button>
      </footer>
    </div>
  )
}

export default App
