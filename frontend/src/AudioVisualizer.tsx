import { useEffect, useRef, useState } from 'react';

const AudioVisualizer = () => {
  const canvasRef = useRef(null);
  const [debug, setDebug] = useState('');
  const [isStarted, setIsStarted] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);

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

  return (
    <canvas ref={canvasRef} width="200" height="200" />
  );
};

export default AudioVisualizer;
