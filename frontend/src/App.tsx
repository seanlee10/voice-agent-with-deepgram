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
  const width = 300;
  const height = 300;

  // Store audio context and related variables in a ref to persist across renders
  const audioRef = useRef({
    audioContext: null,
    analyser: null,
    dataArray: null,
    baseRadius: 100,
    lastFrame: 0,
    fps: 30,
    hue1: 210,
    hue2: 240,
  });

  useEffect(() => {
    

    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      let audioCtx, analyserNode;

      audioCtx = new AudioContext();
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 1024;

      mediaRecorderRef.current = new MediaRecorder(stream);
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyserNode);
      mediaRecorderRef.current.addEventListener('dataavailable', e => {
        if (e.data.size > 0 && wsRef.current.readyState == WebSocket.OPEN) {
          wsRef.current.send(e.data);
        }
      });

      setAudioContext(audioCtx)
      setAnalyser(analyserNode);  
    });
    
  }, [])

  useEffect(() => {
    if (!analyser || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    let { baseRadius, lastFrame, fps, hue1, hue2 } = audioRef.current;
    const centerX = width / 2;
    const centerY = height / 2;
  
    function getVolume(audioData) {
      let normSamples = [...audioData].map(x => x / 128 - 1);
      let sum = 0;
      for (let i = 0; i < normSamples.length; i++) {
          sum += normSamples[i] * normSamples[i];
      }
      let volume = Math.sqrt(sum / normSamples.length);
      return volume * 240;
    }

    function drawCircle(audioData) {
      const volume = getVolume(audioData);
      ctx.clearRect(0, 0, width, height);
      const gradient = ctx.createLinearGradient(0, 0, width, height);

      // Increased lightness values for brighter colors
      gradient.addColorStop(0, `hsl(${hue1}, 100%, 65%)`);  // Lightness increased to 65%
      gradient.addColorStop(0.33, `hsl(${(hue1 + 15) % 360}, 100%, 60%)`);  // Lightness increased to 60%
      gradient.addColorStop(0.66, `hsl(${hue2}, 100%, 65%)`);  // Lightness increased to 65%
      
      // Update hues for next frame
      hue1 = (hue1 + 2) % 360;
      hue2 = (hue2 + 2) % 360;

      // Draw gradient background
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      // Apply circular mask
      ctx.globalCompositeOperation = 'destination-in';

      let radius = baseRadius;
      // Removed conditional to always apply volume effect
      // Map volume (0-255) to radius adjustment (0-50)
      const radiusAdjustment = (volume / 255) * 50;
      radius = baseRadius + radiusAdjustment;

      // Draw circle in the center
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.fill();
      
      // Reset composite operation
      ctx.globalCompositeOperation = 'source-over';

      requestAnimationFrame(animate);
    }

    function animate(timestamp) {
      if (!analyser) return;
      const audioData = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(audioData);

      if (timestamp - lastFrame > 1000/fps) {
        drawCircle(audioData);
        lastFrame = timestamp;
      }

      animationRef.current = requestAnimationFrame(animate);
    }

    animate();

    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [analyser])

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
        // dispatch(message);
      }
    }

    function handleAudioChunk(base64Chunk) {
      // Convert base64 to binary
      const binaryChunk = atob(base64Chunk);
      const bytes = new Uint8Array(binaryChunk.length);
      for (let i = 0; i < binaryChunk.length; i++) {
          bytes[i] = binaryChunk.charCodeAt(i);
      }
      
      // Add chunk to stack
      audioDataRef.current.push(bytes);
      if (sourceBufferRef.current && !sourceBufferRef.current.updating) {
        sourceBufferRef.current.appendBuffer(audioDataRef.current.shift());
      }
  }
    
    wsRef.current.onmessage = (event) => {
      const data = JSON.parse(event.data); 
      if (event.data instanceof ArrayBuffer) {        
        handleAudioStream(event.data);
      } else if (['audio_start', 'audio_chunk'].includes(data.type)) {
        handleAudioChunk(data.chunk)
      } else {
        handleJsonMessage(event.data);
      }
    };

    wsRef.current.onclose = () => {
      endConversation();
      console.log('onclose')
    }
  }

  function closeWebSocketConnection() {
    if (wsRef.current) {
      wsRef.current.close();
    }
  }

  async function startMicrophone() {
    try {
      mediaRecorderRef.current.start(250);
    } catch (err) {
      console.error("Error accessing the microphone", err);
    }
  }

  function stopMicrophone() {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      // mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
    }
  }

  function startAudioPlayer() {
    // Initialize MediaSource and event listeners
    mediaSourceRef.current = getMediaSource();
    if (!mediaSourceRef.current) {
      return;
    }
    
    mediaSourceRef.current.addEventListener('sourceopen', () => {
      if (!MediaSource.isTypeSupported('audio/mpeg')) return;
      
      sourceBufferRef.current = mediaSourceRef.current.addSourceBuffer('audio/mpeg');
      sourceBufferRef.current.addEventListener('updateend', () => {
        if (audioDataRef.current.length > 0 && !sourceBufferRef.current.updating) {
          sourceBufferRef.current.appendBuffer(audioDataRef.current.shift());
        }
      });
    });

    // Initialize Audio Element
    const audioUrl = URL.createObjectURL(mediaSourceRef.current);
    audioElementRef.current = new Audio(audioUrl);
    const playPromise = audioElementRef.current.play();
  }

  function isAudioPlaying() {
    return audioElementRef.current.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA;
  }

  function skipCurrentAudio() {
    audioDataRef.current = [];
    const buffered = sourceBufferRef.current.buffered;
    if (buffered.length > 0) {
      if (sourceBufferRef.current.updating) {
        sourceBufferRef.current.abort();
      }
      audioElementRef.current.currentTime = buffered.end(buffered.length - 1);
    }
  }

  function stopAudioPlayer() {
    if (audioElementRef.current) {
      console.log('2')
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
      startAudioPlayer();
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
      {/* Main Content */}
      <main className="flex-grow flex flex-col justify-center items-center mt-20 mb-16">
        <canvas ref={canvasRef} width="300" height="300" />
      </main>

      {/* Fixed Footer */}
      <footer className="fixed bottom-0 w-full z-50 p-4">
        <button
          className={`w-full py-3 px-6 ${isRunning ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-500 hover:bg-blue-600'} text-white rounded-lg transition-colors text-lg font-semibold`}
          onClick={isRunning ? endConversation : startConversation}
        >
          {isRunning ? 'End conversation' : 'Start conversation'}
        </button>
      </footer>
    </div>
  )
}

function getMediaSource() {
  if ('MediaSource' in window) {
    return new MediaSource();
  } else if ('ManagedMediaSource' in window) {
    // Use ManagedMediaSource if available in iPhone
    return new ManagedMediaSource();
  } else {
    console.log('No MediaSource API available');
    return null;
  }
}

export default App
